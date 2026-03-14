package ai.openclaw.wear.gateway

import android.content.Context
import android.os.Build
import android.util.Log
import ai.openclaw.wear.R
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
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

private const val TAG = "WearGateway"

/**
 * Gateway event from the server, forwarded to the chat controller.
 */
data class GatewayEvent(val event: String, val payloadJson: String?)

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
class WearGatewayClient(private val context: Context) : GatewayClientInterface {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<String>>()
  private val httpClient =
    OkHttpClient.Builder()
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .pingInterval(30, TimeUnit.SECONDS)
      .build()

  private var ws: WebSocket? = null
  private var config: WearGatewayConfig = WearGatewayConfig()
  private var reconnectJob: Job? = null
  private var deviceId: String = UUID.randomUUID().toString()
  private var connectNonceDeferred: CompletableDeferred<String>? = null
  private var connectionEpoch = 0L

  private val _connected = MutableStateFlow(false)
  override val connected: StateFlow<Boolean> = _connected.asStateFlow()

  private val _statusText = MutableStateFlow(context.getString(R.string.wear_status_offline))
  override val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 64)
  override val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

  fun configure(config: WearGatewayConfig) {
    this.config = config
  }

  fun connect() {
    disconnect()
    if (!config.isValid) {
      _statusText.value = context.getString(R.string.wear_status_no_gateway_configured)
      return
    }
    _statusText.value = context.getString(R.string.wear_status_connecting)
    doConnect()
  }

  fun disconnect() {
    reconnectJob?.cancel()
    reconnectJob = null
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
    httpClient.dispatcher.executorService.shutdown()
    httpClient.connectionPool.evictAll()
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
    val request = Request.Builder().url(url).build()
    connectNonceDeferred = CompletableDeferred()
    val epoch = connectionEpoch + 1
    connectionEpoch = epoch

    ws = httpClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.i(TAG, "WebSocket open, waiting for connect.challenge…")
        // Wait for the connect.challenge nonce, then send connect
        scope.launch {
          try {
            val nonce = withTimeoutOrNull(5_000) { connectNonceDeferred?.await() } ?: ""
            sendConnect(webSocket, nonce, epoch)
          } catch (e: Throwable) {
            Log.w(TAG, "Connect handshake failed: ${e.message}")
            handleDisconnect("Connect handshake failed", epoch)
          }
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleMessage(text)
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

  private fun sendConnect(socket: WebSocket, nonce: String, epoch: Long) {
    val connectParams = buildJsonObject {
      put("minProtocol", JsonPrimitive(3))
      put("maxProtocol", JsonPrimitive(3))
      put("role", JsonPrimitive("operator"))
      put("client", buildJsonObject {
        put("id", JsonPrimitive(deviceId))
        put("version", JsonPrimitive("1.0.0"))
        put("platform", JsonPrimitive("wearos"))
        put("mode", JsonPrimitive("operator"))
        put("displayName", JsonPrimitive("${Build.MANUFACTURER} ${Build.MODEL} (Wear OS)"))
        put("deviceFamily", JsonPrimitive("watch"))
      })
      if (config.token.isNotBlank()) {
        put("auth", buildJsonObject {
          put("token", JsonPrimitive(config.token))
        })
      } else if (config.password.isNotBlank()) {
        put("auth", buildJsonObject {
          put("password", JsonPrimitive(config.password))
        })
      }
    }

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
          _connected.value = true
          _statusText.value = context.getString(R.string.wear_status_connected)
          // Extract mainSessionKey from connect response
          val resultObj = try { json.parseToJsonElement(result) as? JsonObject } catch (_: Throwable) { null }
          val snapshot = (resultObj?.get("snapshot") as? JsonObject)
          val sessionDefaults = (snapshot?.get("sessionDefaults") as? JsonObject)
          val mainSessionKey = (sessionDefaults?.get("mainSessionKey") as? JsonPrimitive)?.content
          if (mainSessionKey != null) {
            _events.tryEmit(GatewayEvent("mainSessionKey", mainSessionKey))
          }
        } else {
          handleDisconnect("Connect timed out", epoch)
        }
      } catch (e: Throwable) {
        handleDisconnect("Connect failed: ${e.message}", epoch)
      }
    }
  }

  private fun handleMessage(text: String) {
    try {
      val root = json.parseToJsonElement(text)
      if (root !is JsonObject) return

      when ((root["type"] as? JsonPrimitive)?.content) {
        "res" -> handleResponse(root)
        "event" -> handleEvent(root)
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
      pendingRequests.remove(id)?.completeExceptionally(Exception("$code: $message"))
    }
  }

  private fun handleEvent(frame: JsonObject) {
    val event = (frame["event"] as? JsonPrimitive)?.content ?: return
    val payloadJson = frame["payload"]?.let { if (it is JsonNull) null else it.toString() }
      ?: (frame["payloadJSON"] as? JsonPrimitive)?.content

    // Handle connect.challenge — provides nonce for connect handshake
    if (event == "connect.challenge") {
      val payloadObj = payloadJson?.let { try { json.parseToJsonElement(it) as? JsonObject } catch (_: Throwable) { null } }
      val nonce = (payloadObj?.get("nonce") as? JsonPrimitive)?.content
      if (nonce != null) {
        connectNonceDeferred?.complete(nonce)
      }
      return
    }

    _events.tryEmit(GatewayEvent(event, payloadJson))
  }

  private fun handleDisconnect(message: String, epoch: Long) {
    if (epoch != connectionEpoch) return
    _connected.value = false
    _statusText.value = message
    ws = null
    pendingRequests.values.forEach { it.completeExceptionally(Exception(message)) }
    pendingRequests.clear()

    // Auto-reconnect
    reconnectJob?.cancel()
    reconnectJob = scope.launch {
      delay(3000)
      if (epoch == connectionEpoch && !_connected.value && config.isValid) {
        Log.i(TAG, "Attempting reconnect…")
        _statusText.value = context.getString(R.string.wear_status_reconnecting)
        doConnect()
      }
    }
  }
}
