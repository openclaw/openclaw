package ai.openclaw.app.buddy

import ai.openclaw.app.VoiceCaptureMode
import org.junit.Assert.assertEquals
import org.junit.Test

class BuddyVoiceInputPolicyTest {
  @Test
  fun toggleFromOffStartsTalkMode() {
    assertEquals(VoiceCaptureMode.TalkMode, BuddyVoiceInputPolicy.nextMode(VoiceCaptureMode.Off))
  }

  @Test
  fun toggleFromManualMicStopsVoiceInput() {
    assertEquals(VoiceCaptureMode.Off, BuddyVoiceInputPolicy.nextMode(VoiceCaptureMode.ManualMic))
  }

  @Test
  fun toggleFromTalkModeStopsVoiceInput() {
    assertEquals(VoiceCaptureMode.Off, BuddyVoiceInputPolicy.nextMode(VoiceCaptureMode.TalkMode))
  }

  @Test
  fun permissionIsRequestedOnlyWhenStartingVoiceInput() {
    assertEquals(true, BuddyVoiceInputPolicy.shouldRequestPermission(VoiceCaptureMode.Off, hasRecordAudioPermission = false))
    assertEquals(false, BuddyVoiceInputPolicy.shouldRequestPermission(VoiceCaptureMode.Off, hasRecordAudioPermission = true))
    assertEquals(false, BuddyVoiceInputPolicy.shouldRequestPermission(VoiceCaptureMode.TalkMode, hasRecordAudioPermission = false))
    assertEquals(false, BuddyVoiceInputPolicy.shouldRequestPermission(VoiceCaptureMode.ManualMic, hasRecordAudioPermission = false))
  }
}
