package ai.openclaw.app.buddy

object BuddySnapshotBuilder {
  fun build(
    connected: Boolean,
    micListening: Boolean,
    micSending: Boolean,
    talkSpeaking: Boolean,
    pendingRunCount: Int,
    pendingToolCallCount: Int,
    cameraHudText: String?,
    cameraEnabled: Boolean,
    recordAudioGranted: Boolean,
    cameraConfirmationRequired: Boolean = false,
  ): BuddySnapshot {
    val permissionRequired = !cameraEnabled || !recordAudioGranted
    val visionScanning = !cameraHudText.isNullOrBlank()
    val state =
      BuddyState.resolve(
        permissionRequired = permissionRequired,
        confirmationRequired = cameraConfirmationRequired || pendingToolCallCount > 0,
        recording = micListening || micSending,
        visionScanning = visionScanning,
        speaking = talkSpeaking,
        thinking = pendingRunCount > 0,
        connected = connected,
      )

    return when (state) {
      BuddyState.PermissionRequired ->
        BuddySnapshot(
          state = state,
          agent = BuddyAgent(mood = BuddyMood.Confused, message = "我需要麦克风或摄像头权限"),
          vision = BuddyVision(available = cameraEnabled),
        )
      BuddyState.NeedsConfirmation ->
        BuddySnapshot(
          state = state,
          agent =
            BuddyAgent(
              mood = BuddyMood.Attentive,
              message = if (cameraConfirmationRequired) "要我打开摄像头吗？" else "要我继续吗？",
            ),
          prompt =
            if (cameraConfirmationRequired) {
              BuddyPrompt(id = "camera-confirmation", kind = "camera", text = "要我打开摄像头吗？")
            } else {
              BuddyPrompt(id = "pending-tool-call", kind = "continue", text = "要我继续吗？")
            },
        )
      BuddyState.Recording ->
        BuddySnapshot(
          state = state,
          agent = BuddyAgent(mood = BuddyMood.Attentive, message = "我在听"),
        )
      BuddyState.VisionScanning ->
        BuddySnapshot(
          state = state,
          agent = BuddyAgent(mood = BuddyMood.Curious, message = "让我看一下"),
          vision = BuddyVision(available = true, mode = "scanning"),
        )
      BuddyState.Speaking ->
        BuddySnapshot(state = state, agent = BuddyAgent(mood = BuddyMood.Happy))
      BuddyState.Thinking ->
        BuddySnapshot(state = state, agent = BuddyAgent(mood = BuddyMood.Focused, message = "想一想"))
      BuddyState.Disconnected ->
        BuddySnapshot(
          state = state,
          agent = BuddyAgent(mood = BuddyMood.Confused, message = "我连不上 OpenClaw 了"),
        )
      else -> BuddySnapshot(state = state)
    }
  }
}
