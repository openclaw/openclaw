package ai.openclaw.app.buddy

enum class BuddyState {
  Idle,
  Listening,
  WakeDetected,
  Recording,
  Thinking,
  Speaking,
  Executing,
  NeedsConfirmation,
  VisionScanning,
  Disconnected,
  PermissionRequired,
  PowerSaving;

  companion object {
    fun resolve(
      permissionRequired: Boolean,
      confirmationRequired: Boolean,
      recording: Boolean,
      visionScanning: Boolean,
      speaking: Boolean,
      thinking: Boolean,
      connected: Boolean,
    ): BuddyState =
      when {
        permissionRequired -> PermissionRequired
        confirmationRequired -> NeedsConfirmation
        recording -> Recording
        visionScanning -> VisionScanning
        speaking -> Speaking
        thinking -> Thinking
        !connected -> Disconnected
        else -> Listening
      }
  }
}

enum class BuddyMood {
  Calm,
  Attentive,
  Focused,
  Happy,
  Curious,
  Confused,
  Tired,
}

data class BuddyAgent(
  val name: String = "Nemo",
  val mood: BuddyMood = BuddyMood.Calm,
  val message: String? = null,
)

data class BuddyVoice(
  val mode: String = "listening",
  val wakeWord: String = "NemoNemo",
)

data class BuddyVision(
  val available: Boolean = true,
  val mode: String = "idle",
  val requiresConsent: Boolean = false,
)

data class BuddyPrompt(
  val id: String,
  val kind: String,
  val text: String,
)

data class BuddySnapshot(
  val state: BuddyState,
  val agent: BuddyAgent = BuddyAgent(),
  val voice: BuddyVoice = BuddyVoice(),
  val vision: BuddyVision = BuddyVision(),
  val prompt: BuddyPrompt? = null,
) {
  companion object {
    fun listening(): BuddySnapshot = BuddySnapshot(state = BuddyState.Listening)
  }
}
