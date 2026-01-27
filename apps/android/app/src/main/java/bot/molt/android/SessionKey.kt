package bot.molt.android

internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim().orEmpty()
  return trimmed.ifEmpty { "main" }
}

internal fun isCanonicalMainSessionKey(raw: String?): Boolean {
  val trimmed = raw?.trim().orEmpty()
  return trimmed.equals("main", ignoreCase = true)
}
