package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Test

class BuddySnapshotBuilderTest {
  @Test
  fun disconnectedMapsToFriendlyMessage() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = false,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.Disconnected, snapshot.state)
    assertEquals(BuddyMood.Confused, snapshot.agent.mood)
    assertEquals("我连不上 OpenClaw 了", snapshot.agent.message)
  }

  @Test
  fun pendingToolCallMapsToExecutingFallback() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 1,
        pendingToolCallCount = 1,
        pendingToolName = "read",
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.Executing, snapshot.state)
    assertEquals(BuddyMood.Focused, snapshot.agent.mood)
    assertEquals("我在处理 read", snapshot.agent.message)
  }

  @Test
  fun cameraConfirmationMapsToCameraPrompt() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        cameraConfirmationRequired = true,
      )

    assertEquals(BuddyState.NeedsConfirmation, snapshot.state)
    assertEquals("camera", snapshot.prompt?.kind)
    assertEquals("要我打开摄像头吗？", snapshot.prompt?.text)
  }

  @Test
  fun cameraHudMapsToVisionScanning() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = "Taking photo...",
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.VisionScanning, snapshot.state)
    assertEquals(BuddyMood.Curious, snapshot.agent.mood)
    assertEquals("让我看一下", snapshot.agent.message)
    assertEquals("scanning", snapshot.vision.mode)
  }

  @Test
  fun missingMicOrCameraMapsToPermissionRequired() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = true,
        micSending = true,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 1,
        cameraHudText = "Taking photo...",
        cameraEnabled = false,
        recordAudioGranted = false,
      )

    assertEquals(BuddyState.PermissionRequired, snapshot.state)
    assertEquals(BuddyMood.Confused, snapshot.agent.mood)
    assertEquals("我需要麦克风或摄像头权限", snapshot.agent.message)
    assertEquals(false, snapshot.vision.available)
  }

  @Test
  fun activeVoiceMapsToRecording() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = true,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 1,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.Recording, snapshot.state)
    assertEquals(BuddyMood.Attentive, snapshot.agent.mood)
    assertEquals("我在听", snapshot.agent.message)
  }

  @Test
  fun talkPlaybackOverridesActiveVoiceListening() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = true,
        micSending = false,
        talkSpeaking = true,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.Speaking, snapshot.state)
    assertEquals(BuddyMood.Happy, snapshot.agent.mood)
    assertEquals("我在回答", snapshot.agent.message)
  }

  @Test
  fun talkPlaybackMapsToAnsweringMessage() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = true,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
      )

    assertEquals(BuddyState.Speaking, snapshot.state)
    assertEquals(BuddyMood.Happy, snapshot.agent.mood)
    assertEquals("我在回答", snapshot.agent.message)
  }

  @Test
  fun gatewayAssistantReplyOverridesActiveVoiceListening() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = true,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Speaking,
          message = "当然可以，我会陪着你。",
        ),
      )

    assertEquals(BuddyState.Speaking, snapshot.state)
    assertEquals(BuddyMood.Happy, snapshot.agent.mood)
    assertEquals("当然可以，我会陪着你。", snapshot.agent.message)
  }

  @Test
  fun gatewayAgentThinkingMapsToThinking() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(phase = BuddyAgentActivityPhase.Thinking),
      )

    assertEquals(BuddyState.Thinking, snapshot.state)
    assertEquals(BuddyMood.Focused, snapshot.agent.mood)
    assertEquals("想一想", snapshot.agent.message)
  }

  @Test
  fun gatewayAgentWorkingMapsToExecuting() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Working,
          toolName = "read",
        ),
      )

    assertEquals(BuddyState.Executing, snapshot.state)
    assertEquals(BuddyMood.Focused, snapshot.agent.mood)
    assertEquals("我在处理 read", snapshot.agent.message)
  }

  @Test
  fun gatewayAgentErrorMapsToFriendlyMessage() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = true,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Error,
          message = "Nemo 刚才没想好，可以再说一次",
        ),
      )

    assertEquals(BuddyState.Error, snapshot.state)
    assertEquals(BuddyMood.Confused, snapshot.agent.mood)
    assertEquals("Nemo 刚才没想好，可以再说一次", snapshot.agent.message)
  }

  @Test
  fun gatewayAgentSpeakingMapsToSpeakingBubble() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 0,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Speaking,
          message = "可以，我陪你聊一会儿。",
        ),
      )

    assertEquals(BuddyState.Speaking, snapshot.state)
    assertEquals(BuddyMood.Happy, snapshot.agent.mood)
    assertEquals("可以，我陪你聊一会儿。", snapshot.agent.message)
  }

  @Test
  fun gatewayAgentWorkingOverridesOrdinaryPendingToolDisplay() {
    val snapshot =
      BuddySnapshotBuilder.build(
        connected = true,
        micListening = false,
        micSending = false,
        talkSpeaking = false,
        pendingRunCount = 0,
        pendingToolCallCount = 1,
        cameraHudText = null,
        cameraEnabled = true,
        recordAudioGranted = true,
        agentActivity = BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Working,
          toolName = "read",
        ),
      )

    assertEquals(BuddyState.Executing, snapshot.state)
    assertEquals("我在处理 read", snapshot.agent.message)
  }
}
