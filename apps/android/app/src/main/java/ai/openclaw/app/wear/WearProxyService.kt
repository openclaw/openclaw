package ai.openclaw.app.wear

import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import ai.openclaw.app.NodeApp
import ai.openclaw.app.gateway.parseInvokeErrorMessage
import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.ProxyPaths
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private const val TAG = "WearProxy"

internal data class WearProxyRpcError(
  val code: String,
  val message: String,
)

internal fun classifyWearProxyRpcError(error: Throwable): WearProxyRpcError {
  val message = error.message?.trim().orEmpty()
  if (message.contains("not connected", ignoreCase = true)) {
    return WearProxyRpcError(
      code = "PROXY_ERROR",
      message = "Gateway disconnected",
    )
  }

  val parsed = parseInvokeErrorMessage(message)
  if (parsed.hadExplicitCode) {
    return WearProxyRpcError(code = parsed.code, message = parsed.message)
  }

  if (message.equals("request timeout", ignoreCase = true)) {
    return WearProxyRpcError(
      code = "REQUEST_TIMEOUT",
      message = "Request timed out",
    )
  }

  return WearProxyRpcError(
    code = "REQUEST_ERROR",
    message = message.ifEmpty { "Unknown error" },
  )
}

/**
 * Runs on the PHONE. Receives RPC requests from the watch via Data Layer,
 * forwards them through the phone's existing gateway session, and relays
 * responses and events back to the watch.
 */
class WearProxyService : WearableListenerService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val messageClient: MessageClient by lazy { Wearable.getMessageClient(this) }

  private val nodeApp: NodeApp
    get() = application as NodeApp

  private val runtime
    get() = nodeApp.ensureRuntime()

  private val eventForwardingRegistry by lazy {
    WearProxyForwardingRegistry(
      scope = scope,
      mainSessionKey = runtime.mainSessionKey,
      openEventSession = { nodeId ->
        runtime.openWearProxyEventSession(logTag = "WearProxy:$nodeId")
      },
      sendEvent = ::sendEvent,
    )
  }

  override fun onMessageReceived(event: MessageEvent) {
    Log.i(TAG, "onMessageReceived: path=${event.path} from=${event.sourceNodeId}")
    when (event.path) {
      ProxyPaths.PING -> handlePing(event.sourceNodeId)
      ProxyPaths.RPC -> handleRpcRequest(event.sourceNodeId, event.data)
      else -> Log.w(TAG, "Unknown path: ${event.path}")
    }
  }

  override fun onPeerDisconnected(node: Node) {
    Log.i(TAG, "Watch disconnected: ${node.id}")
    eventForwardingRegistry.stopForwarding(node.id)
    super.onPeerDisconnected(node)
  }

  private fun handlePing(sourceNodeId: String) {
    Log.i(TAG, "Watch ping from $sourceNodeId, sending pong…")
    scope.launch {
      try {
        val handshakePayload = runtime.wearProxyHandshakePayload().toByteArray(Charsets.UTF_8)
        messageClient.sendMessage(sourceNodeId, ProxyPaths.PONG, handshakePayload).await()
        Log.i(TAG, "Pong sent successfully to $sourceNodeId")
        if (runtime.isConnected.value) {
          eventForwardingRegistry.ensureForwarding(sourceNodeId)
        } else {
          eventForwardingRegistry.stopAll()
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to send pong: ${e.message}", e)
      }
    }
  }

  private fun handleRpcRequest(sourceNodeId: String, data: ByteArray) {
    val requestStr = String(data, Charsets.UTF_8)
    Log.i(TAG, "RPC request from $sourceNodeId: ${requestStr.take(200)}")
    scope.launch {
      try {
        val request = json.parseToJsonElement(requestStr) as? JsonObject ?: return@launch
        val id = (request["id"] as? JsonPrimitive)?.content ?: return@launch
        val method = (request["method"] as? JsonPrimitive)?.content ?: return@launch
        val params = request["params"]
        val paramsJson = if (params == null || params is JsonNull) null else params.toString()

        Log.i(TAG, "Forwarding RPC: method=$method id=$id")
        try {
          val result = runtime.requestForWearProxy(method, paramsJson)
          val response = buildJsonObject {
            put("id", JsonPrimitive(id))
            put("ok", JsonPrimitive(true))
            put("payload", json.parseToJsonElement(result))
          }
          messageClient.sendMessage(sourceNodeId, ProxyPaths.RPC_RESPONSE, response.toString().toByteArray(Charsets.UTF_8)).await()
          Log.i(TAG, "RPC response sent for $method id=$id")
        } catch (e: Throwable) {
          Log.e(TAG, "RPC failed: method=$method error=${e.message}", e)
          val proxyError = classifyWearProxyRpcError(e)
          val response = buildJsonObject {
            put("id", JsonPrimitive(id))
            put("ok", JsonPrimitive(false))
            put("error", buildJsonObject {
              put("code", JsonPrimitive(proxyError.code))
              put("message", JsonPrimitive(proxyError.message))
            })
          }
          messageClient.sendMessage(sourceNodeId, ProxyPaths.RPC_RESPONSE, response.toString().toByteArray(Charsets.UTF_8)).await()
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to handle RPC: ${e.message}", e)
      }
    }
  }

  private suspend fun sendEvent(nodeId: String, event: String, payloadJson: String?) {
    val msg = buildJsonObject {
      put("event", JsonPrimitive(event))
      if (payloadJson != null) {
        val payload =
          try {
            json.parseToJsonElement(payloadJson)
          } catch (_: Throwable) {
            JsonPrimitive(payloadJson)
          }
        put("payload", payload)
      }
    }
    messageClient.sendMessage(nodeId, ProxyPaths.EVENT, msg.toString().toByteArray(Charsets.UTF_8)).await()
  }

  override fun onDestroy() {
    Log.i(TAG, "WearProxyService destroyed")
    eventForwardingRegistry.stopAll()
    scope.cancel()
    super.onDestroy()
  }
}

internal class WearProxyForwardingRegistry(
  private val scope: CoroutineScope,
  private val mainSessionKey: StateFlow<String>,
  private val openEventSession: (String) -> WearProxyEventSession,
  private val sendEvent: suspend (String, String, String?) -> Unit,
  private val forwarderFactory: WearProxyForwarderFactory = DefaultWearProxyForwarderFactory,
) {
  private data class ActiveForwarder(
    val eventSession: WearProxyEventSession,
    val job: Job,
  )

  private val forwarders = linkedMapOf<String, ActiveForwarder>()

  fun ensureForwarding(nodeId: String) {
    val active = synchronized(forwarders) { forwarders[nodeId] }
    if (active?.job?.isActive == true) {
      return
    }
    val eventSession = openEventSession(nodeId)
    val job = forwarderFactory.start(nodeId, mainSessionKey, eventSession.events, sendEvent, scope)
    synchronized(forwarders) {
      forwarders.put(nodeId, ActiveForwarder(eventSession = eventSession, job = job))
    }?.close()
  }

  fun stopForwarding(nodeId: String) {
    synchronized(forwarders) {
      forwarders.remove(nodeId)
    }?.close()
  }

  fun stopAll() {
    val activeForwarders =
      synchronized(forwarders) {
        val snapshot = forwarders.values.toList()
        forwarders.clear()
        snapshot
      }
    activeForwarders.forEach { it.close() }
  }

  private fun ActiveForwarder.close() {
    job.cancel()
    eventSession.close()
  }
}

internal fun interface WearProxyForwarderFactory {
  fun start(
    nodeId: String,
    mainSessionKey: StateFlow<String>,
    events: Flow<GatewayEvent>,
    sendEvent: suspend (String, String, String?) -> Unit,
    scope: CoroutineScope,
  ): Job
}

private val DefaultWearProxyForwarderFactory =
  WearProxyForwarderFactory { nodeId, mainSessionKey, events, sendEvent, scope ->
    WearProxyEventForwarder(
      nodeId = nodeId,
      mainSessionKey = mainSessionKey,
      events = events,
      sendEvent = sendEvent,
    ).startIn(scope)
  }

internal class WearProxyEventForwarder(
  private val nodeId: String,
  private val mainSessionKey: StateFlow<String>,
  private val events: Flow<GatewayEvent>,
  private val sendEvent: suspend (String, String, String?) -> Unit,
) {
  fun startIn(scope: CoroutineScope): Job {
    return scope.launch(start = CoroutineStart.UNDISPATCHED) {
      // Subscribe before the initial handshake event so startup races do not
      // drop chat/agent updates on newly connected watches.
      val bufferedEvents = Channel<GatewayEvent>(capacity = Channel.UNLIMITED)
      val collectJob =
        launch(start = CoroutineStart.UNDISPATCHED) {
          events.collect { event ->
            bufferedEvents.send(event)
          }
        }
      try {
        sendEvent(nodeId, "mainSessionKey", mainSessionKey.value.takeIf { it.isNotBlank() })
        for (event in bufferedEvents) {
          try {
            sendEvent(nodeId, event.event, event.payloadJson)
            Log.d(TAG, "Forwarded event: ${event.event}")
          } catch (e: Throwable) {
            Log.w(TAG, "Failed to forward event to watch: ${e.message}")
          }
        }
      } finally {
        collectJob.cancel()
        bufferedEvents.close()
      }
    }
  }
}
