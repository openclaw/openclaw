package ai.openclaw.wear.gateway

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import ai.openclaw.android.gateway.GatewayClientProfiles
import ai.openclaw.android.gateway.GatewayConnectBuilder
import ai.openclaw.android.gateway.GatewayDeviceAuthPayload
import ai.openclaw.android.gateway.GatewayDeviceIdentityStore
import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.GatewayEventQueue
import ai.openclaw.android.gateway.asArrayOrNull
import ai.openclaw.android.gateway.asObjectOrNull
import ai.openclaw.android.gateway.asStringOrNull
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import ai.openclaw.wear.R

private const val TAG = "WearGateway"

internal class GatewayRpcException(
  val code: String,
  override val message: String,
  val detailCode: String? = null,
  val recommendedNextStep: String? = null,
) : Exception(message)

internal fun isCurrentSocketFrame(
  frameEpoch: Long,
  currentEpoch: Long,
  activeSocket: WebSocket?,
  sourceSocket: WebSocket,
): Boolean {
  return frameEpoch == currentEpoch && activeSocket === sourceSocket
}

internal fun shouldPauseReconnectAfterConnectFailure(error: Throwable): Boolean {
  val rpcError = error as? GatewayRpcException ?: return false
  val code = rpcError.detailCode ?: rpcError.code
  return when {
    rpcError.recommendedNextStep == "update_auth_configuration" -> true
    rpcError.recommendedNextStep == "update_auth_credentials" -> true
    rpcError.recommendedNextStep == "review_auth_configuration" -> true
    rpcError.recommendedNextStep == "wait_then_retry" -> true
    code == "AUTH_REQUIRED" -> true
    code == "AUTH_UNAUTHORIZED" -> true
    code == "AUTH_TOKEN_MISSING" -> true
    code == "AUTH_TOKEN_MISMATCH" -> true
    code == "AUTH_TOKEN_NOT_CONFIGURED" -> true
    code == "AUTH_BOOTSTRAP_TOKEN_INVALID" -> true
    code == "AUTH_PASSWORD_MISSING" -> true
    code == "AUTH_PASSWORD_MISMATCH" -> true
    code == "AUTH_PASSWORD_NOT_CONFIGURED" -> true
    code == "AUTH_RATE_LIMITED" -> true
    code == "PAIRING_REQUIRED" -> true
    code == "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" -> true
    code == "DEVICE_IDENTITY_REQUIRED" -> true
    code == "DEVICE_AUTH_INVALID" -> true
    code == "DEVICE_AUTH_DEVICE_ID_MISMATCH" -> true
    code == "DEVICE_AUTH_SIGNATURE_EXPIRED" -> true
    code == "DEVICE_AUTH_NONCE_REQUIRED" -> true
    code == "DEVICE_AUTH_NONCE_MISMATCH" -> true
    code == "DEVICE_AUTH_SIGNATURE_INVALID" -> true
    code == "DEVICE_AUTH_PUBLIC_KEY_INVALID" -> true
    else -> false
  }
}

/**
 * Common interface so the chat controller can work with both
 * direct WebSocket and phone-proxied connections.
 */
interface GatewayClientInterface {
  val connected: StateFlow<Boolean>
  val statusText: StateFlow<String>
  val events: SharedFlow<GatewayEvent>
  suspend fun request(method: String, paramsJson: String?, timeoutMs: Long = 15_000): String
}

/**
 * Direct WebSocket gateway client using the real gateway protocol
 * (type: req/res/event framing with connect.challenge nonce).
 */
class WearGatewayClient internal constructor(
  private val context: Context,
  private val tlsPinStore: WearGatewayTlsPinStore = SharedPrefsWearGatewayTlsPinStore(context.applicationContext),
  private val persistConfig: (WearGatewayConfig) -> Unit =
    WearGatewayConfigStore(context.applicationContext)::save,
) : GatewayClientInterface {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<String>>()
  private val identityStore = GatewayDeviceIdentityStore(context.applicationContext)

  private var ws: WebSocket? = null
  private var config: WearGatewayConfig = WearGatewayConfig()
  private var httpClient = buildHttpClient()
  private var reconnectJob: Job? = null
  private var deviceId: String = UUID.randomUUID().toString()
  @Volatile private var reconnectPausedForAuthFailure = false
  @Volatile private var connectionEpoch = 0L

  private val _connected = MutableStateFlow(false)
  override val connected: StateFlow<Boolean> = _connected.asStateFlow()

  private val _statusText = MutableStateFlow(context.getString(R.string.wear_status_offline))
  override val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val eventQueue = GatewayEventQueue(scope = scope, json = json, logTag = TAG)
  override val events: SharedFlow<GatewayEvent> = eventQueue.events

  fun configure(config: WearGatewayConfig) {
    this.config = config
  }

  fun connect() {
    disconnect()
    reconnectPausedForAuthFailure = false
    if (!config.isValid) {
      _statusText.value = context.getString(R.string.wear_status_no_gateway_configured)
      return
    }
    replaceHttpClient()
    _statusText.value = context.getString(R.string.wear_status_connecting)
    doConnect()
  }

  fun disconnect() {
    reconnectJob?.cancel()
    reconnectJob = null
    reconnectPausedForAuthFailure = false
    connectionEpoch += 1
    val socket = ws
    ws = null
    socket?.close(1000, "bye")
    _connected.value = false
    _statusText.value = context.getString(R.string.wear_status_offline)
    pendingRequests.values.forEach { it.completeExceptionally(Exception("Disconnected")) }
    pendingRequests.clear()
  }

  fun shutdown() {
    disconnect()
    closeHttpClient(httpClient)
  }

  override suspend fun request(method: String, paramsJson: String?, timeoutMs: Long): String {
    val socket = ws ?: throw Exception("Not connected")
    val id = UUID.randomUUID().toString()
    val deferred = CompletableDeferred<String>()
    pendingRequests[id] = deferred

    val msg = buildJsonObject {
      put("type", JsonPrimitive("req"))
      put("id", JsonPrimitive(id))
      put("method", JsonPrimitive(method))
      if (paramsJson != null) {
        put("params", json.parseToJsonElement(paramsJson))
      }
    }
    socket.send(msg.toString())

    return try {
      withTimeoutOrNull(timeoutMs) { deferred.await() }
        ?: throw Exception("Request timed out: $method")
    } finally {
      pendingRequests.remove(id)
    }
  }

  private fun doConnect() {
    val url = config.wsUrl()
    val request =
      try {
        Request.Builder().url(url).build()
      } catch (_: IllegalArgumentException) {
        _connected.value = false
        _statusText.value = context.getString(R.string.wear_status_failed, "invalid gateway URL")
        return
      }
    val epoch = connectionEpoch + 1
    connectionEpoch = epoch
    val nonceDeferred = CompletableDeferred<String>()

    ws = httpClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.i(TAG, "WebSocket open, waiting for connect.challenge…")
        // Wait for the connect.challenge nonce, then send connect
        scope.launch {
          try {
            val nonce = withTimeoutOrNull(5_000) { nonceDeferred.await() }
            if (nonce == null) {
              Log.w(TAG, "connect.challenge not received within timeout; proceeding anyway")
            }
            sendConnect(webSocket, epoch, nonce)
          } catch (e: Throwable) {
            Log.w(TAG, "Connect handshake failed: ${e.message}")
            handleDisconnect("Connect handshake failed", epoch)
          }
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (!isCurrentSocketFrame(epoch, connectionEpoch, ws, webSocket)) {
          return
        }
        handleMessage(text, nonceDeferred)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "WebSocket failure: ${t.message}")
        handleDisconnect("Connection failed: ${t.message}", epoch)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.i(TAG, "WebSocket closed: $code $reason")
        handleDisconnect("Disconnected", epoch)
      }
    })
  }

  private fun sendConnect(socket: WebSocket, epoch: Long, connectNonce: String?) {
    val versionName = resolveWearVersionName(context)
    val connectParams =
      buildWearConnectParams(
        config = config,
        deviceId = deviceId,
        versionName = versionName,
        signedDeviceIdentity = buildSignedDeviceIdentity(connectNonce, versionName),
      )

    val msg = buildJsonObject {
      put("type", JsonPrimitive("req"))
      put("id", JsonPrimitive(UUID.randomUUID().toString()))
      put("method", JsonPrimitive("connect"))
      put("params", connectParams)
    }

    val idStr = (msg["id"] as JsonPrimitive).content
    val deferred = CompletableDeferred<String>()
    pendingRequests[idStr] = deferred

    socket.send(msg.toString())

    // Handle the connect response
    scope.launch {
      try {
        val result = withTimeoutOrNull(12_000) { deferred.await() }
        if (result != null) {
          if (epoch != connectionEpoch || ws !== socket) {
            return@launch
          }
          _connected.value = true
          _statusText.value = context.getString(R.string.wear_status_connected)
          persistIssuedWearDeviceToken(result)
          // Extract mainSessionKey from connect response
          val resultObj = try { json.parseToJsonElement(result) as? JsonObject } catch (_: Throwable) { null }
          val snapshot = (resultObj?.get("snapshot") as? JsonObject)
          val sessionDefaults = (snapshot?.get("sessionDefaults") as? JsonObject)
          val mainSessionKey = (sessionDefaults?.get("mainSessionKey") as? JsonPrimitive)?.content
          if (mainSessionKey != null) {
            eventQueue.emit("mainSessionKey", mainSessionKey)
          }
        } else {
          handleDisconnect("Connect timed out", epoch)
        }
      } catch (e: Throwable) {
        handleDisconnect(
          message = "Connect failed: ${e.message}",
          epoch = epoch,
          shouldReconnect = !shouldPauseReconnectAfterConnectFailure(e),
        )
      } finally {
        pendingRequests.remove(idStr)
      }
    }
  }

  private fun handleMessage(text: String, nonceDeferred: CompletableDeferred<String>) {
    try {
      val root = json.parseToJsonElement(text)
      if (root !is JsonObject) return

      when ((root["type"] as? JsonPrimitive)?.content) {
        "res" -> handleResponse(root)
        "event" -> handleEvent(root, nonceDeferred)
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to parse message: ${e.message}")
    }
  }

  private fun handleResponse(frame: JsonObject) {
    val id = (frame["id"] as? JsonPrimitive)?.content ?: return
    val ok = (frame["ok"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
    if (ok) {
      val payload = frame["payload"]
      pendingRequests.remove(id)?.complete(payload?.toString() ?: "{}")
    } else {
      val error = frame["error"] as? JsonObject
      val code = (error?.get("code") as? JsonPrimitive)?.content ?: "UNKNOWN"
      val message = (error?.get("message") as? JsonPrimitive)?.content ?: "Request failed"
      val details = error?.get("details") as? JsonObject
      val detailCode = (details?.get("code") as? JsonPrimitive)?.content?.trim()?.ifEmpty { null }
      val recommendedNextStep =
        (details?.get("recommendedNextStep") as? JsonPrimitive)?.content?.trim()?.ifEmpty { null }
      pendingRequests.remove(id)?.completeExceptionally(
        GatewayRpcException(
          code = code,
          message = "$code: $message",
          detailCode = detailCode,
          recommendedNextStep = recommendedNextStep,
        ),
      )
    }
  }

  private fun handleEvent(frame: JsonObject, nonceDeferred: CompletableDeferred<String>) {
    val event = (frame["event"] as? JsonPrimitive)?.content ?: return
    val payloadJson = frame["payload"]?.let { if (it is JsonNull) null else it.toString() }
      ?: (frame["payloadJSON"] as? JsonPrimitive)?.content

    // Handle connect.challenge — provides nonce for connect handshake
    if (event == "connect.challenge") {
      val payloadObj = payloadJson?.let { try { json.parseToJsonElement(it) as? JsonObject } catch (_: Throwable) { null } }
      val nonce = (payloadObj?.get("nonce") as? JsonPrimitive)?.content
      if (nonce != null) {
        nonceDeferred.complete(nonce)
      }
      return
    }

    eventQueue.emit(event, payloadJson)
  }

  private fun handleDisconnect(message: String, epoch: Long, shouldReconnect: Boolean = true) {
    if (epoch != connectionEpoch) return
    if (!shouldReconnect) {
      reconnectPausedForAuthFailure = true
    }
    _connected.value = false
    _statusText.value = message
    ws = null
    pendingRequests.values.forEach { it.completeExceptionally(Exception(message)) }
    pendingRequests.clear()

    // Auto-reconnect only for failures that can plausibly self-heal.
    reconnectJob?.cancel()
    if (!shouldReconnect || reconnectPausedForAuthFailure) {
      reconnectJob = null
      return
    }
    reconnectJob = scope.launch {
      delay(3000)
      if (epoch == connectionEpoch && !_connected.value && config.isValid) {
        Log.i(TAG, "Attempting reconnect…")
        _statusText.value = context.getString(R.string.wear_status_reconnecting)
        doConnect()
      }
    }
  }

  private fun buildHttpClient(): OkHttpClient {
    val builder =
      OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
    val tlsParams = resolveWearGatewayTlsParams(config, tlsPinStore)
    if (tlsParams != null) {
      val tlsConfig =
        buildWearGatewayTlsConfig(
          params = tlsParams,
          onStore = { fingerprint ->
            tlsPinStore.save(tlsParams.stableId, fingerprint)
          },
        )
      builder.sslSocketFactory(tlsConfig.sslSocketFactory, tlsConfig.trustManager)
      builder.hostnameVerifier(tlsConfig.hostnameVerifier)
    }
    return builder.build()
  }

  private fun replaceHttpClient() {
    val previous = httpClient
    httpClient = buildHttpClient()
    closeHttpClient(previous)
  }

  private fun closeHttpClient(client: OkHttpClient) {
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
  }

  private fun buildSignedDeviceIdentity(connectNonce: String?, versionName: String): WearSignedDeviceIdentity? {
    val nonce = connectNonce?.trim().orEmpty()
    if (nonce.isEmpty()) return null

    val identity = identityStore.loadOrCreate()
    val clientInfo = GatewayConnectBuilder.buildWearClientInfo(deviceId = deviceId, versionName = versionName)
    val signedAtMs = System.currentTimeMillis()
    val signatureToken =
      config.token.trim().takeIf { it.isNotEmpty() }
        ?: config.bootstrapToken.trim().takeIf { it.isNotEmpty() }
    val payload =
      GatewayDeviceAuthPayload.buildV3(
        deviceId = identity.deviceId,
        clientId = clientInfo.id,
        clientMode = clientInfo.mode,
        role = "operator",
        scopes = GatewayConnectBuilder.OperatorScopes,
        signedAtMs = signedAtMs,
        token = signatureToken,
        nonce = nonce,
        platform = clientInfo.platform,
        deviceFamily = clientInfo.deviceFamily,
      )
    val signature = identityStore.signPayload(payload, identity) ?: return null
    val publicKey = identityStore.publicKeyBase64Url(identity) ?: return null
    return WearSignedDeviceIdentity(
      deviceId = identity.deviceId,
      publicKeyBase64Url = publicKey,
      signatureBase64Url = signature,
      signedAtMs = signedAtMs,
      nonce = nonce,
    )
  }

  private fun persistIssuedWearDeviceToken(connectPayloadJson: String) {
    val nextConfig = applyIssuedWearDeviceToken(config, connectPayloadJson) ?: return
    persistConfig(nextConfig)
    config = nextConfig
  }
}

internal data class WearSignedDeviceIdentity(
  val deviceId: String,
  val publicKeyBase64Url: String,
  val signatureBase64Url: String,
  val signedAtMs: Long,
  val nonce: String,
)

internal fun buildWearConnectParams(
  config: WearGatewayConfig,
  deviceId: String,
  versionName: String = "dev",
  signedDeviceIdentity: WearSignedDeviceIdentity? = null,
): JsonObject {
  val authJson =
    when {
      config.token.isNotBlank() ->
        buildJsonObject {
          put("token", JsonPrimitive(config.token))
        }
      config.bootstrapToken.isNotBlank() ->
        buildJsonObject {
          put("bootstrapToken", JsonPrimitive(config.bootstrapToken))
        }
      config.password.isNotBlank() ->
        buildJsonObject {
          put("password", JsonPrimitive(config.password))
        }
      else -> null
    }
  return GatewayConnectBuilder.buildConnectParamsJson(
    options =
      GatewayConnectBuilder.buildWearOperatorConnectOptions(
        deviceId = deviceId,
        versionName = versionName,
      ),
    authJson = authJson,
    deviceJson =
      signedDeviceIdentity?.let { identity ->
        buildJsonObject {
          put("id", JsonPrimitive(identity.deviceId))
          put("publicKey", JsonPrimitive(identity.publicKeyBase64Url))
          put("signature", JsonPrimitive(identity.signatureBase64Url))
          put("signedAt", JsonPrimitive(identity.signedAtMs))
          put("nonce", JsonPrimitive(identity.nonce))
        }
      },
  )
}

internal fun applyIssuedWearDeviceToken(
  config: WearGatewayConfig,
  connectPayloadJson: String,
  json: Json = Json { ignoreUnknownKeys = true },
): WearGatewayConfig? {
  val deviceToken = extractIssuedWearDeviceToken(connectPayloadJson, json) ?: return null
  val nextConfig = config.copy(token = deviceToken, bootstrapToken = "")
  return nextConfig.takeUnless { it == config }
}

internal fun extractIssuedWearDeviceToken(
  connectPayloadJson: String,
  json: Json = Json { ignoreUnknownKeys = true },
): String? {
  val payload = runCatching { json.parseToJsonElement(connectPayloadJson) }.getOrNull()?.asObjectOrNull() ?: return null
  val auth = payload["auth"].asObjectOrNull() ?: return null
  val authRole = auth["role"].asStringOrNull()?.trim()?.ifEmpty { null }
  val directDeviceToken = auth["deviceToken"].asStringOrNull()?.trim()?.ifEmpty { null }
  if (directDeviceToken != null && (authRole == null || authRole == "operator")) {
    return directDeviceToken
  }
  return auth["deviceTokens"].asArrayOrNull()
    ?.mapNotNull { it.asObjectOrNull() }
    ?.firstNotNullOfOrNull { tokenEntry ->
      val role = tokenEntry["role"].asStringOrNull()?.trim()
      val deviceToken = tokenEntry["deviceToken"].asStringOrNull()?.trim()?.ifEmpty { null }
      if (role == "operator") deviceToken else null
    }
}

internal fun resolveWearVersionName(context: Context): String {
  return GatewayClientProfiles.resolveVersionName(
    rawVersionName = runCatching { context.packageManager.readPackageVersionName(context.packageName) }.getOrNull(),
    debug = context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0,
  )
}

private fun PackageManager.readPackageVersionName(packageName: String): String? {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0)).versionName
  } else {
    @Suppress("DEPRECATION")
    getPackageInfo(packageName, 0).versionName
  }
}
