package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import java.util.Locale

private val G_AGENT_REGEX = Regex("""(?:^|[:/])g-agent-([a-z0-9_]+)(?:-|$)""", RegexOption.IGNORE_CASE)
private val CHANNEL_LABELS =
  mapOf(
    "bluebubbles" to "iMessage",
    "telegram" to "Telegram",
    "discord" to "Discord",
    "signal" to "Signal",
    "slack" to "Slack",
    "whatsapp" to "WhatsApp",
    "matrix" to "Matrix",
    "email" to "Email",
    "sms" to "SMS",
  )

data class ChatAgentChoice(
  val id: String,
  val label: String,
  val sessionKey: String,
)

data class ChatSessionOptionGroup(
  val id: String,
  val label: String,
  val primarySessionKey: String,
  val sessions: List<ChatSessionEntry>,
)

/**
 * Derive a human-friendly label from a raw session key.
 */
fun friendlySessionName(key: String): String {
  val trimmed = key.trim()
  if (trimmed.isEmpty()) return key

  resolveCronSessionName(trimmed)?.let { return it }
  resolveStructuredChannelSessionName(trimmed)?.let { return it }
  resolveAgentSpecialSessionName(trimmed)?.let { return it }
  resolveLegacyChannelSessionName(trimmed)?.let { return it }

  if (trimmed == "main" || trimmed == "agent:main:main") return "Main"
  resolveSubagentSessionName(trimmed)?.let { return it }

  val stripped = trimmed.substringAfterLast(':')
  val cleaned = if (stripped.startsWith("g-")) stripped.removePrefix("g-") else stripped
  val words =
    cleaned
      .split('-', '_')
      .filter { it.isNotBlank() }
      .map { word -> word.replaceFirstChar { it.uppercaseChar() } }
      .distinct()

  val result = words.joinToString(" ")
  return result.ifBlank { key }
}

fun displaySessionName(entry: ChatSessionEntry): String {
  val preferredSubagentLabel = resolvePreferredSubagentLabel(entry)
  if (!preferredSubagentLabel.isNullOrBlank()) {
    return preferredSubagentLabel
  }

  val derivedTitle = resolvePreferredSessionLabel(entry, entry.derivedTitle)
  if (!derivedTitle.isNullOrBlank()) {
    return derivedTitle
  }

  resolveThreadOrTopicSessionDisplayName(entry)?.let { return it }

  val displayName = entry.displayName?.trim()
  val sanitizedDisplayName = resolvePreferredSessionLabel(entry, displayName)

  val enrichedAgentLabel = resolveAgentSessionDisplayName(entry, sanitizedDisplayName)
  return enrichedAgentLabel ?: sanitizedDisplayName ?: friendlySessionName(entry.key)
}

fun compactSessionDisplayName(entry: ChatSessionEntry): String {
  return displaySessionName(entry).trim().ifEmpty { entry.key.trim() }
}

fun resolveSessionLabel(entry: ChatSessionEntry): String = compactSessionDisplayName(entry)

fun resolveSessionSupportingText(entry: ChatSessionEntry): String? {
  val label = resolveSessionLabel(entry)
  val model = entry.model?.trim()?.takeIf { it.isNotEmpty() }
  val rawKey = entry.key.trim().takeIf { it.isNotEmpty() && it != "main" && it != label }
  return listOfNotNull(model, rawKey).takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

fun friendlyAgentName(agentId: String): String {
  val trimmed = agentId.trim()
  if (trimmed.isEmpty()) return "Main"
  return trimmed
    .split('-', '_', ':')
    .filter { it.isNotBlank() }
    .joinToString(" ") { it.replaceFirstChar { ch -> ch.uppercaseChar() } }
    .ifBlank { trimmed }
}

fun resolveSessionAgentId(
  sessionKey: String,
  mainSessionKey: String,
): String {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val normalized = normalizeRequestedSessionKey(sessionKey, mainKey)
  if (normalized == mainKey || normalized == "main") return "main"

  val lowered = normalized.lowercase(Locale.US)
  if (lowered.startsWith("agent:")) {
    val parts = normalized.split(':').filter { it.isNotEmpty() }
    if (parts.size >= 2) {
      return parts[1].trim().ifEmpty { "main" }
    }
  }

  G_AGENT_REGEX.find(normalized)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }?.let {
    return it
  }

  return normalized
}

fun isCronSessionKey(key: String): Boolean {
  val normalized = key.trim().lowercase(Locale.US)
  if (normalized.isEmpty()) return false
  if (normalized.startsWith("cron:")) return true
  if (!normalized.startsWith("agent:")) return false
  val parts = normalized.split(':').filter { it.isNotEmpty() }
  if (parts.size < 3) return false
  return parts.drop(2).joinToString(":").startsWith("cron:")
}

fun resolveSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val current = normalizeRequestedSessionKey(currentSessionKey, mainKey)
  val aliasKey = if (mainKey == "main") null else "main"
  val sorted = sessions.sortedByDescending { it.updatedAtMs ?: 0L }
  val recent = mutableListOf<ChatSessionEntry>()
  val seen = mutableSetOf<String>()
  for (entry in sorted) {
    if (aliasKey != null && entry.key == aliasKey) continue
    if (!seen.add(entry.key)) continue
    recent.add(entry)
  }

  val result = mutableListOf<ChatSessionEntry>()
  val included = mutableSetOf<String>()
  val mainEntry = sorted.firstOrNull { it.key == mainKey }
  if (mainEntry != null) {
    result.add(mainEntry)
    included.add(mainKey)
  } else if (current == mainKey) {
    result.add(ChatSessionEntry(key = mainKey, updatedAtMs = null))
    included.add(mainKey)
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

fun resolveSessionOptionGroups(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  hideCronSessions: Boolean,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionOptionGroup> {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val current = normalizeRequestedSessionKey(currentSessionKey, mainKey)
  val currentAgentId = resolveSessionAgentId(current, mainKey)
  val grouped = linkedMapOf<String, MutableList<ChatSessionEntry>>()

  resolveSessionChoices(current, sessions, mainKey, nowMs).forEach { entry ->
    val agentId = resolveSessionAgentId(entry.key, mainKey)
    grouped.getOrPut(agentId) { mutableListOf() }.add(entry)
  }

  if (!grouped.containsKey(currentAgentId)) {
    grouped[currentAgentId] = mutableListOf(ChatSessionEntry(key = current, updatedAtMs = null))
  }

  return grouped.map { (agentId, entries) ->
    val visibleSessions =
      if (hideCronSessions) {
        entries.filter { entry -> entry.key == current || !isCronSessionKey(entry.key) }
          .ifEmpty { entries.take(1) }
      } else {
        entries
      }

    ChatSessionOptionGroup(
      id = agentId,
      label = friendlyAgentName(agentId),
      primarySessionKey = pickPrimaryAgentSession(agentId, entries, mainKey).key,
      sessions = visibleSessions,
    )
  }
}

fun resolveCurrentSessionOptionGroup(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  hideCronSessions: Boolean,
  nowMs: Long = System.currentTimeMillis(),
): ChatSessionOptionGroup? {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val current = normalizeRequestedSessionKey(currentSessionKey, mainKey)
  val currentAgentId = resolveSessionAgentId(current, mainKey)
  return resolveSessionOptionGroups(
    currentSessionKey = current,
    sessions = sessions,
    mainSessionKey = mainKey,
    hideCronSessions = hideCronSessions,
    nowMs = nowMs,
  ).firstOrNull { it.id == currentAgentId }
}

fun resolveVisibleSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  hideCronSessions: Boolean,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val current = normalizeRequestedSessionKey(currentSessionKey, mainKey)
  val choices = resolveSessionChoices(current, sessions, mainKey, nowMs)
  if (!hideCronSessions) return choices
  return choices.filter { entry -> entry.key == current || !isCronSessionKey(entry.key) }
}

fun resolveVisibleSessionChoicesForCurrentAgent(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  hideCronSessions: Boolean,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> {
  return resolveCurrentSessionOptionGroup(
    currentSessionKey = currentSessionKey,
    sessions = sessions,
    mainSessionKey = mainSessionKey,
    hideCronSessions = hideCronSessions,
    nowMs = nowMs,
  )?.sessions.orEmpty()
}

fun resolveAgentChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  nowMs: Long = System.currentTimeMillis(),
): List<ChatAgentChoice> {
  return resolveSessionOptionGroups(
    currentSessionKey = currentSessionKey,
    sessions = sessions,
    mainSessionKey = mainSessionKey,
    hideCronSessions = false,
    nowMs = nowMs,
  ).map { group ->
    ChatAgentChoice(
      id = group.id,
      label = group.label,
      sessionKey = group.primarySessionKey,
    )
  }
}

fun countHiddenCronSessionChoices(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  nowMs: Long = System.currentTimeMillis(),
): Int {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  val current = normalizeRequestedSessionKey(currentSessionKey, mainKey)
  return resolveSessionChoices(current, sessions, mainKey, nowMs)
    .count { entry -> entry.key != current && isCronSessionKey(entry.key) }
}

private fun pickPrimaryAgentSession(
  agentId: String,
  entries: List<ChatSessionEntry>,
  mainSessionKey: String,
): ChatSessionEntry {
  val mainKey = normalizeMainSessionKey(mainSessionKey)
  return entries.firstOrNull { agentId == "main" && normalizeRequestedSessionKey(it.key, mainKey) == mainKey }
    ?: entries.firstOrNull { it.key.trim().lowercase(Locale.US).endsWith(":main") }
    ?: entries.firstOrNull { !isCronSessionKey(it.key) }
    ?: entries.first()
}

private fun normalizeMainSessionKey(mainSessionKey: String): String {
  return mainSessionKey.trim().ifEmpty { "main" }
}

private fun normalizeRequestedSessionKey(currentSessionKey: String, mainSessionKey: String): String {
  val current = currentSessionKey.trim()
  return if (current == "main" && mainSessionKey != "main") mainSessionKey else current
}

private fun resolveThreadOrTopicSessionDisplayName(entry: ChatSessionEntry): String? {
  val key = entry.key.trim()
  if (key.isEmpty()) return null

  val subjectLabel = sanitizeHumanSessionLabel(entry.subject, key)
  if (!subjectLabel.isNullOrBlank()) {
    return subjectLabel
  }

  val threadId =
    extractThreadOrTopicIdentifier(key)
      ?: extractAgentMainThreadIdentifier(key)
      ?: entry.topicId?.trim()?.takeIf { it.isNotEmpty() }
      ?: entry.lastThreadId?.trim()?.takeIf { it.isNotEmpty() }
  if (threadId.isNullOrBlank()) return null

  val channel =
    entry.channel?.trim()?.lowercase(Locale.US)
      ?: entry.lastChannel?.trim()?.lowercase(Locale.US)
      ?: extractChannelFromLastTo(entry.lastTo)
  val channelLabel = channel?.let { CHANNEL_LABELS[it] ?: it.replaceFirstChar { ch -> ch.uppercaseChar() } }
  if (!channelLabel.isNullOrBlank()) {
    resolveStructuredThreadLabel(channel, channelLabel, key, entry.lastTo, threadId)?.let { return it }
    return "$channelLabel: $threadId"
  }

  if (key.contains(":topic:") || key.contains(":thread:") || key.contains(":main:thread:")) {
    return threadId
  }
  return null
}

private fun extractThreadOrTopicIdentifier(key: String): String? {
  val topicMatch = Regex(""":topic:([^:]+)$""").find(key)
  if (topicMatch != null) {
    return topicMatch.groupValues.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }
  }
  val threadMatch = Regex(""":thread:([^:]+)$""").find(key)
  if (threadMatch != null) {
    return threadMatch.groupValues.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }
  }
  return null
}

private fun extractAgentMainThreadIdentifier(key: String): String? {
  val match = Regex("""^agent:[^:]+:main:thread:[^:]+:([^:]+)$""").matchEntire(key)
  return match?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }
}

private fun extractChannelFromLastTo(value: String?): String? {
  val trimmed = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return trimmed.substringBefore(':', missingDelimiterValue = "").trim().lowercase(Locale.US).takeIf { it.isNotEmpty() }
}

private fun resolveStructuredThreadLabel(
  channel: String?,
  channelLabel: String,
  key: String,
  lastTo: String?,
  threadId: String,
): String? {
  if (channel != "telegram") return null
  val kind = when {
    key.contains(":topic:") || lastTo?.contains(":topic:") == true -> "topic"
    key.contains(":thread:") || key.contains(":main:thread:") -> "thread"
    else -> null
  } ?: return null
  return "$channelLabel $kind: $threadId"
}

private fun resolvePreferredSubagentLabel(entry: ChatSessionEntry): String? {
  if (!entry.key.contains(":subagent:")) return null

  val preferred = entry.label?.trim()?.takeIf { it.isNotEmpty() }
    ?: entry.displayName?.trim()?.takeIf { it.isNotEmpty() && !looksLikeTechnicalSessionLabel(it) }

  if (preferred.isNullOrBlank()) return null
  if (preferred.startsWith("Subagent:", ignoreCase = true)) return preferred
  return "Subagent: $preferred"
}

private fun resolveAgentSessionDisplayName(entry: ChatSessionEntry, sanitizedDisplayName: String?): String? {
  val key = entry.key.trim()
  if (key.isEmpty()) return sanitizedDisplayName
  if (!key.startsWith("agent:")) return sanitizedDisplayName
  if (key.contains(":subagent:")) return sanitizedDisplayName

  resolveStructuredChannelSessionName(key)?.let { return it }
  resolveExplicitAgentMainLabel(key, sanitizedDisplayName)?.let { return it }

  val suffix = resolveAgentSessionSuffix(key) ?: return sanitizedDisplayName
  val base = sanitizedDisplayName?.takeIf { it.isNotBlank() } ?: friendlyAgentName(resolveSessionAgentId(key, "main"))
  return "$base: $suffix"
}

private fun resolveAgentSessionSuffix(key: String): String? {
  val parts = key.split(':').filter { it.isNotEmpty() }
  if (parts.size < 4 || !parts[0].equals("agent", ignoreCase = true)) return null

  val kind = parts[2].trim().lowercase(Locale.US)
  val tail = parts.drop(3)
  if (tail.isEmpty()) return null

  return when (kind) {
    "dashboard" -> {
      val shortId = tail.lastOrNull()?.takeLast(4)?.takeIf { it.isNotBlank() } ?: return null
      "dashboard: $shortId"
    }
    else -> null
  }
}

private fun resolveSubagentSessionName(key: String): String? {
  if (!key.contains(":subagent:")) return null
  val suffix = key.substringAfter(":subagent:", missingDelimiterValue = "").trim()
  if (suffix.isEmpty()) return "Subagent"

  if (shouldCompactTechnicalSubagentIdentifier(suffix)) {
    val identifier = extractPreferredIdentifier(suffix)
    if (!identifier.isNullOrBlank() && identifier != suffix) {
      return "Subagent: $identifier"
    }
  }

  val words =
    suffix
      .split('-', '_', ':', '/')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .map { part -> part.replaceFirstChar { ch -> ch.uppercaseChar() } }
      .distinct()

  val label = words.joinToString(" ").trim()
  return if (label.isNotEmpty()) "Subagent: $label" else "Subagent"
}

private fun shouldCompactTechnicalSubagentIdentifier(value: String): Boolean {
  val lowered = value.trim().lowercase(Locale.US)
  if (lowered.isEmpty()) return false
  if (shouldPreferChannelIdentifier(lowered)) return true
  if (lowered.startsWith("agent:")) return true
  if (lowered.contains("g-agent-")) return true
  return Regex("""\b\d{4,}\b""").containsMatchIn(lowered)
}

private fun resolveAgentSpecialSessionName(key: String): String? {
  val nodeMatch = Regex("""^agent:[^:]+:node-([a-z0-9]+)$""", RegexOption.IGNORE_CASE).matchEntire(key)
  if (nodeMatch != null) {
    val shortId = nodeMatch.groupValues.getOrNull(1)?.take(12)?.trim()?.takeIf { it.isNotEmpty() }
    return if (shortId != null) "Device main: $shortId" else "Device main"
  }

  val slashMatch = Regex("""^agent:[^:]+:([a-z0-9_]+):slash:(.+)$""", RegexOption.IGNORE_CASE).matchEntire(key)
  if (slashMatch != null) {
    val channel = slashMatch.groupValues[1]
    val rawIdentifier = slashMatch.groupValues[2]
    val label = channelDisplayLabel(channel)
    val identifier = extractPreferredIdentifier(rawIdentifier) ?: rawIdentifier.trim()
    return if (identifier.isNotEmpty()) "$label command: $identifier" else "$label command"
  }

  return null
}

private fun resolveExplicitAgentMainLabel(key: String, sanitizedDisplayName: String?): String? {
  val trimmedDisplayName = sanitizedDisplayName?.trim()?.takeIf { it.isNotEmpty() }
  val nodeMatch = Regex("""^agent:[^:]+:node-([a-z0-9]+)$""", RegexOption.IGNORE_CASE).matchEntire(key)
  if (nodeMatch != null) {
    return trimmedDisplayName?.let { "Device main: $it" } ?: resolveAgentSpecialSessionName(key)
  }
  return null
}

private fun resolveStructuredChannelSessionName(key: String): String? {
  val directMatch = Regex("""^agent:[^:]+:([^:]+):direct:(.+)$""").matchEntire(key)
  if (directMatch != null) {
    val channel = directMatch.groupValues[1]
    val rawIdentifier = directMatch.groupValues[2]
    val label = channelDisplayLabel(channel)
    return rawIdentifier.trim().takeIf { it.isNotEmpty() }?.let { "$label: ${extractPreferredIdentifier(it) ?: it}" }
  }

  val groupMatch = Regex("""^agent:[^:]+:([^:]+):group:(.+)$""").matchEntire(key)
  if (groupMatch != null) {
    val channel = groupMatch.groupValues[1]
    val rawIdentifier = groupMatch.groupValues[2]
    val label = channelDisplayLabel(channel)
    val identifier = extractPreferredIdentifier(rawIdentifier) ?: rawIdentifier.trim()
    return if (identifier.isNotEmpty()) "$label: $identifier" else "$label Group"
  }

  return null
}

private fun resolveLegacyChannelSessionName(key: String): String? {
  val separator = key.indexOf(':')
  if (separator <= 0) return null
  val channel = key.substring(0, separator).trim().lowercase(Locale.US)
  val rest = key.substring(separator + 1).trim()
  val channelLabel = CHANNEL_LABELS[channel] ?: return null
  if (rest.isEmpty()) return "$channelLabel Session"

  val identifier = extractPreferredIdentifier(rest)
  if (identifier != null && shouldPreferChannelIdentifier(rest)) {
    return "$channelLabel: $identifier"
  }
  return "$channelLabel Session"
}

private fun shouldPreferChannelIdentifier(raw: String): Boolean {
  val lowered = raw.trim().lowercase(Locale.US)
  if (lowered.isEmpty()) return false
  return listOf("thread-", "topic-", "chat-", "direct-", "group-", "user-", "dm-").any { lowered.contains(it) }
}

private fun extractPreferredIdentifier(raw: String): String? {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return null
  val lowered = trimmed.lowercase(Locale.US)
  val markers = listOf("thread-", "topic-", "chat-", "direct-", "group-", "user-", "dm-")
  for (marker in markers) {
    val index = lowered.indexOf(marker)
    if (index >= 0) {
      val tail = trimmed.substring(index + marker.length)
      extractTrailingIdentifier(tail)?.let { return it }
    }
  }

  Regex("""\b\d{4,}\b""").findAll(trimmed).map { it.value }.lastOrNull()?.let { return it }
  return extractTrailingIdentifier(trimmed)
}

private fun extractTrailingIdentifier(raw: String): String? {
  val tokens = raw
    .split('-', '_', ':', '/')
    .map { it.trim() }
    .filter { it.isNotEmpty() }
  if (tokens.isEmpty()) return null
  return tokens.lastOrNull { token -> token.any(Char::isDigit) } ?: tokens.last()
}

private fun channelDisplayLabel(channel: String): String {
  val trimmed = channel.trim().lowercase(Locale.US)
  return CHANNEL_LABELS[trimmed] ?: trimmed.replaceFirstChar { it.uppercaseChar() }
}

private fun sanitizeHumanSessionLabel(
  value: String?,
  sessionKey: String,
): String? {
  val trimmed = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val normalized = stripLeadingCompactTimestampPrefix(trimmed)
  if (normalized.equals(sessionKey, ignoreCase = true)) return null
  if (looksLikeTechnicalSessionLabel(normalized)) return null
  if (looksLikeInboundMetadataSentinel(normalized)) return null
  return normalized
}

private fun resolvePreferredSessionLabel(
  entry: ChatSessionEntry,
  value: String?,
): String? {
  val sanitized = sanitizeHumanSessionLabel(value, entry.key) ?: return null
  return if (shouldPreferStructuredChannelFallback(entry, sanitized)) null else sanitized
}

private fun shouldPreferStructuredChannelFallback(
  entry: ChatSessionEntry,
  label: String,
): Boolean {
  val trimmed = label.trim()
  if (trimmed.isEmpty()) return false

  val hasStructuredFallback =
    !resolveStructuredChannelSessionName(entry.key).isNullOrBlank() ||
      !resolveLegacyChannelSessionName(entry.key).isNullOrBlank() ||
      !resolveThreadOrTopicSessionDisplayName(
        entry.copy(
          displayName = null,
          derivedTitle = null,
          subject = null,
          label = null,
        ),
      ).isNullOrBlank()
  if (!hasStructuredFallback) return false

  if (trimmed.matches(Regex("""\\d{4,}"""))) {
    return true
  }

  val normalizedChannel = entry.channel?.trim()?.lowercase(Locale.US)
  val normalizedChatType = entry.chatType?.trim()?.lowercase(Locale.US)
  if (normalizedChannel == "telegram" && normalizedChatType == "direct" && looksLikePersonalName(trimmed)) {
    return true
  }

  return false
}

private fun looksLikePersonalName(value: String): Boolean {
  val words = value.trim().split(Regex("""\\s+""")).filter { it.isNotBlank() }
  if (words.size !in 2..4) return false
  return words.all { word ->
    word.matches(Regex("""^[\\p{Lu}][\\p{L}'’-]*$"""))
  }
}

private fun looksLikeTechnicalSessionLabel(value: String): Boolean {
  val trimmed = value.trim()
  if (trimmed.isEmpty()) return false
  val lowered = trimmed.lowercase(Locale.US)
  if (trimmed.matches(Regex("""^[0-9a-f]{8}(?: \(\d{4}-\d{2}-\d{2}\))?$""", RegexOption.IGNORE_CASE))) return true
  if (lowered.startsWith("agent:")) return true
  if (CHANNEL_LABELS.keys.any { channel -> lowered.startsWith("$channel:") }) return true
  if (lowered.contains("g-agent-")) return true
  if (lowered.contains("-subagen")) return true
  if (lowered.contains("-thread") || lowered.contains("-thr")) return true
  if (lowered.contains("-node-")) return true
  return false
}

private fun looksLikeInboundMetadataSentinel(value: String): Boolean {
  val normalized = value.trim().lowercase(Locale.US)
  if (normalized.isEmpty()) return false
  return normalized.startsWith("conversation info (untrusted metadata)") ||
    normalized.startsWith("sender (untrusted metadata)") ||
    normalized.startsWith("thread starter (untrusted, for context)") ||
    normalized.startsWith("replied message (untrusted, for context)") ||
    normalized.startsWith("forwarded message context (untrusted metadata)") ||
    normalized.startsWith("chat history since last reply (untrusted, for context)") ||
    normalized.startsWith("system:")
}

private fun stripLeadingCompactTimestampPrefix(value: String): String {
  val trimmed = value.trim()
  if (trimmed.isEmpty()) return trimmed
  val stripped = trimmed.replaceFirst(
    Regex("""^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[A-Za-z0-9:+\-]+\]\s*"""),
    "",
  ).trim()
  return stripped.ifEmpty { trimmed }
}

private fun resolveCronSessionName(key: String): String? {
  val rawCronId =
    when {
      key.startsWith("cron:") -> key.removePrefix("cron:").substringBefore(":run:").substringBefore(":failure")
      key.startsWith("agent:") -> {
        val parts = key.split(':').filter { it.isNotEmpty() }
        if (parts.size < 4 || parts[2] != "cron") {
          return null
        }
        parts.drop(3).joinToString(":").substringBefore(":run:").substringBefore(":failure")
      }
      else -> return null
    }
      .trim()
      .ifEmpty { return "Cron" }

  val words =
    rawCronId
      .split('-', '_', ':')
      .filter { it.isNotBlank() }
      .map { part -> part.replaceFirstChar { it.uppercaseChar() } }

  val suffix = words.joinToString(" ").ifBlank { rawCronId }
  return if (suffix.equals("Cron", ignoreCase = true)) "Cron" else "Cron · $suffix"
}
