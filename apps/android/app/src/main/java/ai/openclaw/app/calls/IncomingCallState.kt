package ai.openclaw.app.calls

import java.util.UUID

internal data class IncomingCallInvite(
  val callId: String,
  val sessionKey: String,
  val callerName: String,
  val topic: String,
  val expiresAtMs: Long,
) {
  fun validate(now: Long) {
    require(runCatching { UUID.fromString(callId).toString() == callId }.getOrDefault(false)) { "callId must be a canonical UUID" }
    require(Regex("agent:[a-z0-9][a-z0-9_-]{0,63}:[^\\s]{1,200}").matches(sessionKey)) { "sessionKey must be a canonical agent session" }
    require(callerName.isNotBlank() && callerName.length <= 80 && callerName.none(Char::isISOControl)) { "callerName must contain 1–80 printable characters" }
    require(topic.length <= 160 && topic.none(Char::isISOControl)) { "topic must contain at most 160 printable characters" }
    require(expiresAtMs > now && expiresAtMs - now <= 300_000) { "Invitation must expire within 300 seconds" }
  }
}

internal enum class IncomingCallStatus {
  Ringing,
  Connecting,
  Active,
  Declined,
  Ended,
  Missed,
  Error,
  ;

  val isTerminal: Boolean get() = this in setOf(Declined, Ended, Missed, Error)
}

internal data class IncomingCallState(
  val invite: IncomingCallInvite,
  val gatewayId: String,
  val status: IncomingCallStatus = IncomingCallStatus.Ringing,
  val detail: String? = null,
)

/** Explicit transition owner shared by local UI and remote commands. Terminal calls never reopen. */
internal fun transitionIncomingCall(
  state: IncomingCallState,
  next: IncomingCallStatus,
  detail: String? = null,
): IncomingCallState {
  val allowed =
    when (state.status) {
      IncomingCallStatus.Ringing -> next in setOf(IncomingCallStatus.Connecting, IncomingCallStatus.Declined, IncomingCallStatus.Missed, IncomingCallStatus.Ended, IncomingCallStatus.Error)
      IncomingCallStatus.Connecting -> next in setOf(IncomingCallStatus.Active, IncomingCallStatus.Ended, IncomingCallStatus.Error)
      IncomingCallStatus.Active -> next in setOf(IncomingCallStatus.Ended, IncomingCallStatus.Error)
      else -> false
    }
  return if (allowed) state.copy(status = next, detail = detail?.take(240)) else state
}
