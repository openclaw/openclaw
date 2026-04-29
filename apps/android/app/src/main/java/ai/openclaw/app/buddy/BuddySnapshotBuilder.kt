package ai.openclaw.app.buddy

object BuddySnapshotBuilder {
  fun build(
    connected: Boolean,
    micListening: Boolean,
    micSending: Boolean,
    talkSpeaking: Boolean,
    pendingRunCount: Int,
    pendingToolCallCount: Int,
    pendingToolName: String? = null,
    cameraHudText: String?,
    cameraEnabled: Boolean,
    recordAudioGranted: Boolean,
    cameraConfirmationRequired: Boolean = false,
    agentActivity: BuddyAgentActivity = BuddyAgentActivity(),
  ): BuddySnapshot {
    val permissionRequired = !cameraEnabled || !recordAudioGranted
    val visionScanning = !cameraHudText.isNullOrBlank()
    val agentThinking = agentActivity.phase == BuddyAgentActivityPhase.Thinking
    val agentSpeaking = agentActivity.phase == BuddyAgentActivityPhase.Speaking
    val agentWorking = agentActivity.phase == BuddyAgentActivityPhase.Working
    val agentError = agentActivity.phase == BuddyAgentActivityPhase.Error
    val toolWorking = agentWorking || pendingToolCallCount > 0
    val voiceRecording = (micListening || micSending) && !talkSpeaking && !agentSpeaking
    val state =
      if (agentError) {
        BuddyState.Error
      } else {
        BuddyState.resolve(
          permissionRequired = permissionRequired,
          confirmationRequired = cameraConfirmationRequired,
          recording = voiceRecording,
          visionScanning = visionScanning,
          speaking = talkSpeaking || agentSpeaking,
          executing = toolWorking,
          thinking = pendingRunCount > 0 || agentThinking,
          connected = connected,
        )
      }

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
        BuddySnapshot(
          state = state,
          agent =
            BuddyAgent(
              mood = BuddyMood.Happy,
              message = agentActivity.message?.trim()?.takeIf { it.isNotEmpty() } ?: "我在回答",
            ),
        )
      BuddyState.Executing ->
        BuddySnapshot(
          state = state,
          agent =
            BuddyAgent(
              mood = BuddyMood.Focused,
              message =
                (agentActivity.toolName ?: pendingToolName)
                  ?.trim()
                  ?.takeIf { it.isNotEmpty() }
                  ?.let { "我在处理 $it" }
                ?: "我在处理",
            ),
        )
      BuddyState.Error ->
        BuddySnapshot(
          state = state,
          agent =
            BuddyAgent(
              mood = BuddyMood.Confused,
              message = agentActivity.message?.trim()?.takeIf { it.isNotEmpty() } ?: "Nemo 刚才没想好，可以再说一次",
            ),
        )
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
