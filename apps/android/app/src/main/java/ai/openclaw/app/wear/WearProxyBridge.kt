package ai.openclaw.app.wear

import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.GatewayEventQueue
import ai.openclaw.android.gateway.ProxyGatewayConfigPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal class WearProxyBridge(
  private val scope: CoroutineScope,
  private val json: Json,
  private val isConnected: () -> Boolean,
  private val operatorStatusText: () -> String,
  private val statusText: () -> String,
  private val gatewayConfig: () -> ProxyGatewayConfigPayload?,
) {
  // Queue/coalesce to keep terminal states when Data Layer backpressures.
  private val eventQueue = GatewayEventQueue(scope = scope, json = json, logTag = "WearProxy")

  val events: SharedFlow<GatewayEvent> = eventQueue.events

  fun emit(event: String, payloadJson: String?) {
    eventQueue.emit(event, payloadJson)
  }

  fun handshakePayload(): String {
    val operatorStatus = operatorStatusText().trim()
    val fallbackStatus = statusText().trim()
    val status =
      when {
        isConnected() -> "Connected"
        operatorStatus.isNotEmpty() -> operatorStatus
        fallbackStatus.isNotEmpty() -> fallbackStatus
        else -> "Offline"
      }

    return buildJsonObject {
      put("ready", JsonPrimitive(isConnected()))
      put("statusText", JsonPrimitive(status))
      gatewayConfig()?.let { snapshot ->
        put(
          "gatewayConfig",
          buildJsonObject {
            put("host", JsonPrimitive(snapshot.host))
            put("port", JsonPrimitive(snapshot.port))
            put("useTls", JsonPrimitive(snapshot.useTls))
            snapshot.token?.let { put("token", JsonPrimitive(it)) }
            snapshot.bootstrapToken?.let { put("bootstrapToken", JsonPrimitive(it)) }
            snapshot.password?.let { put("password", JsonPrimitive(it)) }
            snapshot.tlsFingerprintSha256?.let { put("tlsFingerprintSha256", JsonPrimitive(it)) }
          },
        )
      }
    }.toString()
  }
}
