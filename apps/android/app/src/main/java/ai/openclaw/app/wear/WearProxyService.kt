package ai.openclaw.app.wear

import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import ai.openclaw.app.NodeApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
private const val RPC_PATH = "/openclaw/rpc"
private const val RPC_RESPONSE_PATH = "/openclaw/rpc-response"
private const val EVENT_PATH = "/openclaw/event"
private const val PING_PATH = "/openclaw/ping"
private const val PONG_PATH = "/openclaw/pong"

/**
 * Runs on the PHONE. Receives RPC requests from the watch via Data Layer,
 * forwards them through the phone's existing gateway session, and relays
 * responses and events back to the watch.
 */
class WearProxyService : WearableListenerService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val messageClient: MessageClient by lazy { Wearable.getMessageClient(this) }
  private var eventForwardingJob: Job? = null

  private val runtime get() = (application as NodeApp).runtime

  override fun onMessageReceived(event: MessageEvent) {
    Log.i(TAG, "onMessageReceived: path=${event.path} from=${event.sourceNodeId}")
    when (event.path) {
      PING_PATH -> handlePing(event.sourceNodeId)
      RPC_PATH -> handleRpcRequest(event.sourceNodeId, event.data)
      else -> Log.w(TAG, "Unknown path: ${event.path}")
    }
  }

  private fun handlePing(sourceNodeId: String) {
    Log.i(TAG, "Watch ping from $sourceNodeId, sending pong…")
    scope.launch {
      try {
        val handshakePayload = runtime.wearProxyHandshakePayload().toByteArray(Charsets.UTF_8)
        messageClient.sendMessage(sourceNodeId, PONG_PATH, handshakePayload).await()
        Log.i(TAG, "Pong sent successfully to $sourceNodeId")
        if (runtime.isConnected.value) {
          startEventForwarding(sourceNodeId)
        } else {
          eventForwardingJob?.cancel()
          eventForwardingJob = null
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
          messageClient.sendMessage(sourceNodeId, RPC_RESPONSE_PATH, response.toString().toByteArray(Charsets.UTF_8)).await()
          Log.i(TAG, "RPC response sent for $method id=$id")
        } catch (e: Throwable) {
          Log.e(TAG, "RPC failed: method=$method error=${e.message}", e)
          val response = buildJsonObject {
            put("id", JsonPrimitive(id))
            put("ok", JsonPrimitive(false))
            put("error", buildJsonObject {
              put("code", JsonPrimitive("PROXY_ERROR"))
              put("message", JsonPrimitive(e.message ?: "Unknown error"))
            })
          }
          messageClient.sendMessage(sourceNodeId, RPC_RESPONSE_PATH, response.toString().toByteArray(Charsets.UTF_8)).await()
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Failed to handle RPC: ${e.message}", e)
      }
    }
  }

  private fun startEventForwarding(nodeId: String) {
    eventForwardingJob?.cancel()
    Log.i(TAG, "Starting event forwarding to $nodeId")
    eventForwardingJob =
      WearProxyEventForwarder(
        nodeId = nodeId,
        mainSessionKey = runtime.mainSessionKey,
        events = runtime.wearProxyEvents,
        sendEvent = ::sendEvent,
      ).startIn(scope)
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
    messageClient.sendMessage(nodeId, EVENT_PATH, msg.toString().toByteArray(Charsets.UTF_8)).await()
  }

  override fun onDestroy() {
    Log.i(TAG, "WearProxyService destroyed")
    scope.cancel()
    super.onDestroy()
  }
}

internal class WearProxyEventForwarder(
  private val nodeId: String,
  private val mainSessionKey: StateFlow<String>,
  private val events: Flow<Pair<String, String?>>,
  private val sendEvent: suspend (String, String, String?) -> Unit,
) {
  fun startIn(scope: CoroutineScope): Job {
    return scope.launch {
      sendEvent(nodeId, "mainSessionKey", mainSessionKey.value.takeIf { it.isNotBlank() })
      events.collect { (event, payloadJson) ->
        try {
          sendEvent(nodeId, event, payloadJson)
          Log.d(TAG, "Forwarded event: $event")
        } catch (e: Throwable) {
          Log.w(TAG, "Failed to forward event to watch: ${e.message}")
        }
      }
    }
  }
}
