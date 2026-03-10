package ai.openclaw.app

internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}

internal fun isCanonicalMainSessionKey(raw: String?): Boolean {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return false
  if (trimmed == "global") return true
  return trimmed.startsWith("agent:")
}

internal fun shouldReplaceMainSessionKey(current: String?, candidate: String?): Boolean {
  val next = candidate?.trim().orEmpty()
  if (next.isEmpty()) return false
  return next != current?.trim().orEmpty()
}
