package ai.openclaw.app.buddy

object BuddyVoiceActivityPolicy {
  fun isRecording(
    micListening: Boolean,
    micSending: Boolean,
    talkModeListening: Boolean,
    voiceInputActive: Boolean = false,
  ): Boolean = micListening || micSending || talkModeListening || voiceInputActive
}
