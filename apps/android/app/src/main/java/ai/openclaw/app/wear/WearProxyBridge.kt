package ai.openclaw.app.wear

import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.GatewayEventQueue
import ai.openclaw.android.gateway.ProxyGatewayConfigPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal interface WearProxyEventSession {
  val events: Flow<GatewayEvent>
  fun close()
}

internal class WearProxyBridge(
  private val scope: CoroutineScope,
  private val json: Json,
  private val isConnected: () -> Boolean,
  private val operatorStatusText: () -> String,
  private val statusText: () -> String,
  private val gatewayConfig: () -> ProxyGatewayConfigPayload?,
) {
  private data class ActiveSession(
    val queue: GatewayEventQueue,
    val forwardJob: Job,
    val outboundEvents: Channel<GatewayEvent>,
  )

  private val sessionLock = Any()
  private val activeSessions = linkedSetOf<ActiveSession>()

  fun emit(event: String, payloadJson: String?) {
    emit(GatewayEvent(event, payloadJson))
  }

  fun emit(event: GatewayEvent) {
    val sessions =
      synchronized(sessionLock) {
        activeSessions.toList()
      }
    sessions.forEach { session ->
      session.queue.emit(event)
    }
  }

  fun openEventSession(logTag: String = "WearProxy"): WearProxyEventSession {
    val sessionQueue = GatewayEventQueue(scope = scope, json = json, logTag = logTag)
    val outboundEvents = Channel<GatewayEvent>(capacity = Channel.UNLIMITED)
    val forwardJob =
      scope.launch {
        sessionQueue.events.collect { event ->
          outboundEvents.send(event)
        }
      }
    val activeSession =
      ActiveSession(
        queue = sessionQueue,
        forwardJob = forwardJob,
        outboundEvents = outboundEvents,
      )
    synchronized(sessionLock) {
      activeSessions += activeSession
    }
    return object : WearProxyEventSession {
      override val events: Flow<GatewayEvent> = outboundEvents.receiveAsFlow()

      override fun close() {
        synchronized(sessionLock) {
          activeSessions.remove(activeSession)
        }
        activeSession.forwardJob.cancel()
        activeSession.outboundEvents.close()
      }
    }
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
