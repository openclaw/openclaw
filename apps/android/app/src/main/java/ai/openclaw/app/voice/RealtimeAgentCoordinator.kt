package ai.openclaw.app.voice

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal data class RealtimeAgentSession(
  val relaySessionId: String,
  val sessionKey: String,
)

private data class RealtimeAgentRun(
  val callId: String,
  val session: RealtimeAgentSession,
)

private data class RealtimeAgentCompletion(
  val sessionKey: String?,
  val state: String,
  val message: JsonElement?,
)

internal data class RealtimeAgentUnhandledCompletion(
  val sessionKey: String?,
  val runId: String,
  val state: String,
  val message: JsonElement?,
)

private class RealtimeAgentPendingCall(
  val callId: String,
  val session: RealtimeAgentSession,
)

/**
 * Owns Android's provider-tool-call lifecycle for every realtime Talk surface.
 * Replacing the session cancels session-owned work while retaining bounded
 * correlation for late Gateway responses; transport replacement cancels both.
 */
internal class RealtimeAgentCoordinator(
  parentScope: CoroutineScope,
  private val requestGateway: suspend (method: String, paramsJson: String?, timeoutMs: Long) -> String,
  private val onWorking: (RealtimeAgentSession) -> Unit = {},
  private val onError: (RealtimeAgentSession, String) -> Unit = { _, message ->
    Log.w(TAG, message)
  },
  private val onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
  private val maxCachedCompletions: Int = MAX_CACHED_COMPLETIONS,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val lock = Any()
  private val parentContext = parentScope.coroutineContext
  private val parentJob = parentContext[Job]
  private val correlationScope = CoroutineScope(parentContext)
  private val correlationJobs = LinkedHashSet<Job>()
  private var activeSession: RealtimeAgentSession? = null
  private var sessionScope: CoroutineScope? = null
  private val runs = LinkedHashMap<String, RealtimeAgentRun>()
  private val pendingCalls = LinkedHashSet<RealtimeAgentPendingCall>()
  private val earlyCompletions = LinkedHashMap<String, RealtimeAgentCompletion>()

  // A replacement can reuse the same chat session key, so keep known old run IDs
  // long enough to consume delayed finals instead of leaking them into normal Talk TTS.
  private val retiredRunIds = LinkedHashSet<String>()

  init {
    require(maxCachedCompletions > 0)
  }

  fun beginSession(session: RealtimeAgentSession) {
    synchronized(lock) {
      if (activeSession == session) return
      clearLocked()
      activeSession = session
      sessionScope = CoroutineScope(parentContext + SupervisorJob(parentJob))
    }
  }

  fun endSession(expectedRelaySessionId: String? = null) {
    synchronized(lock) {
      if (expectedRelaySessionId != null && activeSession?.relaySessionId != expectedRelaySessionId) return
      clearLocked()
    }
  }

  /** Cancels requests that must not survive a Gateway or account replacement. */
  fun resetTransport() {
    val jobs =
      synchronized(lock) {
        clearLocked()
        pendingCalls.clear()
        earlyCompletions.clear()
        correlationJobs.toList().also { correlationJobs.clear() }
      }
    jobs.forEach { it.cancel() }
  }

  fun handleToolCall(
    callId: String,
    name: String,
    args: JsonElement?,
    forced: Boolean,
  ): Boolean {
    val sessionAndScope =
      synchronized(lock) {
        val session = activeSession ?: return false
        val scope = sessionScope ?: return false
        session to scope
      }
    val (session, scope) = sessionAndScope
    when (name) {
      AGENT_CONSULT_TOOL -> {
        // Keep the bounded Gateway request alive across replacement so its run ID
        // can still be quarantined if the old agent finishes late.
        val job =
          correlationScope.launch(start = CoroutineStart.LAZY) {
            runConsult(session, callId, args, forced)
          }
        job.invokeOnCompletion { synchronized(lock) { correlationJobs.remove(job) } }
        synchronized(lock) {
          if (activeSession == session) {
            correlationJobs += job
            job.start()
          } else {
            job.cancel()
          }
        }
      }
      AGENT_CONTROL_TOOL -> scope.launch { runControl(session, callId, args) }
      else -> scope.launch { submitError(session, callId, "unsupported realtime Talk tool: $name") }
    }
    return true
  }

  fun handleChatEvent(
    sessionKey: String?,
    runId: String,
    state: String,
    message: JsonElement?,
  ): Boolean {
    if (state !in TERMINAL_STATES) return false
    val completion = RealtimeAgentCompletion(sessionKey = sessionKey, state = state, message = message)
    var dispatch: Pair<RealtimeAgentRun, RealtimeAgentCompletion>? = null
    var unhandled: RealtimeAgentUnhandledCompletion? = null
    val handled =
      synchronized(lock) {
        if (runId in retiredRunIds) return@synchronized true
        val session = activeSession
        if (session == null) {
          if (!hasPendingCallForSessionLocked(sessionKey)) {
            false
          } else {
            unhandled = cacheEarlyCompletionLocked(runId, completion)
            true
          }
        } else if (sessionKey != null && sessionKey != session.sessionKey) {
          false
        } else {
          val run = runs.remove(runId)
          if (run != null) {
            retireRunLocked(runId)
            if (run.session == session) {
              dispatch = run to completion
            }
            true
          } else if (!hasPendingCallForSessionLocked(sessionKey)) {
            false
          } else {
            unhandled = cacheEarlyCompletionLocked(runId, completion)
            true
          }
        }
      }
    dispatch?.let { dispatchCompletion(it.first, it.second) }
    unhandled?.let(onUnhandledCompletion)
    return handled
  }

  private suspend fun runConsult(
    session: RealtimeAgentSession,
    callId: String,
    args: JsonElement?,
    forced: Boolean,
  ) {
    val pendingCall = RealtimeAgentPendingCall(callId = callId, session = session)
    synchronized(lock) {
      if (activeSession != session) return
      pendingCalls += pendingCall
    }
    try {
      if (forced) submitWorking(session, callId)
      if (!isActive(session)) return
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("callId", JsonPrimitive(callId))
          put("name", JsonPrimitive(AGENT_CONSULT_TOOL))
          put("relaySessionId", JsonPrimitive(session.relaySessionId))
          if (args != null) put("args", args)
        }
      val response = requestGateway("talk.client.toolCall", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val runId = parseRunId(response)
      if (runId.isNullOrBlank()) {
        submitError(session, callId, "tool call returned no run id")
        return
      }
      val stillActive = synchronized(lock) { activeSession == session }
      if (!stillActive) {
        synchronized(lock) {
          earlyCompletions.remove(runId)
          retireRunLocked(runId)
        }
        return
      }
      // Surface callbacks may take their own lifecycle locks, so never invoke one
      // while holding the coordinator lock. A final racing this callback is cached
      // against the pending call and consumed immediately after registration.
      onWorking(session)
      val completion =
        synchronized(lock) {
          if (activeSession != session) {
            earlyCompletions.remove(runId)
            retireRunLocked(runId)
            return
          }
          earlyCompletions.remove(runId).also { cached ->
            if (cached == null) {
              runs[runId] = RealtimeAgentRun(callId = callId, session = session)
            } else {
              retireRunLocked(runId)
            }
          }
        }
      if (completion != null) {
        dispatchCompletion(RealtimeAgentRun(callId = callId, session = session), completion)
      }
    } catch (err: TimeoutCancellationException) {
      submitError(session, callId, "tool call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "tool call failed"
      onError(session, "realtime toolCall failed: $message")
      submitError(session, callId, message)
    } finally {
      val unhandled =
        synchronized(lock) {
          val removed = pendingCalls.remove(pendingCall)
          if (removed && pendingCalls.isEmpty()) {
            earlyCompletions
              .map { (runId, completion) -> completion.toUnhandled(runId) }
              .also { earlyCompletions.clear() }
          } else {
            emptyList()
          }
        }
      unhandled.forEach(onUnhandledCompletion)
    }
  }

  private suspend fun runControl(
    session: RealtimeAgentSession,
    callId: String,
    args: JsonElement?,
  ) {
    try {
      val argsObject = args as? JsonObject
      val text =
        argsObject
          ?.get("text")
          .asStringOrNull()
          ?.trim()
          .orEmpty()
      val mode =
        argsObject
          ?.get("mode")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      val params =
        buildJsonObject {
          put("sessionId", JsonPrimitive(session.relaySessionId))
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("text", JsonPrimitive(text.ifEmpty { "status" }))
          if (mode != null) put("mode", JsonPrimitive(mode))
        }
      val response = requestGateway("talk.session.steer", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val result = runCatching { json.parseToJsonElement(response) as? JsonObject }.getOrNull()
      if (result == null) {
        submitError(session, callId, "control call returned no result")
      } else {
        submitResult(session, callId, result)
      }
    } catch (err: TimeoutCancellationException) {
      submitError(session, callId, "control call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "control call failed"
      onError(session, "realtime control failed: $message")
      submitError(session, callId, message)
    }
  }

  private fun dispatchCompletion(
    run: RealtimeAgentRun,
    completion: RealtimeAgentCompletion,
  ) {
    val scope = synchronized(lock) { sessionScope.takeIf { activeSession == run.session } } ?: return
    scope.launch {
      when (completion.state) {
        "final" -> {
          val text = ChatEventText.assistantTextFromMessage(completion.message).orEmpty()
          submitResult(
            run.session,
            run.callId,
            buildJsonObject { put("text", JsonPrimitive(text)) },
          )
        }
        "aborted", "error" -> submitError(run.session, run.callId, completion.state)
      }
    }
  }

  private suspend fun submitWorking(
    session: RealtimeAgentSession,
    callId: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result =
        buildJsonObject {
          put("status", JsonPrimitive("working"))
          put("tool", JsonPrimitive(AGENT_CONSULT_TOOL))
          put(
            "message",
            JsonPrimitive(
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
            ),
          )
        },
      options = buildJsonObject { put("willContinue", JsonPrimitive(true)) },
    )
  }

  private suspend fun submitError(
    session: RealtimeAgentSession,
    callId: String,
    message: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result = buildJsonObject { put("error", JsonPrimitive(message)) },
    )
  }

  private suspend fun submitResult(
    session: RealtimeAgentSession,
    callId: String,
    result: JsonObject,
    options: JsonObject? = null,
  ) {
    if (!isActive(session)) return
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(session.relaySessionId))
        put("callId", JsonPrimitive(callId))
        put("result", result)
        if (options != null) put("options", options)
      }
    try {
      requestGateway("talk.session.submitToolResult", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
    } catch (err: TimeoutCancellationException) {
      onError(session, "realtime submitToolResult timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      onError(session, "realtime submitToolResult failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun parseRunId(payloadJson: String): String? =
    runCatching {
      (json.parseToJsonElement(payloadJson) as? JsonObject)
        ?.get("runId")
        .asStringOrNull()
    }.getOrNull()

  private fun isActive(session: RealtimeAgentSession): Boolean = synchronized(lock) { activeSession == session }

  private fun clearLocked() {
    runs.keys.forEach(::retireRunLocked)
    activeSession = null
    sessionScope?.cancel()
    sessionScope = null
    runs.clear()
    if (pendingCalls.isEmpty()) {
      earlyCompletions.clear()
    }
  }

  private fun hasPendingCallForSessionLocked(
    sessionKey: String?,
  ): Boolean = pendingCalls.any { sessionKey == null || it.session.sessionKey == sessionKey }

  private fun cacheEarlyCompletionLocked(
    runId: String,
    completion: RealtimeAgentCompletion,
  ): RealtimeAgentUnhandledCompletion? {
    earlyCompletions[runId] = completion
    if (earlyCompletions.size <= maxCachedCompletions) return null
    val evictedRunId = earlyCompletions.keys.first()
    val evicted = earlyCompletions.remove(evictedRunId) ?: return null
    return evicted.toUnhandled(evictedRunId)
  }

  private fun retireRunLocked(runId: String) {
    retiredRunIds += runId
    while (retiredRunIds.size > maxCachedCompletions) {
      retiredRunIds.remove(retiredRunIds.first())
    }
  }

  private companion object {
    const val TAG = "RealtimeAgent"
    const val AGENT_CONSULT_TOOL = "openclaw_agent_consult"
    const val AGENT_CONTROL_TOOL = "openclaw_agent_control"
    const val TOOL_CALL_TIMEOUT_MILLIS = 15_000L
    const val MAX_CACHED_COMPLETIONS = 128
    val TERMINAL_STATES = setOf("final", "aborted", "error")
  }
}

private fun RealtimeAgentCompletion.toUnhandled(runId: String) =
  RealtimeAgentUnhandledCompletion(
    sessionKey = sessionKey,
    runId = runId,
    state = state,
    message = message,
  )

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
