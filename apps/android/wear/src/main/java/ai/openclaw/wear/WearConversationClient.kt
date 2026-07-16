package ai.openclaw.wear

import ai.openclaw.wear.shared.WearChatMessage
import ai.openclaw.wear.shared.WearChatRole
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import ai.openclaw.wear.shared.WearSessionSummary
import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

internal data class WearConversationClientResult(
  val snapshot: WearConversationSnapshot? = null,
  val failure: WearConversationFailure? = null,
)

internal enum class WearConversationFailure {
  PHONE_UNAVAILABLE,
  PHONE_NOT_READY,
  GATEWAY_OFFLINE,
  NOT_FOUND,
  ACTION_REJECTED,
  INCOMPATIBLE,
  INTERNAL_ERROR,
}

internal data class WearRpcResult(
  val payload: JsonElement? = null,
  val failure: WearConversationFailure? = null,
)

internal class WearConversationClient(
  context: Context,
) {
  private val capabilityClient = Wearable.getCapabilityClient(context)
  private val messageClient = Wearable.getMessageClient(context)

  private val pendingResponses = ConcurrentHashMap<String, CompletableDeferred<WearMessage.Response>>()
  private val responseListener = MessageClient.OnMessageReceivedListener(::handleMessage)
  private val listenerRegistration = messageClient.addListener(responseListener)

  @Volatile
  private var selectedSessionKey: String? = null

  suspend fun loadSnapshot(): WearConversationClientResult {
    val status = execute(WearRpcMethod.ProxyStatus)
    status.failure?.let { return WearConversationClientResult(failure = it) }
    val connected = status.payload.objectOrNull()?.boolean("connected") ?: return incompatible()
    if (!connected) {
      return WearConversationClientResult(
        snapshot =
          WearConversationSnapshot(
            generatedAtEpochMillis = System.currentTimeMillis(),
            gatewayState = WearGatewayState.DISCONNECTED,
          ),
      )
    }

    val sessions = execute(WearRpcMethod.SessionsList)
    sessions.failure?.let { return WearConversationClientResult(failure = it) }
    val sessionRows = sessions.payload.objectOrNull()?.get("sessions") as? JsonArray ?: return incompatible()
    val availableKeys = sessionRows.mapNotNull { it.objectOrNull()?.string("key") }
    val activeKey = selectedSessionKey?.takeIf(availableKeys::contains) ?: availableKeys.firstOrNull()
    selectedSessionKey = activeKey
    val history =
      if (activeKey == null) {
        null
      } else {
        execute(
          WearRpcMethod.ChatHistory,
          buildJsonObject {
            put(SESSION_KEY_PARAM, activeKey)
            put(LIMIT_PARAM, HISTORY_LIMIT)
            put(MAX_CHARS_PARAM, HISTORY_MAX_CHARS)
          },
        )
      }
    history?.failure?.let { return WearConversationClientResult(failure = it) }

    return WearConversationClientResult(
      snapshot =
        buildConversationSnapshot(
          status = checkNotNull(status.payload).jsonObject,
          sessions = checkNotNull(sessions.payload).jsonObject,
          history = history?.payload?.objectOrNull(),
          activeSessionKey = activeKey,
          generatedAtEpochMillis = System.currentTimeMillis(),
        ),
    )
  }

  suspend fun sendMessage(
    message: String,
    sessionId: String?,
  ): WearConversationClientResult {
    val sessionKey = sessionId ?: selectedSessionKey ?: return WearConversationClientResult(failure = WearConversationFailure.NOT_FOUND)
    val result =
      execute(
        method = WearRpcMethod.ChatSend,
        params =
          buildJsonObject {
            put(MESSAGE_PARAM, message)
            put(SESSION_KEY_PARAM, sessionKey)
            put(IDEMPOTENCY_KEY_PARAM, UUID.randomUUID().toString())
          },
      )
    result.failure?.let { return WearConversationClientResult(failure = it) }
    return loadSnapshot()
  }

  suspend fun selectSession(sessionId: String): WearConversationClientResult {
    val previous = selectedSessionKey
    selectedSessionKey = sessionId
    return loadSnapshot().also { result ->
      if (result.snapshot == null) selectedSessionKey = previous
    }
  }

  suspend fun abort(): WearConversationClientResult {
    val sessionKey = selectedSessionKey ?: return WearConversationClientResult(failure = WearConversationFailure.NOT_FOUND)
    val result = execute(WearRpcMethod.ChatAbort, buildJsonObject { put(SESSION_KEY_PARAM, sessionKey) })
    result.failure?.let { return WearConversationClientResult(failure = it) }
    return loadSnapshot()
  }

  fun close() {
    pendingResponses.values.forEach { pending -> pending.cancel() }
    pendingResponses.clear()
    messageClient.removeListener(responseListener)
  }

  private suspend fun execute(
    method: WearRpcMethod,
    params: JsonObject = buildJsonObject {},
  ): WearRpcResult =
    withContext(Dispatchers.IO) {
      runCatching {
        val requestId = UUID.randomUUID().toString()
        Tasks.await(listenerRegistration, REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val capability =
          Tasks.await(
            capabilityClient.getCapability(
              WearProtocol.PHONE_CAPABILITY,
              CapabilityClient.FILTER_REACHABLE,
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        val node =
          capability.nodes
            .sortedByDescending { candidate -> candidate.isNearby }
            .firstOrNull()
            ?: return@withContext WearRpcResult(
              failure = WearConversationFailure.PHONE_UNAVAILABLE,
            )
        val response = CompletableDeferred<WearMessage.Response>()
        pendingResponses[requestId] = response
        try {
          Tasks.await(
            messageClient.sendMessage(
              node.id,
              WearProtocol.REQUEST_PATH,
              WearProtocolCodec.encode(
                WearMessage.Request(
                  requestId = requestId,
                  method = method,
                  params = params,
                ),
              ),
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
          withTimeout(REQUEST_TIMEOUT_MILLIS) { response.await() }.toRpcResult(requestId)
        } finally {
          pendingResponses.remove(requestId)
        }
      }.getOrElse {
        WearRpcResult(
          failure = WearConversationFailure.PHONE_UNAVAILABLE,
        )
      }
    }

  private fun handleMessage(event: MessageEvent) {
    if (event.path != WearProtocol.RESPONSE_PATH) return
    val response =
      (WearProtocolCodec.decode(event.data) as? WearDecodeResult.Success)
        ?.message as? WearMessage.Response ?: return
    pendingResponses[response.requestId]?.complete(response)
  }

  private companion object {
    const val MESSAGE_PARAM = "message"
    const val SESSION_KEY_PARAM = "sessionKey"
    const val IDEMPOTENCY_KEY_PARAM = "idempotencyKey"
    const val LIMIT_PARAM = "limit"
    const val MAX_CHARS_PARAM = "maxChars"
    const val HISTORY_LIMIT = 20
    const val HISTORY_MAX_CHARS = 2_000
    const val REQUEST_TIMEOUT_SECONDS = 15L
    const val REQUEST_TIMEOUT_MILLIS = REQUEST_TIMEOUT_SECONDS * 1_000
  }
}

internal fun WearMessage.Response.toRpcResult(
  expectedRequestId: String,
): WearRpcResult {
  if (requestId != expectedRequestId) return WearRpcResult(failure = WearConversationFailure.INCOMPATIBLE)

  if (ok && error == null && result != null) return WearRpcResult(payload = result)

  return WearRpcResult(
    failure =
      when (error?.code?.lowercase()) {
        "phone_not_ready" -> WearConversationFailure.PHONE_NOT_READY
        "gateway_offline", "unavailable" -> WearConversationFailure.GATEWAY_OFFLINE
        "not_found" -> WearConversationFailure.NOT_FOUND
        "action_rejected" -> WearConversationFailure.ACTION_REJECTED
        "internal_error" -> WearConversationFailure.INTERNAL_ERROR
        else -> WearConversationFailure.INCOMPATIBLE
      },
  )
}

internal fun buildConversationSnapshot(
  status: JsonObject,
  sessions: JsonObject,
  history: JsonObject?,
  activeSessionKey: String?,
  generatedAtEpochMillis: Long,
): WearConversationSnapshot {
  val sessionRows = (sessions["sessions"] as? JsonArray).orEmpty()
  val projectedSessions =
    sessionRows.mapNotNull { element ->
      val row = element.objectOrNull() ?: return@mapNotNull null
      val key = row.string("key") ?: return@mapNotNull null
      WearSessionSummary(
        id = key,
        title = row.string("label") ?: row.string("displayName") ?: "Session",
        updatedAtEpochMillis = row.long("updatedAt") ?: row.long("lastActivityAt"),
        selected = key == activeSessionKey,
      )
    }
  val messages =
    ((history?.get("messages") as? JsonArray).orEmpty()).mapIndexedNotNull { index, element ->
      val row = element.objectOrNull() ?: return@mapIndexedNotNull null
      val role =
        when (row.string("role")?.lowercase()) {
          "user" -> WearChatRole.USER
          "assistant" -> WearChatRole.ASSISTANT
          "system", "custom" -> WearChatRole.SYSTEM
          else -> return@mapIndexedNotNull null
        }
      val text = row["content"].textContent().trim()
      if (text.isEmpty()) return@mapIndexedNotNull null
      WearChatMessage(
        id = row.string("id") ?: "${role.name.lowercase()}-$index",
        role = role,
        text = text,
        timestampEpochMillis = row.long("timestamp"),
      )
    }
  val inFlight = history?.get("inFlightRun").objectOrNull()
  val activeRow =
    sessionRows
      .mapNotNull(JsonElement::objectOrNull)
      .firstOrNull { row -> row.string("key") == activeSessionKey }

  return WearConversationSnapshot(
    generatedAtEpochMillis = generatedAtEpochMillis,
    gatewayState =
      if (status.boolean("connected") == true) {
        WearGatewayState.CONNECTED
      } else {
        WearGatewayState.DISCONNECTED
      },
    activeSessionId = activeSessionKey,
    sessions = projectedSessions,
    messages = messages,
    streamingAssistantText = inFlight?.string("text"),
    pendingRunCount = if (inFlight != null || activeRow?.boolean("hasActiveRun") == true) 1 else 0,
  )
}

private fun incompatible(): WearConversationClientResult = WearConversationClientResult(failure = WearConversationFailure.INCOMPATIBLE)

private fun JsonElement?.objectOrNull(): JsonObject? = this as? JsonObject

private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.boolean(name: String): Boolean? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun JsonObject.long(name: String): Long? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

private fun JsonElement?.textContent(): String =
  when (this) {
    is JsonPrimitive -> contentOrNull.orEmpty()
    is JsonArray ->
      mapNotNull { part ->
        when (part) {
          is JsonPrimitive -> part.contentOrNull
          is JsonObject -> part.string("text")
          else -> null
        }
      }.joinToString("\n")
    else -> ""
  }
