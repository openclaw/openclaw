package ai.openclaw.app.buddy

object BuddyQuickMessage {
  const val MAX_LENGTH = 500

  fun normalize(text: String): String? {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return null
    return trimmed.take(MAX_LENGTH)
  }
}
