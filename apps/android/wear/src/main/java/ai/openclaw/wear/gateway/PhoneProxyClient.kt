package ai.openclaw.wear.gateway

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.NodeClient
import com.google.android.gms.wearable.Wearable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import ai.openclaw.wear.R

private const val TAG = "PhoneProxy"
private const val RPC_PATH = "/openclaw/rpc"
private const val RPC_RESPONSE_PATH = "/openclaw/rpc-response"
private const val EVENT_PATH = "/openclaw/event"
private const val PING_PATH = "/openclaw/ping"
private const val PONG_PATH = "/openclaw/pong"
private const val MESSAGE_SEND_TIMEOUT_MS = 5_000L
private const val PHONE_PONG_TIMEOUT_MS = 5_000L

/**
 * Gateway client that routes all requests through the phone app
 * via Wear OS Data Layer MessageClient.
 */
class PhoneProxyClient(private val context: Context) : GatewayClientInterface, MessageClient.OnMessageReceivedListener {
  private data class ProxyHandshake(
    val ready: Boolean,
    val statusText: String?,
  )

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val messageClient: MessageClient = Wearable.getMessageClient(context)
  private val nodeClient: NodeClient = Wearable.getNodeClient(context)
  private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<String>>()

  private var phoneNodeId: String? = null
  private var reconnectJob: Job? = null

  private val _connected = MutableStateFlow(false)
  override val connected: StateFlow<Boolean> = _connected.asStateFlow()

  private val _statusText = MutableStateFlow(context.getString(R.string.wear_status_phone_proxy_offline))
  override val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 64)
  override val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

  fun connect() {
    messageClient.addListener(this)
    reconnectJob?.cancel()
    _statusText.value = context.getString(R.string.wear_status_finding_phone)
    scope.launch {
      findPhoneAndPing()
    }
  }

  fun disconnect() {
    messageClient.removeListener(this)
    reconnectJob?.cancel()
    reconnectJob = null
    phoneNodeId = null
    _connected.value = false
    _statusText.value = context.getString(R.string.wear_status_phone_proxy_offline)
    pendingRequests.values.forEach { it.completeExceptionally(Exception("Disconnected")) }
    pendingRequests.clear()
  }

  override suspend fun request(method: String, paramsJson: String?, timeoutMs: Long): String {
    val nodeId = phoneNodeId ?: throw Exception("Phone not connected")
    val id = UUID.randomUUID().toString()
    val deferred = CompletableDeferred<String>()
    pendingRequests[id] = deferred

    val msg = buildJsonObject {
      put("id", JsonPrimitive(id))
      put("method", JsonPrimitive(method))
      if (paramsJson != null) {
        put("params", json.parseToJsonElement(paramsJson))
      }
    }
    sendMessageWithTimeout(
      nodeId = nodeId,
      path = RPC_PATH,
      data = msg.toString().toByteArray(Charsets.UTF_8),
      timeoutMs = MESSAGE_SEND_TIMEOUT_MS,
    )

    return try {
      withTimeoutOrNull(timeoutMs) { deferred.await() }
        ?: throw Exception("Request timed out: $method")
    } finally {
      pendingRequests.remove(id)
    }
  }

  override fun onMessageReceived(event: MessageEvent) {
    val data = String(event.data, Charsets.UTF_8)
    when (event.path) {
      RPC_RESPONSE_PATH -> handleRpcResponse(data)
      EVENT_PATH -> handleGatewayEvent(data)
      PONG_PATH -> handlePong(event.sourceNodeId, data)
    }
  }

  private fun handleRpcResponse(data: String) {
    try {
      val root = json.parseToJsonElement(data) as? JsonObject ?: return
      val id = (root["id"] as? JsonPrimitive)?.content ?: return
      val ok = (root["ok"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
      if (ok) {
        val payload = root["payload"]
        pendingRequests.remove(id)?.complete(payload?.toString() ?: "{}")
      } else {
        val error = root["error"] as? JsonObject
        val code = (error?.get("code") as? JsonPrimitive)?.content ?: "UNKNOWN"
        val message = (error?.get("message") as? JsonPrimitive)?.content ?: "Request failed"
        pendingRequests.remove(id)?.completeExceptionally(Exception("$code: $message"))
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to parse RPC response: ${e.message}")
    }
  }

  private fun handleGatewayEvent(data: String) {
    try {
      val root = json.parseToJsonElement(data) as? JsonObject ?: return
      val event = (root["event"] as? JsonPrimitive)?.content ?: return
      val payload = root["payload"]
      val payloadJson = when (payload) {
        null, JsonNull -> null
        is JsonPrimitive -> payload.content
        else -> payload.toString()
      }
      _events.tryEmit(GatewayEvent(event, payloadJson))
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to parse event: ${e.message}")
    }
  }

  private fun handlePong(sourceNodeId: String, data: String) {
    val handshake = parseProxyHandshake(data)
    if (!handshake.ready) {
      phoneNodeId = null
      _connected.value = false
      _statusText.value =
        handshake.statusText?.takeIf { it.isNotBlank() }
          ?: context.getString(R.string.wear_status_phone_gateway_unavailable)
      scheduleReconnect()
      return
    }

    reconnectJob?.cancel()
    reconnectJob = null
    phoneNodeId = sourceNodeId
    _connected.value = true
    _statusText.value = context.getString(R.string.wear_status_connected_via_phone)
    // Emit mainSessionKey request so the chat loads
    _events.tryEmit(GatewayEvent("proxy.connected", null))
  }

  private suspend fun findPhoneAndPing() {
    try {
      val nodes = nodeClient.connectedNodes.await()
      val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull()
      if (phone == null) {
        _statusText.value = context.getString(R.string.wear_status_no_phone_found)
        // Retry after 5s
        scope.launch {
          delay(5000)
          if (!_connected.value) findPhoneAndPing()
        }
        return
      }
      phoneNodeId = phone.id
      _statusText.value = context.getString(R.string.wear_status_pinging_phone)
      val sent = withTimeoutOrNull(MESSAGE_SEND_TIMEOUT_MS) {
        messageClient.sendMessage(phone.id, PING_PATH, ByteArray(0)).await()
      }
      if (sent == null) {
        Log.w(TAG, "Timed out sending ping to phone ${phone.displayName ?: phone.id}")
        phoneNodeId = null
        _connected.value = false
        _statusText.value = context.getString(R.string.wear_status_phone_ping_timed_out)
        scheduleReconnect()
        return
      }
      // If we don't get a pong in time, retry.
      scope.launch {
        delay(PHONE_PONG_TIMEOUT_MS)
        if (!_connected.value) {
          phoneNodeId = null
          _statusText.value = context.getString(R.string.wear_status_phone_not_responding)
          scheduleReconnect(delayMs = 0)
        }
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Failed to find phone: ${e.message}")
      _connected.value = false
      _statusText.value = context.getString(R.string.wear_status_failed, e.message ?: "")
      scheduleReconnect(delayMs = 5_000)
    }
  }

  private suspend fun sendMessageWithTimeout(
    nodeId: String,
    path: String,
    data: ByteArray,
    timeoutMs: Long,
  ) {
    withTimeout(timeoutMs) {
      messageClient.sendMessage(nodeId, path, data).await()
    }
  }

  private fun scheduleReconnect(delayMs: Long = PHONE_PONG_TIMEOUT_MS) {
    reconnectJob?.cancel()
    reconnectJob = scope.launch {
      delay(delayMs)
      if (!_connected.value) findPhoneAndPing()
    }
  }

  private fun parseProxyHandshake(data: String): ProxyHandshake {
    if (data.isBlank()) {
      return ProxyHandshake(ready = true, statusText = null)
    }

    return try {
      val root = json.parseToJsonElement(data) as? JsonObject
      val ready = (root?.get("ready") as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
      val statusText = (root?.get("statusText") as? JsonPrimitive)?.content
      ProxyHandshake(ready = ready ?: true, statusText = statusText)
    } catch (_: Throwable) {
      ProxyHandshake(ready = true, statusText = null)
    }
  }
}
