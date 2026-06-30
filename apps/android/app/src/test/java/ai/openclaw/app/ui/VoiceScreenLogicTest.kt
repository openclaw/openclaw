package ai.openclaw.app.ui

import ai.openclaw.app.GatewayTalkSetupRow
import ai.openclaw.app.VoiceCaptureMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceScreenLogicTest {
  @Test
  fun voiceAttentionStatusKeepsFailedTalkStartVisibleAfterModeStops() {
    val attention =
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: Error: Realtime voice provider \"openai\" is not configured",
        voiceCaptureMode = VoiceCaptureMode.Off,
        micEnabled = false,
        micIsSending = false,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
      )

    assertEquals("Realtime voice provider is not configured.", attention)
    assertEquals(
      attention,
      voiceStatusLabel(
        gatewayStatus = "Online",
        voiceCaptureMode = VoiceCaptureMode.Off,
        micStatusText = "Mic off",
        micQueuedMessages = 0,
        micIsSending = false,
        talkModeListening = false,
        talkModeSpeaking = false,
        voiceAttentionStatus = attention,
      ),
    )
  }

  @Test
  fun voiceAttentionStatusKeepsRelayFailureVisibleAfterTalkAutoStops() {
    val attention =
      voiceAttentionStatus(
        talkModeStatusText = "Talk failed: provider closed realtime relay",
        voiceCaptureMode = VoiceCaptureMode.Off,
        micEnabled = false,
        micIsSending = false,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
      )

    assertEquals("provider closed realtime relay", attention)
  }

  @Test
  fun voiceAttentionStatusDoesNotOverrideActiveTalkState() {
    assertNull(
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: provider unavailable",
        voiceCaptureMode = VoiceCaptureMode.TalkMode,
        micEnabled = false,
        micIsSending = false,
        talkModeEnabled = true,
        talkModeListening = false,
        talkModeSpeaking = false,
      ),
    )
  }

  @Test
  fun voiceAttentionStatusDoesNotOverrideDictationState() {
    assertNull(
      voiceAttentionStatus(
        talkModeStatusText = "Start failed: provider unavailable",
        voiceCaptureMode = VoiceCaptureMode.ManualMic,
        micEnabled = true,
        micIsSending = false,
        talkModeEnabled = false,
        talkModeListening = false,
        talkModeSpeaking = false,
      ),
    )
  }

  @Test
  fun voiceRuntimeAttentionStatusSanitizesTranscriptionProviderFailures() {
    assertEquals(
      "Realtime transcription provider is not configured.",
      voiceRuntimeAttentionStatus("Transcription unavailable: UNAVAILABLE: Error: No realtime transcription provider registered"),
    )
  }

  @Test
  fun voiceRuntimeProviderIssueKeepsReadableDetailsAndRedactsSecrets() {
    val issue =
      voiceRuntimeProviderIssue(
        "Transcription unavailable: UNAVAILABLE: Error: OpenAI 404 invalid_request_error: model not found Authorization: Bearer sk-testsecret123456 token=abc123 {\"authorization\":\"Bearer ghp_test123456\",\"apiKey\":\"AIzaTestSecret123\"} url=https://api.example.test/v1?key=AIzaStandalone123456789&client_secret=secret123 aws=AKIA1234567890ABCDEF",
      )

    assertEquals("OpenAI provider request failed.", issue?.summary)
    assertEquals(
      "OpenAI 404 invalid_request_error: model not found Authorization: Bearer [redacted] token=[redacted] {\"authorization\":\"Bearer [redacted]\",\"apiKey\":\"[redacted]\"} url=https://api.example.test/v1?key=[redacted]&client_secret=[redacted] aws=aws_[redacted]",
      issue?.details,
    )
  }

  @Test
  fun voiceActionAllowsStartWhenCatalogReadinessIsUnknown() {
    val unavailableRow = GatewayTalkSetupRow.unavailable(title = "Realtime Talk", reason = "Gateway talk catalog not loaded")

    assertEquals(false, voiceActionNeedsSetup(gatewayReady = true, setupRow = unavailableRow))
    assertEquals(true, voiceActionCanStart(gatewayReady = true, setupRow = unavailableRow))
  }

  @Test
  fun voiceActionRoutesConfirmedUnconfiguredProviderToSetup() {
    val needsSetupRow =
      GatewayTalkSetupRow(
        title = "Realtime Talk",
        subtitle = "Configure OpenAI Realtime on the Gateway.",
        statusText = "Needs setup",
        ready = false,
        setupKnown = true,
      )

    assertEquals(true, voiceActionNeedsSetup(gatewayReady = true, setupRow = needsSetupRow))
    assertEquals(false, voiceActionCanStart(gatewayReady = true, setupRow = needsSetupRow))
  }
}
