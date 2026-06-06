package ai.openclaw.app.voice

import java.util.Locale

internal object TalkPromptBuilder {
  fun build(
    transcript: String,
    interruptedAtSeconds: Double? = null,
  ): String {
    if (interruptedAtSeconds == null) return transcript

    val formatted = String.format(Locale.US, "%.1f", interruptedAtSeconds)
    return "Assistant speech interrupted at ${formatted}s.\n\n$transcript"
  }
}
