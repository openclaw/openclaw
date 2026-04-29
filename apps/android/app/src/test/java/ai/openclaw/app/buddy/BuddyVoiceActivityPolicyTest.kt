package ai.openclaw.app.buddy

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuddyVoiceActivityPolicyTest {
  @Test
  fun recordingIncludesManualMicSendingAndTalkListening() {
    assertTrue(BuddyVoiceActivityPolicy.isRecording(micListening = true, micSending = false, talkModeListening = false))
    assertTrue(BuddyVoiceActivityPolicy.isRecording(micListening = false, micSending = true, talkModeListening = false))
    assertTrue(BuddyVoiceActivityPolicy.isRecording(micListening = false, micSending = false, talkModeListening = true))
    assertTrue(
      BuddyVoiceActivityPolicy.isRecording(
        micListening = false,
        micSending = false,
        talkModeListening = false,
        voiceInputActive = true,
      ),
    )
    assertFalse(BuddyVoiceActivityPolicy.isRecording(micListening = false, micSending = false, talkModeListening = false))
  }
}
