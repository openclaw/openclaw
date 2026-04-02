package ai.openclaw.app.chat

/**
 * Mirrors shared `TalkPromptBuilder.displayText` (OpenClawKit / Swift): show only the spoken transcript
 * in chat UI for Talk Mode user messages, not the system instructions or gateway System: lines.
 */
object TalkPromptDisplay {
  /** @param prompt Full user message text as stored/sent for the turn. */
  fun displayTextFromPrompt(prompt: String): String {
    val trimmed = prompt.trim()
    if (!trimmed.contains("Talk Mode active.")) {
      return prompt
    }

    val lines = trimmed.lines()
    var contentStart = 0
    for (i in lines.indices) {
      val stripped = lines[i].trim()
      if (
        stripped.isEmpty() ||
        stripped.startsWith("System:") ||
        stripped.startsWith("System (untrusted)")
      ) {
        contentStart = i + 1
      } else {
        break
      }
    }
    val withoutSystemLines = lines.drop(contentStart).joinToString("\n").trim()
    if (!withoutSystemLines.contains("Talk Mode active.")) {
      return prompt
    }

    val sep = "\n\n"
    val idx = withoutSystemLines.indexOf(sep)
    if (idx < 0) {
      return prompt
    }

    val before = withoutSystemLines.substring(0, idx)
    if (!before.contains("Talk Mode active.")) {
      return prompt
    }

    return withoutSystemLines.substring(idx + sep.length).trim()
  }
}
