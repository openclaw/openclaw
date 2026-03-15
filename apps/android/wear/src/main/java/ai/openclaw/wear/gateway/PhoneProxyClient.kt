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
private const val PHONE_LIVENESS_PING_INTERVAL_MS = 30_000L

internal data class ProxyNode(
  val id: String,
  val displayName: String?,
  val isNearby: Boolean,
)

internal data class ProxyMessageEvent(
  val path: String,
  val sourceNodeId: String,
  val data: ByteArray,
)

internal fun interface ProxyMessageListener {
  fun onMessageReceived(event: ProxyMessageEvent)
}

internal interface ProxyMessageTransport {
  fun addListener(listener: ProxyMessageListener)
  fun removeListener(listener: ProxyMessageListener)
  suspend fun sendMessage(nodeId: String, path: String, data: ByteArray)
}

internal interface ProxyNodeFinder {
  suspend fun connectedNodes(): List<ProxyNode>
}

private class WearableMessageTransport(
  private val messageClient: MessageClient,
) : ProxyMessageTransport {
  private val listeners = mutableMapOf<ProxyMessageListener, MessageClient.OnMessageReceivedListener>()

  override fun addListener(listener: ProxyMessageListener) {
    val adapter =
      MessageClient.OnMessageReceivedListener { event ->
        listener.onMessageReceived(
          ProxyMessageEvent(
            path = event.path,
            sourceNodeId = event.sourceNodeId,
            data = event.data,
          ),
        )
      }
    listeners[listener] = adapter
    messageClient.addListener(adapter)
  }

  override fun removeListener(listener: ProxyMessageListener) {
    listeners.remove(listener)?.let(messageClient::removeListener)
  }

  override suspend fun sendMessage(nodeId: String, path: String, data: ByteArray) {
    messageClient.sendMessage(nodeId, path, data).await()
  }
}

private class WearableNodeFinder(
  private val nodeClient: NodeClient,
) : ProxyNodeFinder {
  override suspend fun connectedNodes(): List<ProxyNode> {
    return nodeClient.connectedNodes.await().map { node ->
      ProxyNode(
        id = node.id,
        displayName = node.displayName,
        isNearby = node.isNearby,
      )
    }
  }
}

/**
 * Gateway client that routes all requests through the phone app
 * via Wear OS Data Layer MessageClient.
 */
class PhoneProxyClient internal constructor(
  private val stringResolver: (Int) -> String,
  private val formattedStringResolver: (Int, Array<out Any>) -> String,
  private val scope: CoroutineScope,
  private val messageTransport: ProxyMessageTransport,
  private val nodeFinder: ProxyNodeFinder,
) : GatewayClientInterface {
  constructor(context: Context) : this(
    stringResolver = context::getString,
    formattedStringResolver = { id, args -> context.getString(id, *args) },
    scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    messageTransport = WearableMessageTransport(Wearable.getMessageClient(context)),
    nodeFinder = WearableNodeFinder(Wearable.getNodeClient(context)),
  )

  private data class ProxyHandshake(
    val ready: Boolean,
    val statusText: String?,
  )

  private val json = Json { ignoreUnknownKeys = true }
  private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<String>>()
  private val messageListener = ProxyMessageListener(::onMessageReceived)

  private var phoneNodeId: String? = null
  private var reconnectJob: Job? = null
  private var livenessJob: Job? = null
  private var connectionGeneration = 0L
  @Volatile private var lastPongReceivedAtNanos: Long = 0L

  private val _connected = MutableStateFlow(false)
  override val connected: StateFlow<Boolean> = _connected.asStateFlow()

  private val _statusText = MutableStateFlow(stringResolver(R.string.wear_status_phone_proxy_offline))
  override val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 64)
  override val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

  fun connect() {
    messageTransport.addListener(messageListener)
    reconnectJob?.cancel()
    livenessJob?.cancel()
    _statusText.value = stringResolver(R.string.wear_status_finding_phone)
    val generation = connectionGeneration + 1
    connectionGeneration = generation
    lastPongReceivedAtNanos = 0L
    scope.launch {
      findPhoneAndPing(generation)
    }
  }

  fun disconnect() {
    messageTransport.removeListener(messageListener)
    reconnectJob?.cancel()
    reconnectJob = null
    livenessJob?.cancel()
    livenessJob = null
    connectionGeneration += 1
    phoneNodeId = null
    _connected.value = false
    _statusText.value = stringResolver(R.string.wear_status_phone_proxy_offline)
    pendingRequests.values.forEach { it.completeExceptionally(Exception("Disconnected")) }
    pendingRequests.clear()
  }

  override suspend fun request(method: String, paramsJson: String?, timeoutMs: Long): String {
    val nodeId = phoneNodeId ?: throw Exception("Phone not connected")
    val generation = connectionGeneration
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
    try {
      sendMessageWithTimeout(
        nodeId = nodeId,
        path = RPC_PATH,
        data = msg.toString().toByteArray(Charsets.UTF_8),
        timeoutMs = MESSAGE_SEND_TIMEOUT_MS,
      )
    } catch (e: Throwable) {
      handleTransportFailure(
        statusText = stringResolver(R.string.wear_status_phone_not_responding),
        generation = generation,
      )
      pendingRequests.remove(id)
      throw e
    }

    return try {
      withTimeoutOrNull(timeoutMs) { deferred.await() }
        ?: run {
          handleTransportFailure(
            statusText = stringResolver(R.string.wear_status_phone_not_responding),
            generation = generation,
          )
          throw Exception("Request timed out: $method")
        }
    } finally {
      pendingRequests.remove(id)
    }
  }

  private fun onMessageReceived(event: ProxyMessageEvent) {
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
      livenessJob?.cancel()
      livenessJob = null
      phoneNodeId = null
      _connected.value = false
      _statusText.value =
        handshake.statusText?.takeIf { it.isNotBlank() }
          ?: stringResolver(R.string.wear_status_phone_gateway_unavailable)
      scheduleReconnect()
      return
    }

    val wasConnected = _connected.value && phoneNodeId == sourceNodeId
    reconnectJob?.cancel()
    reconnectJob = null
    phoneNodeId = sourceNodeId
    lastPongReceivedAtNanos = System.nanoTime()
    _connected.value = true
    _statusText.value = stringResolver(R.string.wear_status_connected_via_phone)
    if (!wasConnected) {
      // Emit mainSessionKey request so the chat loads.
      _events.tryEmit(GatewayEvent("proxy.connected", null))
    }
    startLivenessChecks(sourceNodeId, connectionGeneration)
  }

  private suspend fun findPhoneAndPing(generation: Long) {
    if (generation != connectionGeneration) return
    try {
      val nodes = nodeFinder.connectedNodes()
      if (generation != connectionGeneration) return
      val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull()
      if (phone == null) {
        _connected.value = false
        phoneNodeId = null
        _statusText.value = stringResolver(R.string.wear_status_no_phone_found)
        scheduleReconnect(delayMs = 5_000, generation = generation)
        return
      }
      phoneNodeId = phone.id
      _statusText.value = stringResolver(R.string.wear_status_pinging_phone)
      val sent = withTimeoutOrNull(MESSAGE_SEND_TIMEOUT_MS) {
        messageTransport.sendMessage(phone.id, PING_PATH, ByteArray(0))
      }
      if (sent == null) {
        Log.w(TAG, "Timed out sending ping to phone ${phone.displayName ?: phone.id}")
        phoneNodeId = null
        _connected.value = false
        _statusText.value = stringResolver(R.string.wear_status_phone_ping_timed_out)
        scheduleReconnect(generation = generation)
        return
      }
      // If we don't get a pong in time, retry.
      scope.launch {
        delay(PHONE_PONG_TIMEOUT_MS)
        if (generation == connectionGeneration && !_connected.value) {
          phoneNodeId = null
          _statusText.value = stringResolver(R.string.wear_status_phone_not_responding)
          scheduleReconnect(delayMs = 0, generation = generation)
        }
      }
    } catch (e: Throwable) {
      if (generation != connectionGeneration) return
      Log.w(TAG, "Failed to find phone: ${e.message}")
      _connected.value = false
      _statusText.value = formattedStringResolver(R.string.wear_status_failed, arrayOf(e.message ?: ""))
      scheduleReconnect(delayMs = 5_000, generation = generation)
    }
  }

  private suspend fun sendMessageWithTimeout(
    nodeId: String,
    path: String,
    data: ByteArray,
    timeoutMs: Long,
  ) {
    withTimeout(timeoutMs) {
      messageTransport.sendMessage(nodeId, path, data)
    }
  }

  private fun scheduleReconnect(delayMs: Long = PHONE_PONG_TIMEOUT_MS, generation: Long = connectionGeneration) {
    reconnectJob?.cancel()
    reconnectJob = scope.launch {
      delay(delayMs)
      if (generation == connectionGeneration && !_connected.value) {
        findPhoneAndPing(generation)
      }
    }
  }

  private fun handleTransportFailure(statusText: String, generation: Long) {
    if (generation != connectionGeneration) return
    livenessJob?.cancel()
    livenessJob = null
    phoneNodeId = null
    _connected.value = false
    _statusText.value = statusText
    scheduleReconnect(generation = generation)
  }

  private fun startLivenessChecks(nodeId: String, generation: Long) {
    livenessJob?.cancel()
    livenessJob =
      scope.launch {
        while (generation == connectionGeneration && _connected.value && phoneNodeId == nodeId) {
          delay(PHONE_LIVENESS_PING_INTERVAL_MS)
          if (generation != connectionGeneration || !_connected.value || phoneNodeId != nodeId) break
          val pingStartedAtNanos = System.nanoTime()
          try {
            sendMessageWithTimeout(
              nodeId = nodeId,
              path = PING_PATH,
              data = ByteArray(0),
              timeoutMs = MESSAGE_SEND_TIMEOUT_MS,
            )
          } catch (_: Throwable) {
            handleTransportFailure(
              statusText = stringResolver(R.string.wear_status_phone_not_responding),
              generation = generation,
            )
            break
          }
          delay(PHONE_PONG_TIMEOUT_MS)
          if (generation != connectionGeneration || !_connected.value || phoneNodeId != nodeId) break
          if (lastPongReceivedAtNanos < pingStartedAtNanos) {
            handleTransportFailure(
              statusText = stringResolver(R.string.wear_status_phone_not_responding),
              generation = generation,
            )
            break
          }
        }
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
