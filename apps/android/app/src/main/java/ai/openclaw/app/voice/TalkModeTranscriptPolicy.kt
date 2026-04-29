package ai.openclaw.app.voice

object TalkModeTranscriptPolicy {
  fun resolveCommand(
    transcript: String,
    requireWakeWord: Boolean,
    wakeWords: List<String>,
  ): String? {
    val trimmed = transcript.trim()
    if (trimmed.isEmpty()) return null
    return if (requireWakeWord) {
      VoiceWakeCommandExtractor.extractCommand(trimmed, wakeWords)
    } else {
      trimmed
    }
  }
}
