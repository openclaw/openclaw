package com.clawdis.android.ui.chat

import com.clawdis.android.chat.ChatSessionEntry

private const val MAIN_SESSION_KEY = "main"
private const val RECENT_WINDOW_MS = 24 * 60 * 60 * 1000L

fun resolveSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> {
  val current = currentSessionKey.trim()
  val cutoff = nowMs - RECENT_WINDOW_MS
  val sorted = sessions.sortedByDescending { it.updatedAtMs ?: 0L }
  val recent = mutableListOf<ChatSessionEntry>()
  val seen = mutableSetOf<String>()
  for (entry in sorted) {
    if (!seen.add(entry.key)) continue
    if ((entry.updatedAtMs ?: 0L) < cutoff) continue
    recent.add(entry)
  }

  val result = mutableListOf<ChatSessionEntry>()
  val included = mutableSetOf<String>()
  val mainEntry = sorted.firstOrNull { it.key == MAIN_SESSION_KEY }
  if (mainEntry != null) {
    result.add(mainEntry)
    included.add(MAIN_SESSION_KEY)
  } else if (current == MAIN_SESSION_KEY) {
    result.add(ChatSessionEntry(key = MAIN_SESSION_KEY, updatedAtMs = null))
    included.add(MAIN_SESSION_KEY)
  }

  for (entry in recent) {
    if (included.add(entry.key)) {
      result.add(entry)
    }
  }

  if (current.isNotEmpty() && !included.contains(current)) {
    result.add(ChatSessionEntry(key = current, updatedAtMs = null))
  }

  return result
}
