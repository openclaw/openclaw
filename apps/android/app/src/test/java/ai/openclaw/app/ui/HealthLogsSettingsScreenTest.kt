package ai.openclaw.app.ui

import ai.openclaw.app.VoiceCaptureMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthLogsSettingsScreenTest {
  @Test
  fun gatewayLogRawPreviewDoesNotSplitSurrogatePair() {
    val prefix = "a".repeat(3_999)

    assertEquals(prefix, gatewayLogRawPreview("${prefix}\uD83D\uDE00tail"))
  }

  @Test
  fun voiceReadinessUsesTypedCaptureMode() {
    assertTrue(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.ManualMic,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = false,
      ),
    )
  }

  @Test
  fun voiceReadinessIncludesTransientTalkActivity() {
    assertTrue(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.Off,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = true,
      ),
    )
  }

  @Test
  fun voiceReadinessIsFalseWhenTypedRuntimeIsInactive() {
    assertFalse(
      voiceRuntimeReady(
        voiceCaptureMode = VoiceCaptureMode.Off,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        talkAwaitingAgent = false,
      ),
    )
  }
}
