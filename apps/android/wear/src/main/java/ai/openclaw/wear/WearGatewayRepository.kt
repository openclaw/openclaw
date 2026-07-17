package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

internal data class WearProxyStatus(
  val connected: Boolean,
  val detail: String,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearSession(
  val key: String,
  val title: String,
  val updatedAt: Long?,
  val hasActiveRun: Boolean,
  val phoneNodeId: String,
)

internal data class WearSessionList(
  val sessions: List<WearSession>,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearChatMessage(
  val id: String?,
  val role: String,
  val text: String,
  val timestamp: Long?,
)

internal data class WearTranscript(
  val sessionKey: String,
  val messages: List<WearChatMessage>,
  val activeRunId: String?,
  val activeText: String?,
  val eventSequence: Long?,
  val phoneNodeId: String,
  val eventStreamId: String? = null,
)

internal data class WearChatEvent(
  val sessionKey: String?,
  val runId: String?,
  val state: String?,
  val deltaText: String?,
  val replace: Boolean,
  val streamText: String?,
  val streamTextComplete: Boolean,
  val message: WearChatMessage?,
)

internal data class WearSendAttempt(
  val sessionKey: String,
  val message: String,
  val idempotencyKey: String,
  val phoneNodeId: String,
)

internal class WearSendAttemptTracker(
  private val newId: () -> String = { UUID.randomUUID().toString() },
) {
  private var ambiguousAttempt: WearSendAttempt? = null

  fun begin(
    sessionKey: String,
    message: String,
    phoneNodeId: String,
  ): WearSendAttempt {
    ambiguousAttempt
      ?.takeIf { it.sessionKey == sessionKey && it.message == message && it.phoneNodeId == phoneNodeId }
      ?.let { return it }
    ambiguousAttempt = null
    return WearSendAttempt(sessionKey, message, "wear-${newId()}", phoneNodeId)
  }

  fun markAmbiguous(attempt: WearSendAttempt) {
    ambiguousAttempt = attempt
  }

  fun markSucceeded(attempt: WearSendAttempt) {
    if (ambiguousAttempt == attempt) ambiguousAttempt = null
  }
}

internal class WearGatewayRepository(
  private val requester: WearRpcRequester,
) {
  suspend fun status(expectedNodeId: String? = null): WearProxyStatus {
    val response = requester.request(WearRpcMethod.ProxyStatus, buildJsonObject {}, expectedNodeId)
    val result = response.payload.asObject("proxy.status")
    return WearProxyStatus(
      connected = result.boolean("connected") ?: false,
      detail = result.string("status") ?: "Phone gateway unavailable",
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun sessions(expectedNodeId: String? = null): WearSessionList {
    val response =
      requester
        .request(
          WearRpcMethod.SessionsList,
          buildJsonObject { put("limit", 30) },
          expectedNodeId,
        )
    val result = response.payload.asObject("sessions.list")
    return WearSessionList(
      sessions =
        (result["sessions"] as? JsonArray)
          .orEmpty()
          .mapNotNull { parseSession(it, response.sourceNodeId) },
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun history(
    sessionKey: String,
    expectedNodeId: String,
  ): WearTranscript {
    val response =
      requester
        .request(
          WearRpcMethod.ChatHistory,
          buildJsonObject {
            put("sessionKey", sessionKey)
            put("limit", 20)
            put("maxChars", 2_000)
          },
          expectedNodeId,
        )
    val result = response.payload.asObject("chat.history")
    val inFlight = result["inFlightRun"] as? JsonObject
    return WearTranscript(
      sessionKey = result.string("sessionKey") ?: sessionKey,
      messages = (result["messages"] as? JsonArray).orEmpty().mapNotNull(::parseChatMessage),
      activeRunId = inFlight?.string("runId"),
      activeText = inFlight?.string("text"),
      eventStreamId = response.eventStreamId,
      eventSequence = response.eventSequence,
      phoneNodeId = response.sourceNodeId,
    )
  }

  suspend fun send(
    attempt: WearSendAttempt,
    requirePreferredPhone: Boolean = false,
  ) {
    requester.request(
      WearRpcMethod.ChatSend,
      buildJsonObject {
        put("sessionKey", attempt.sessionKey)
        put("message", attempt.message)
        put("idempotencyKey", attempt.idempotencyKey)
      },
      attempt.phoneNodeId,
      requirePreferredNode = requirePreferredPhone,
    )
  }

  suspend fun abort(
    sessionKey: String,
    runId: String?,
    phoneNodeId: String,
  ) {
    requester.request(
      WearRpcMethod.ChatAbort,
      buildJsonObject {
        put("sessionKey", sessionKey)
        runId?.let { put("runId", it) }
      },
      phoneNodeId,
      requirePreferredNode = true,
    )
  }

  suspend fun startRealtimeTalk(
    sessionKey: String,
    attemptId: String,
    language: String?,
    phoneNodeId: String,
  ): WearRealtimeTalkSnapshot {
    val response =
      requester.request(
        WearRpcMethod.TalkStart,
        buildJsonObject {
          put("sessionKey", sessionKey)
          put("attemptId", attemptId)
          language?.let { put("language", it) }
        },
        phoneNodeId,
        requirePreferredNode = true,
      )
    return WearRealtimeTalkCodec.decode(response.payload)
  }

  suspend fun stopRealtimeTalk(
    phoneNodeId: String,
    attemptId: String,
  ): WearRealtimeTalkSnapshot {
    val response =
      requester.request(
        WearRpcMethod.TalkStop,
        buildJsonObject { put("attemptId", attemptId) },
        phoneNodeId,
        requirePreferredNode = true,
      )
    return WearRealtimeTalkCodec.decode(response.payload)
  }
}

internal fun parseWearChatEvent(payload: JsonElement?): WearChatEvent? {
  val source = payload as? JsonObject ?: return null
  return WearChatEvent(
    sessionKey = source.string("sessionKey"),
    runId = source.string("runId"),
    state = source.string("state"),
    deltaText = source.string("deltaText"),
    replace = source.boolean("replace") ?: false,
    streamText = source.string("streamText"),
    streamTextComplete = source.boolean("streamTextComplete") ?: false,
    message = parseChatMessage(source["message"]),
  )
}

private fun parseSession(
  element: JsonElement,
  phoneNodeId: String,
): WearSession? {
  val source = element as? JsonObject ?: return null
  val key = source.string("key") ?: return null
  val title =
    source.string("displayName")
      ?: source.string("label")
      ?: key.substringAfterLast(':').ifBlank { "Session" }
  return WearSession(
    key = key,
    title = title,
    updatedAt = source.long("updatedAt") ?: source.long("lastActivityAt"),
    hasActiveRun = source.boolean("hasActiveRun") ?: false,
    phoneNodeId = phoneNodeId,
  )
}

internal fun parseChatMessage(element: JsonElement?): WearChatMessage? {
  val source = element as? JsonObject ?: return null
  val role = source.string("role") ?: return null
  val text = contentText(source["content"])
  if (text.isBlank()) return null
  return WearChatMessage(
    id = source.string("id"),
    role = role,
    text = text,
    timestamp = source.long("timestamp"),
  )
}

private fun contentText(element: JsonElement?): String =
  when (element) {
    is JsonPrimitive -> element.contentOrNull.orEmpty()
    is JsonArray ->
      element
        .mapNotNull { part ->
          when (part) {
            is JsonPrimitive -> part.contentOrNull
            is JsonObject -> part.string("text")
            else -> null
          }
        }.filter { it.isNotBlank() }
        .joinToString("\n")
    else -> ""
  }

private fun JsonElement.asObject(method: String): JsonObject = this as? JsonObject ?: throw WearProxyException("invalid_response", "$method returned invalid data")

private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.boolean(name: String): Boolean? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun JsonObject.long(name: String): Long? = (this[name] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
