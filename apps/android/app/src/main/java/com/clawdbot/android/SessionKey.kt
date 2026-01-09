package com.clawdbot.android

internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}
