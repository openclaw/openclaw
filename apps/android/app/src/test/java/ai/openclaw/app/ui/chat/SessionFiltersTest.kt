package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionFiltersTest {
  @Test
  fun sessionChoicesPreferMainAndAllSessions() {
    val now = 1_700_000_000_000L
    val recent1 = now - 2 * 60 * 60 * 1000L
    val recent2 = now - 5 * 60 * 60 * 1000L
    val stale = now - 26 * 60 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "recent-1", updatedAtMs = recent1),
        ChatSessionEntry(key = "main", updatedAtMs = stale),
        ChatSessionEntry(key = "old-1", updatedAtMs = stale),
        ChatSessionEntry(key = "recent-2", updatedAtMs = recent2),
      )

    val result = resolveSessionChoices("main", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "recent-1", "recent-2", "old-1"), result)
  }

  @Test
  fun sessionChoicesIncludeCurrentWhenMissing() {
    val now = 1_700_000_000_000L
    val recent = now - 10 * 60 * 1000L
    val sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = recent))

    val result = resolveSessionChoices("custom", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "custom"), result)
  }

  @Test
  fun sessionChoicesResolveMainAliasToAppliedMainSessionKey() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:ops:node-device", updatedAtMs = recent),
      )

    val result =
      resolveSessionChoices(
        currentSessionKey = "main",
        sessions = sessions,
        mainSessionKey = "agent:ops:node-device",
        nowMs = now,
      ).map { it.key }

    assertEquals(listOf("agent:ops:node-device"), result)
  }

  @Test
  fun sessionChoicesDeduplicateRepeatedEntriesAndKeepOlderNonCurrentSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 15 * 60 * 1000L
    val stale = now - 3 * 24 * 60 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = recent),
        ChatSessionEntry(key = "dup", updatedAtMs = recent),
        ChatSessionEntry(key = "dup", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "stale", updatedAtMs = stale),
      )

    val result = resolveSessionChoices("main", sessions, mainSessionKey = "main", nowMs = now).map { it.key }

    assertEquals(listOf("main", "dup", "stale"), result)
  }

  @Test
  fun sessionChoicesHideCronSessionsButKeepCurrentWhenRequested() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:cron:daily-summary", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:main:subagent:abc", updatedAtMs = recent - 2_000L),
      )

    val hidden =
      resolveVisibleSessionChoices(
        currentSessionKey = "main",
        sessions = sessions,
        mainSessionKey = "main",
        hideCronSessions = true,
        nowMs = now,
      ).map { it.key }
    assertEquals(listOf("main", "agent:main:subagent:abc"), hidden)

    val currentCronVisible =
      resolveVisibleSessionChoices(
        currentSessionKey = "agent:main:cron:daily-summary",
        sessions = sessions,
        mainSessionKey = "main",
        hideCronSessions = true,
        nowMs = now,
      ).map { it.key }
    assertTrue(currentCronVisible.contains("agent:main:cron:daily-summary"))
    assertEquals(1, countHiddenCronSessionChoices("main", sessions, "main", now))
  }

  @Test
  fun friendlySessionNameHumanizesKnownSessionShapes() {
    assertEquals("Main", friendlySessionName("agent:main:main"))
    assertEquals("Discord Session", friendlySessionName("discord:g-server-channel"))
    assertEquals("My Custom Session", friendlySessionName("my-custom-session"))
    assertEquals("Cron · Daily Summary", friendlySessionName("agent:main:cron:daily-summary"))
    assertEquals("Device main: 94b77028da7f", friendlySessionName("agent:main:node-94b77028da7f"))
    assertEquals("Telegram command: 139351986", friendlySessionName("agent:main:telegram:slash:139351986"))
  }

  @Test
  fun friendlySessionNamePrefersChannelAndIdentifierForLegacyTelegramThreadKeys() {
    assertEquals(
      "Telegram: 216750",
      friendlySessionName("telegram:g-agent-main-main-thread-216750"),
    )
  }

  @Test
  fun friendlySessionNameUsesStructuredChannelIdentifiersWhenAvailable() {
    assertEquals(
      "Telegram: 216303",
      friendlySessionName("agent:main:telegram:group:topic-216303"),
    )
    assertEquals(
      "Telegram: 139351986",
      friendlySessionName("agent:main:telegram:direct:user-139351986"),
    )
  }

  @Test
  fun displaySessionNamePrefersUsefulDisplayNameWhenPresent() {
    val entry = ChatSessionEntry(
      key = "agent:main:subagent:abc",
      updatedAtMs = null,
      displayName = "Subagent: cron-config-check",
    )

    assertEquals("Subagent: cron-config-check", displaySessionName(entry))
  }

  @Test
  fun displaySessionNamePrefersHumanSubagentLabelFromGateway() {
    val entry = ChatSessionEntry(
      key = "agent:research:subagent:582844c3-0439-452c-9443-ff19a12e0761",
      updatedAtMs = null,
      displayName = "Subagent: 9443",
      label = "Android session edge-case audit",
    )

    assertEquals("Subagent: Android session edge-case audit", displaySessionName(entry))
  }

  @Test
  fun displaySessionNamePrefersDerivedTitleForTelegramThreadSessions() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:direct:123456789:thread:99",
      updatedAtMs = null,
      displayName = "Dmitry Kuznetsov",
      derivedTitle = "Новый тестовый чат",
      channel = "telegram",
      chatType = "direct",
      topicId = "99",
    )

    assertEquals("Новый тестовый чат", displaySessionName(entry))
  }

  @Test
  fun displaySessionNamePrefersSubjectForTelegramTopicSessionsWhenDerivedTitleMissing() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:group:-100123456:topic:216303",
      updatedAtMs = null,
      displayName = "216303",
      subject = "Android parity",
      channel = "telegram",
      chatType = "group",
      topicId = "216303",
    )

    assertEquals("Android parity", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameIgnoresInboundMetadataSentinelTitles() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:group:-100123456:topic:216303",
      updatedAtMs = null,
      displayName = "Conversation info (untrusted metadata):",
      derivedTitle = "Sender (untrusted metadata):",
      channel = "telegram",
      chatType = "group",
      topicId = "216303",
    )

    assertEquals("Telegram topic: 216303", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameIgnoresSystemPrefixedSessionNoise() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:group:-100123456:topic:216303",
      updatedAtMs = null,
      displayName = "System: [2026-04-19 21:08:31]",
      channel = "telegram",
      chatType = "group",
      topicId = "216303",
    )

    assertEquals("Telegram topic: 216303", displaySessionName(entry))
  }

  @Test
  fun displaySessionNamePrefersStructuredTelegramFallbackOverBareNumericTitle() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:group:-100123456:topic:216303",
      updatedAtMs = null,
      displayName = "216303",
      channel = "telegram",
      chatType = "group",
      topicId = "216303",
    )

    assertEquals("Telegram topic: 216303", displaySessionName(entry))
  }

  @Test
  fun displaySessionNamePrefersStructuredTelegramFallbackOverDirectPersonalName() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:direct:139351986",
      updatedAtMs = null,
      displayName = "Dmitry Kuznetsov",
      channel = "telegram",
      chatType = "direct",
    )

    assertEquals("Telegram: 139351986", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameUsesTelegramThreadFallbackForAgentMainThreadKey() {
    val entry = ChatSessionEntry(
      key = "agent:main:main:thread:139351986:216303",
      updatedAtMs = null,
      displayName = "Dmitry Kuznetsov",
      channel = "telegram",
      chatType = "direct",
      lastThreadId = "216303",
      lastTo = "telegram:139351986",
      lastChannel = "telegram",
    )

    assertEquals("Telegram thread: 216303", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameUsesLastChannelAndLastThreadFallbackWhenPrimaryFieldsMissing() {
    val entry = ChatSessionEntry(
      key = "agent:main:main:thread:139351986:213370",
      updatedAtMs = null,
      displayName = "213370",
      chatType = "direct",
      lastThreadId = "213370",
      lastTo = "telegram:139351986",
      lastChannel = "telegram",
    )

    assertEquals("Telegram thread: 213370", displaySessionName(entry))
  }

  @Test
  fun friendlySessionNameRestoresInformativeSubagentLabels() {
    assertEquals("Subagent: Cron Config Check", friendlySessionName("agent:main:subagent:cron-config-check"))
    assertEquals("Subagent: 216303", friendlySessionName("agent:main:subagent:telegram-thread-216303"))
  }

  @Test
  fun displaySessionNameIgnoresTechnicalDisplayNameAndFallsBackToFriendlyKey() {
    val entry = ChatSessionEntry(
      key = "telegram:g-agent-main-main-thread-216750",
      updatedAtMs = null,
      displayName = "telegram:g-agent-main-main-thr",
    )

    assertEquals("Telegram: 216750", displaySessionName(entry))
  }

  @Test
  fun compactSessionDisplayNameKeepsSingleLineFriendlyDeviceMainFallback() {
    val entry = ChatSessionEntry(
      key = "agent:main:node-229e55ef9bfd",
      updatedAtMs = null,
      displayName = "42dcdbd4 (2026-04-22)",
    )

    assertEquals("Device main: 229e55ef9bfd", compactSessionDisplayName(entry))
  }

  @Test
  fun compactSessionDisplayNameAppendsDashboardSuffixForAgentSessions() {
    val entry = ChatSessionEntry(
      key = "agent:main:dashboard:a1b79437-c465-4ba2-8fa0-a52d900a6cdf",
      updatedAtMs = null,
      displayName = "DkMagic7",
    )

    assertEquals("DkMagic7: dashboard: 6cdf", compactSessionDisplayName(entry))
  }

  @Test
  fun compactSessionDisplayNameUsesStructuredTelegramIdentifierForAgentSessions() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:group:topic-216303",
      updatedAtMs = null,
      displayName = "DkMagic7",
    )

    assertEquals("Telegram: 216303", compactSessionDisplayName(entry))
  }

  @Test
  fun displaySessionNameIgnoresHexDateFallbackTitleAndUsesFriendlySessionType() {
    val entry = ChatSessionEntry(
      key = "agent:main:telegram:slash:139351986",
      updatedAtMs = null,
      derivedTitle = "6c4082de (2026-04-22)",
    )

    assertEquals("Telegram command: 139351986", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameStripsLeadingCompactTimestampPrefix() {
    val entry = ChatSessionEntry(
      key = "agent:research:dashboard:4ba2",
      updatedAtMs = null,
      derivedTitle = "[Fri 2026-04-17 17:09 GMT+3] Короткая",
    )

    assertEquals("Короткая", displaySessionName(entry))
  }

  @Test
  fun displaySessionNameMakesDeviceMainExplicitWhenDisplayNameExists() {
    val entry = ChatSessionEntry(
      key = "agent:main:node-94b77028da7f",
      updatedAtMs = null,
      displayName = "DkMagic7",
    )

    assertEquals("Device main: DkMagic7", displaySessionName(entry))
  }

  @Test
  fun resolveSessionAgentIdMapsMainAndStructuredAgentKeys() {
    assertEquals("main", resolveSessionAgentId("main", "main"))
    assertEquals("main", resolveSessionAgentId("agent:main:subagent:abc", "main"))
    assertEquals("ops", resolveSessionAgentId("agent:ops:node-device", "main"))
    assertEquals("main", resolveSessionAgentId("telegram:g-agent-main-main", "main"))
  }

  @Test
  fun resolveAgentChoicesAggregatesByAgentAndPicksPrimarySession() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:subagent:abc", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = recent - 2_000L),
        ChatSessionEntry(key = "agent:ops:cron:daily", updatedAtMs = recent - 3_000L),
      )

    val result = resolveAgentChoices("agent:main:subagent:abc", sessions, "main", now)

    assertEquals(listOf("main", "ops"), result.map { it.id })
    assertEquals("agent:main:main", result.first { it.id == "main" }.sessionKey)
    assertEquals("agent:ops:main", result.first { it.id == "ops" }.sessionKey)
  }

  @Test
  fun visibleSessionChoicesForCurrentAgentKeepOnlyThatAgentSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:subagent:abc", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = recent - 2_000L),
      )

    val result = resolveVisibleSessionChoicesForCurrentAgent("agent:main:subagent:abc", sessions, "main", true, now)

    assertEquals(listOf("agent:main:main", "agent:main:subagent:abc"), result.map { it.key })
  }

  @Test
  fun sessionOptionGroupsShowWorkspacesOnlyAndPreservePerWorkspaceSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:main:subagent:abc", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = recent - 2_000L),
        ChatSessionEntry(key = "agent:ops:subagent:def", updatedAtMs = recent - 3_000L),
      )

    val groups = resolveSessionOptionGroups("agent:main:subagent:abc", sessions, "main", hideCronSessions = true, nowMs = now)

    assertEquals(listOf("main", "ops"), groups.map { it.id })
    assertEquals("Main", groups.first().label)
    assertEquals(listOf("agent:main:main", "agent:main:subagent:abc"), groups.first().sessions.map { it.key })
    assertEquals(listOf("agent:ops:main", "agent:ops:subagent:def"), groups.last().sessions.map { it.key })
  }

  @Test
  fun currentSessionOptionGroupKeepsOnlyCurrentWorkspaceSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:ops:subagent:def", updatedAtMs = recent - 2_000L),
      )

    val group = resolveCurrentSessionOptionGroup("agent:ops:subagent:def", sessions, "main", hideCronSessions = true, nowMs = now)

    assertEquals("ops", group?.id)
    assertEquals(listOf("agent:ops:main", "agent:ops:subagent:def"), group?.sessions?.map { it.key })
  }

  @Test
  fun visibleSessionChoicesForCurrentAgentHideOtherWorkspaceSessions() {
    val now = 1_700_000_000_000L
    val recent = now - 5 * 60 * 1000L
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = recent),
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = recent - 1_000L),
        ChatSessionEntry(key = "agent:ops:subagent:def", updatedAtMs = recent - 2_000L),
        ChatSessionEntry(key = "agent:other:main", updatedAtMs = recent - 3_000L),
      )

    val visible =
      resolveVisibleSessionChoicesForCurrentAgent(
        currentSessionKey = "agent:ops:subagent:def",
        sessions = sessions,
        mainSessionKey = "main",
        hideCronSessions = true,
        nowMs = now,
      )

    assertEquals(listOf("agent:ops:main", "agent:ops:subagent:def"), visible.map { it.key })
  }

  @Test
  fun friendlySessionNameFallsBackToOriginalKeyWhenNothingUsableRemains() {
    val raw = "___"
    assertTrue(friendlySessionName(raw).isNotBlank())
    assertEquals(raw, friendlySessionName(raw))
  }
}
