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

  private data class PendingProbe(
    val generation: Long,
    val nodeId: String,
    val result: CompletableDeferred<ProxyHandshake>,
  )

  private val json = Json { ignoreUnknownKeys = true }
  private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<String>>()
  private val messageListener = ProxyMessageListener(::onMessageReceived)
  private val probeLock = Any()

  private var phoneNodeId: String? = null
  private var pendingProbe: PendingProbe? = null
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
    clearPendingProbe()
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
    clearPendingProbe()
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
    if (!shouldAcceptMessage(event.sourceNodeId, event.path)) {
      return
    }
    val data = String(event.data, Charsets.UTF_8)
    when (event.path) {
      RPC_RESPONSE_PATH -> handleRpcResponse(data)
      EVENT_PATH -> handleGatewayEvent(data)
      PONG_PATH -> handlePong(event.sourceNodeId, data)
    }
  }

  private fun shouldAcceptMessage(sourceNodeId: String, path: String): Boolean {
    val activeNodeId = phoneNodeId
    return when (path) {
      PONG_PATH -> shouldAcceptPong(sourceNodeId, activeNodeId)
      RPC_RESPONSE_PATH, EVENT_PATH -> activeNodeId != null && activeNodeId == sourceNodeId
      else -> false
    }
  }

  private fun shouldAcceptPong(sourceNodeId: String, activeNodeId: String?): Boolean {
    val activeProbe =
      synchronized(probeLock) {
        pendingProbe
      }
    return when {
      activeProbe != null -> activeProbe.nodeId == sourceNodeId
      activeNodeId != null -> activeNodeId == sourceNodeId
      else -> false
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
    val probe =
      synchronized(probeLock) {
        pendingProbe?.takeIf {
          it.generation == connectionGeneration && it.nodeId == sourceNodeId
        }
      }
    if (probe != null) {
      probe.result.complete(handshake)
      return
    }

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

    acceptConnectedPhoneNode(sourceNodeId, connectionGeneration)
  }

  private suspend fun findPhoneAndPing(generation: Long) {
    if (generation != connectionGeneration) return
    try {
      val nodes = prioritizeProxyNodes(nodeFinder.connectedNodes())
      if (generation != connectionGeneration) return
      if (nodes.isEmpty()) {
        _connected.value = false
        phoneNodeId = null
        _statusText.value = stringResolver(R.string.wear_status_no_phone_found)
        scheduleReconnect(delayMs = 5_000, generation = generation)
        return
      }

      var lastFailureStatus = stringResolver(R.string.wear_status_phone_not_responding)
      for (phone in nodes) {
        if (generation != connectionGeneration) return
        val handshake = probePhoneNode(phone, generation)
        if (handshake == null) {
          lastFailureStatus = stringResolver(R.string.wear_status_phone_not_responding)
          continue
        }
        if (!handshake.ready) {
          lastFailureStatus =
            handshake.statusText?.takeIf { it.isNotBlank() }
              ?: stringResolver(R.string.wear_status_phone_gateway_unavailable)
          continue
        }
        acceptConnectedPhoneNode(phone.id, generation)
        return
      }

      if (generation != connectionGeneration) return
      _connected.value = false
      phoneNodeId = null
      _statusText.value = lastFailureStatus
      scheduleReconnect(generation = generation)
    } catch (e: Throwable) {
      if (generation != connectionGeneration) return
      Log.w(TAG, "Failed to find phone: ${e.message}")
      _connected.value = false
      _statusText.value = formattedStringResolver(R.string.wear_status_failed, arrayOf(e.message ?: ""))
      scheduleReconnect(delayMs = 5_000, generation = generation)
    }
  }

  private suspend fun probePhoneNode(phone: ProxyNode, generation: Long): ProxyHandshake? {
    val probe = PendingProbe(generation = generation, nodeId = phone.id, result = CompletableDeferred())
    synchronized(probeLock) {
      pendingProbe = probe
    }
    _statusText.value = stringResolver(R.string.wear_status_pinging_phone)
    return try {
      val sent =
        withTimeoutOrNull(MESSAGE_SEND_TIMEOUT_MS) {
          messageTransport.sendMessage(phone.id, PING_PATH, ByteArray(0))
        }
      if (sent == null) {
        Log.w(TAG, "Timed out sending ping to phone ${phone.displayName ?: phone.id}")
        return null
      }
      withTimeoutOrNull(PHONE_PONG_TIMEOUT_MS) { probe.result.await() }
    } finally {
      synchronized(probeLock) {
        if (pendingProbe === probe) {
          pendingProbe = null
        }
      }
    }
  }

  private fun acceptConnectedPhoneNode(sourceNodeId: String, generation: Long) {
    if (generation != connectionGeneration) return
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
    startLivenessChecks(sourceNodeId, generation)
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
    clearPendingProbe()
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

  private fun clearPendingProbe() {
    val probe =
      synchronized(probeLock) {
        pendingProbe.also { pendingProbe = null }
      }
    probe?.result?.cancel()
  }
}

internal fun prioritizeProxyNodes(nodes: List<ProxyNode>): List<ProxyNode> {
  return nodes.sortedWith(compareByDescending<ProxyNode> { it.isNearby }.thenBy { it.displayName ?: it.id })
}
