package ai.openclaw.app.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class IncomingCallStateTest {
  private val invite = IncomingCallInvite("f0a65f14-24e1-43f1-b3e0-fd415af7e59b", "agent:assistant:call-123", "Assistant", "Prepared briefing", 10_000)

  @Test
  fun `expired and excessively long invitations cannot ring`() {
    assertThrows(IllegalArgumentException::class.java) { invite.validate(10_000) }
    assertThrows(IllegalArgumentException::class.java) { invite.copy(expiresAtMs = 310_001).validate(10_000) }
    invite.copy(expiresAtMs = 310_000).validate(10_000)
  }

  @Test
  fun `canonical id session and bounded printable presentation are required`() {
    listOf(
      invite.copy(callId = "1-1-1-1-1"),
      invite.copy(sessionKey = "main"),
      invite.copy(sessionKey = "agent:assistant:private\ncontext"),
      invite.copy(callerName = "Caller\nAnswer now"),
      invite.copy(topic = "x".repeat(161)),
    ).forEach { candidate -> assertThrows(IllegalArgumentException::class.java) { candidate.validate(0) } }
    invite.validate(0)
  }

  @Test
  fun `call cannot become active before answer and terminal calls cannot resurrect`() {
    val ringing = IncomingCallState(invite, "gateway-one")
    assertEquals(ringing, transitionIncomingCall(ringing, IncomingCallStatus.Active))
    val connecting = transitionIncomingCall(ringing, IncomingCallStatus.Connecting)
    val active = transitionIncomingCall(connecting, IncomingCallStatus.Active)
    val ended = transitionIncomingCall(active, IncomingCallStatus.Ended)
    assertEquals(IncomingCallStatus.Active, active.status)
    assertEquals(ended, transitionIncomingCall(ended, IncomingCallStatus.Active))
    assertEquals(ended, transitionIncomingCall(ended, IncomingCallStatus.Ringing))
    val declined = transitionIncomingCall(ringing, IncomingCallStatus.Declined)
    assertEquals(declined, transitionIncomingCall(declined, IncomingCallStatus.Connecting))
  }
}
