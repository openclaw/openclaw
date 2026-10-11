package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogHost
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.normalizeSidebarSectionOrder
import ai.openclaw.app.ui.design.clawColorsForTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarShellLogicTest {
  @Test
  fun sidebarPaletteUsesEveryActiveThemeAndAccentToken() {
    AppearanceThemeFamily.entries.forEach { family ->
      listOf(false, true).forEach { dark ->
        val colors =
          clawColorsForTheme(
            dark = dark,
            family = family,
            accentArgb = 0xFF2563EBL,
          )
        val palette = sidebarPalette(colors)

        assertEquals(colors.canvas, palette.background)
        assertEquals(colors.surfaceRaised, palette.elevated)
        assertEquals(colors.accentSoft, palette.selection)
        assertEquals(colors.text, palette.text)
        assertEquals(colors.textMuted, palette.muted)
        assertEquals(colors.border, palette.hairline)
      }
    }
  }

  @Test
  fun storedSidebarOrderAppendsMissingDestinationsInCanonicalOrder() {
    val destinations = orderedSidebarDestinations(listOf("threads", "home", "threads", "unknown"))
    assertEquals(
      listOf(
        SidebarDestination.Threads,
        SidebarDestination.Home,
        SidebarDestination.Skills,
        SidebarDestination.Work,
        SidebarDestination.Agents,
      ),
      destinations.take(5),
    )
    assertTrue(SidebarDestination.Dreaming in destinations.drop(5))
    assertEquals(destinations.size, destinations.distinct().size)
  }

  @Test
  fun reorderMovesOnePositionAndKeepsCanonicalDestinations() {
    val initial = orderedSidebarDestinations(listOf("agents", "work", "home", "skills", "threads")).map(SidebarDestination::stableId)

    assertEquals(
      listOf("work", "agents") + initial.drop(2),
      moveSidebarDestination(initial, destinationId = "work", direction = -1),
    )
    assertEquals(
      listOf("agents", "home", "work") + initial.drop(3),
      moveSidebarDestination(initial, destinationId = "work", direction = 1),
    )
    assertEquals(
      initial,
      moveSidebarDestination(initial, destinationId = "agents", direction = -1),
    )
    assertEquals(
      initial,
      moveSidebarDestination(initial, destinationId = "missing", direction = 1),
    )
  }

  @Test
  fun sessionDragMutatesOnlyTowardARealSidebarDestination() {
    assertEquals(true, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = -1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = 1))
    assertEquals(false, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = 1, currentlyPinned = true))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction = -1, currentlyPinned = true))
    assertEquals(false, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Pinned, direction = 1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Pinned, direction = -1))
    assertEquals(true, sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Recent, direction = -1))
    assertNull(sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Recent, direction = 1))
  }

  @Test
  fun pinnedItemVisibilityKeepsCanonicalOrderAndAtLeastOnePage() {
    assertEquals(
      listOf("work", "home", "threads"),
      updateSidebarDestinationVisibility(
        visibleIds = listOf("threads", "home"),
        destination = SidebarDestination.Work,
        visible = true,
      ),
    )
    assertEquals(
      listOf("home"),
      updateSidebarDestinationVisibility(
        visibleIds = listOf("home"),
        destination = SidebarDestination.Home,
        visible = false,
      ),
    )
  }

  @Test
  fun agentPickerExcludesSystemAgentsDeduplicatesAndKeepsTheSelection() {
    val state =
      agentPickerState(
        agents =
          listOf(
            agent("main"),
            agent("system", kind = "system"),
            agent("ops"),
            agent("main"),
          ),
        selectedAgentId = "ops",
      )

    assertEquals(listOf("main", "ops"), state.agents.map(GatewayAgentSummary::id))
    assertEquals("ops", state.selected?.id)
    assertEquals("ops", state.selectedAgentId)
  }

  @Test
  fun agentPickerFallsBackToTheFirstSelectableAgent() {
    val state = agentPickerState(listOf(agent("main"), agent("ops")), selectedAgentId = "missing")

    assertEquals("main", state.selected?.id)
    assertEquals("main", state.selectedAgentId)
  }

  @Test
  fun emptyAgentPickerHasNoSyntheticSelection() {
    val state = agentPickerState(listOf(agent("system", kind = "system")), selectedAgentId = "main")

    assertNull(state.selected)
    assertNull(state.selectedAgentId)
    assertEquals(emptyList<String>(), state.agents.map(GatewayAgentSummary::id))
  }

  @Test
  fun recentSessionsExcludeArchivedRowsAndPrioritizePinsThenActivity() {
    val rows =
      sidebarRecentSessions(
        sessions =
          listOf(
            session("old-pinned", activity = 1, pinned = true),
            session("fresh", activity = 30),
            session("archived", activity = 50, archived = true),
            session("fresh-pinned", activity = 20, pinned = true),
            session("sleeping-pinned", activity = 40, pinned = true).copy(snoozedUntil = 101L),
            session("expired", activity = 10).copy(snoozedUntil = 100L),
          ),
        nowMs = 100L,
      )

    assertEquals(listOf("fresh-pinned", "old-pinned", "fresh", "expired"), rows.map(ChatSessionEntry::key))
  }

  @Test
  fun sidebarPresentationRestoresSnoozedPinsAtTheirDeadline() {
    val rows = listOf(session("sleeping", activity = 20, pinned = true).copy(snoozedUntil = 100L), session("active", activity = 10))
    val before = sidebarSessionPresentation(rows, emptyList(), expanded = false, currentSessionKey = "sleeping", nowMs = 99L)
    val after = sidebarSessionPresentation(rows, emptyList(), expanded = false, currentSessionKey = "sleeping", nowMs = 100L)

    assertEquals(emptyList<ChatSessionEntry>(), before.pinned)
    assertEquals(listOf("active"), before.recentSections.flatMap { it.entries }.map { it.key })
    assertEquals(listOf("sleeping"), after.pinned.map { it.key })
    assertEquals(before.recentSections, after.recentSections)
  }

  @Test
  fun collapsedSessionPresentationKeepsAllPinsAndGroupsEightRecentRows() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("pinned", activity = 1, pinned = true),
            session("archived", activity = 100, archived = true),
          ) +
            (1L..10L).map { activity ->
              session(
                key = "session-$activity",
                activity = activity,
                category = if (activity % 2L == 0L) "Work" else null,
              )
            },
        knownGroups = listOf("Personal"),
        expanded = false,
      )

    val recentKeys = presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key)
    assertEquals(listOf("pinned"), presentation.pinned.map(ChatSessionEntry::key))
    assertEquals(listOf("Personal", "Work"), presentation.groups.map { it.name })
    assertEquals(emptyList<String>(), presentation.groups[0].entries.map { it.key })
    assertEquals(listOf("session-10", "session-8", "session-6", "session-4", "session-2"), presentation.groups[1].entries.map { it.key })
    assertEquals(listOf("session-9", "session-7", "session-5", "session-3", "session-1"), recentKeys)
    assertEquals(listOf<String?>(null), presentation.recentSections.map { it.title })
    assertFalse(presentation.canExpandRecent)
  }

  @Test
  fun expandedSessionPresentationRevealsAllRowsAndCollapsesToTheSameResult() {
    val sessions = (1L..12L).map { activity -> session("session-$activity", activity = activity) }

    val collapsed = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false)
    val expanded = sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = true)

    assertEquals(8, collapsed.recentSections.flatMap { it.entries }.size)
    assertEquals(12, expanded.recentSections.flatMap { it.entries }.size)
    assertFalse(collapsed.recentSections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.recentSections.flatMap { it.entries }.any { it.key == "session-1" })
    assertTrue(expanded.canExpandRecent)
    assertEquals(collapsed, sidebarSessionPresentation(sessions, knownGroups = emptyList(), expanded = false))
  }

  @Test
  fun catalogSessionsAreExcludedBeforeRecentPagination() {
    val sessions = (1L..10L).map { activity -> session("session-$activity", activity = activity) }

    val presentation =
      sidebarSessionPresentation(
        sessions = sessions,
        knownGroups = emptyList(),
        expanded = false,
        excludedSessionKeys = setOf("session-10", "session-9"),
      )

    assertEquals(
      listOf("session-8", "session-7", "session-6", "session-5", "session-4", "session-3", "session-2", "session-1"),
      presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key),
    )
    assertFalse(presentation.canExpandRecent)
  }

  @Test
  fun catalogPinsRemainVisibleWithoutDuplicatingRecentRows() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("visible-newest-pinned", activity = 50, pinned = true),
            session("catalog-pinned", activity = 40, pinned = true),
            session("visible-pinned", activity = 30, pinned = true),
            session("catalog-recent", activity = 20),
            session("visible-recent", activity = 10),
          ),
        knownGroups = emptyList(),
        expanded = true,
        excludedSessionKeys = setOf("catalog-pinned", "catalog-recent"),
      )

    assertEquals(
      listOf("visible-newest-pinned", "catalog-pinned", "visible-pinned"),
      presentation.pinned.map(ChatSessionEntry::key),
    )
    assertEquals(
      listOf("visible-recent"),
      presentation.recentSections.flatMap { it.entries }.map(ChatSessionEntry::key),
    )
  }

  @Test
  fun sessionActivityUsesCurrentFailureQueueRunAndUnreadPriority() {
    assertEquals(
      SidebarSessionActivity.Failed,
      sidebarSessionActivity(
        status = "running",
        lastRunError = "boom",
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Queued,
      sidebarSessionActivity(
        status = "queued",
        lastRunError = null,
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Running,
      sidebarSessionActivity(
        status = null,
        lastRunError = null,
        hasActiveRun = true,
        unread = true,
      ),
    )
    assertEquals(
      SidebarSessionActivity.Unread,
      sidebarSessionActivity(
        status = "idle",
        lastRunError = null,
        hasActiveRun = false,
        unread = true,
      ),
    )
    assertNull(
      sidebarSessionActivity(
        status = "idle",
        lastRunError = null,
        hasActiveRun = false,
        unread = false,
      ),
    )
  }

  @Test
  fun terminalCatalogStatusesRemainFailuresWithoutALiveSession() {
    listOf("failed", "timeout", "killed", "error").forEach { status ->
      assertEquals(
        SidebarSessionActivity.Failed,
        sidebarSessionActivity(status, lastRunError = null, hasActiveRun = false, unread = false),
      )
    }
  }

  @Test
  fun sessionSubtitleShowsWorkingForActiveRunsAndKeepsTheIdleSourceFallback() {
    val session = ChatSessionEntry(key = "telegram:123", updatedAtMs = 1_000, hasActiveRun = true)

    assertEquals(
      "Working",
      sessionListSubtitle(session, fallback = sessionSourceLabel(session.key), activeRunLabel = "Working", nowMs = 1_000),
    )
    assertEquals(
      "Telegram",
      sessionListSubtitle(session.copy(hasActiveRun = false), fallback = sessionSourceLabel(session.key), activeRunLabel = null, nowMs = 1_000),
    )
    assertEquals(
      "Working",
      sessionListSubtitle(session.copy(hasActiveRun = null, status = " RUNNING "), fallback = sessionSourceLabel(session.key), activeRunLabel = "Working", nowMs = 1_000),
    )
    assertEquals(
      "Telegram",
      sessionListSubtitle(session.copy(hasActiveRun = false, status = "running"), fallback = sessionSourceLabel(session.key), activeRunLabel = "Working", nowMs = 1_000),
    )
    assertNull(sidebarSessionActivity("running", lastRunError = null, hasActiveRun = false, unread = false))
    assertNull(sidebarSessionActivity("done", lastRunError = null, hasActiveRun = true, unread = false))
    assertEquals(SidebarSessionActivity.Running, sidebarSessionActivity("done", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Failed, sidebarSessionActivity("failed", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Running, sidebarSessionActivity("queued", null, false, false, continuing = true))
    assertEquals(SidebarSessionActivity.Queued, sidebarSessionActivity("queued", null, true, false, continuing = true))
    assertEquals(SidebarSessionActivity.Queued, sidebarSessionActivity("queued", null, null, false))
    assertNull(sidebarSessionActivity("queued", null, false, false))
    assertEquals(SidebarSessionActivity.Unread, sidebarSessionActivity("queued", null, false, true))
  }

  @Test
  fun sidebarGroupsKeepEmptyCatalogFoldersAheadOfRecent() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("loose", activity = 5),
            session("coded", activity = 9, category = "CODEX"),
            session("pinned-coded", activity = 8, pinned = true, category = "CODEX"),
          ),
        knownGroups = listOf("dankar", "CODEX"),
        expanded = true,
      )

    assertEquals(listOf("pinned-coded"), presentation.pinned.map { it.key })
    assertEquals(listOf("dankar", "CODEX"), presentation.groups.map { it.name })
    assertEquals(emptyList<String>(), presentation.groups[0].entries.map { it.key })
    assertEquals(listOf("coded"), presentation.groups[1].entries.map { it.key })
    assertEquals(listOf("loose"), presentation.recentSections.flatMap { it.entries }.map { it.key })
  }

  @Test
  fun sidebarGroupsStayVisibleWhenNoSessionsExist() {
    val presentation =
      sidebarSessionPresentation(
        sessions = emptyList(),
        knownGroups = listOf(" CODE ", "CODE", "dankar"),
        expanded = false,
      )

    assertEquals(listOf("CODE", "dankar"), presentation.groups.map { it.name })
    assertTrue(presentation.groups.all { it.entries.isEmpty() })
    assertTrue(presentation.recentSections.isEmpty())
  }

  @Test
  fun unknownCategoriesFollowCatalogOrder() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("z", activity = 2, category = "zeta"),
            session("a", activity = 1, category = "alpha"),
          ),
        knownGroups = listOf("mid"),
        expanded = true,
      )

    assertEquals(listOf("mid", "alpha", "zeta"), presentation.groups.map { it.name })
  }

  @Test
  fun recentCapIgnoresSessionsThatLiveInGroups() {
    val sessions = (1L..9L).map { session("loose-$it", activity = it) } + session("grouped", activity = 100, category = "Work")
    val collapsed = sidebarSessionPresentation(sessions, knownGroups = listOf("Work"), expanded = false)
    val expanded = sidebarSessionPresentation(sessions, knownGroups = listOf("Work"), expanded = true)

    assertEquals(8, collapsed.recentSections.flatMap { it.entries }.size)
    assertFalse(collapsed.recentSections.flatMap { it.entries }.any { it.key == "grouped" })
    assertEquals(
      listOf("grouped"),
      collapsed.groups
        .single()
        .entries
        .map { it.key },
    )
    assertTrue(collapsed.canExpandRecent)
    assertEquals(9, expanded.recentSections.flatMap { it.entries }.size)
  }

  @Test
  fun categoryFoldersStayOutOfTheKindGroupZone() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("dev", activity = 4, category = "Alpha"),
            session("objects", activity = 3, category = "Beta"),
            session("sync", activity = 2, category = "Gamma"),
            session("other", activity = 6, kind = "direct"),
            session("telegram", activity = 5, kind = "group"),
            session("filed-group", activity = 1, category = "Alpha", kind = "group"),
          ),
        knownGroups = listOf("Alpha", "Beta", "Gamma"),
        expanded = true,
      )

    assertEquals(listOf("Alpha", "Beta", "Gamma"), presentation.groups.map { it.name })
    assertEquals(listOf("dev", "filed-group"), presentation.groups[0].entries.map { it.key })
    assertEquals(listOf("other"), presentation.recentSections.flatMap { it.entries }.map { it.key })
    assertEquals(listOf("telegram"), presentation.chatGroups.map { it.key })
  }

  @Test
  fun sectionOrderUsesGatewayTokensThenDefaultBuiltIns() {
    assertEquals(
      listOf("category:Alpha", "category:Beta", "ungrouped", "groups", "work", "catalog:codex", "catalog:extra"),
      normalizeSidebarSectionOrder(
        stored = emptyList(),
        knownGroups = listOf("Alpha", "Beta"),
        catalogIds = listOf("codex", "extra"),
      ),
    )
    assertEquals(
      listOf(
        "catalog:codex",
        "category:Beta",
        "category:Gamma",
        "ungrouped",
        "groups",
        "category:Alpha",
        "work",
        "catalog:extra",
      ),
      normalizeSidebarSectionOrder(
        stored = listOf("catalog:codex", "category:Beta", "ungrouped", "groups", "category:Alpha", "work", "catalog:missing"),
        knownGroups = listOf("Alpha", "Beta", "Gamma"),
        catalogIds = listOf("codex", "extra"),
      ),
    )
  }

  @Test
  fun sectionWindowCountsLoadedMembersNotTheVisiblePage() {
    val entries = (1L..14L).map { session("s-$it", activity = it) }
    val window = sidebarSectionWindow(entries, visibleLimit = 10, activeSessionKey = "s-14")

    assertEquals(14, window.totalCount)
    assertEquals(11, window.rows.size)
    assertEquals("s-14", window.rows.last().key)
    assertTrue(window.canShowMore)
    assertEquals(14, sidebarCollapsedCount(window.totalCount))
    assertEquals(null, sidebarCollapsedCount(0))
  }

  @Test
  fun reorderStepsSkipHiddenWorkAndUnrenderedCatalogs() {
    val tokens =
      listOf(
        "category:Alpha",
        "ungrouped",
        "groups",
        "work",
        "catalog:codex",
        "catalog:extra",
      )

    assertEquals(
      listOf("category:Alpha", "ungrouped", "catalog:codex"),
      sidebarReorderVisibleTokens(
        sectionTokens = tokens,
        categoryNames = setOf("Alpha"),
        showGroupsZone = false,
        catalogIds = setOf("codex"),
      ),
    )
  }

  @Test
  fun collapsedCatalogCountShowsLoadedRowsWhileAnotherPageExists() {
    val host =
      SessionCatalogHost(
        hostId = "desktop",
        label = "Desktop",
        connected = true,
        nextCursor = "page-2",
        sessions =
          listOf(
            catalogEntry("live"),
            catalogEntry("archived", archived = true),
          ),
      )

    assertEquals(1, sidebarCatalogLoadedCount(listOf(host)))
    assertEquals(null, sidebarCatalogLoadedCount(emptyList()))
  }

  private fun catalogEntry(
    threadId: String,
    archived: Boolean = false,
  ): SessionCatalogEntry =
    SessionCatalogEntry(
      catalogId = "codex",
      hostId = "desktop",
      threadId = threadId,
      status = "idle",
      archived = archived,
      canContinue = true,
    )

  private fun agent(
    id: String,
    kind: String? = null,
  ): GatewayAgentSummary =
    GatewayAgentSummary(
      id = id,
      name = id,
      emoji = null,
      kind = kind,
    )

  private fun session(
    key: String,
    activity: Long,
    pinned: Boolean = false,
    archived: Boolean = false,
    displayName: String? = null,
    label: String? = null,
    owner: String? = null,
    category: String? = null,
    kind: String? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = activity,
      lastActivityAt = activity,
      pinned = pinned,
      archived = archived,
      displayName = displayName,
      label = label,
      ownerAgentId = owner,
      category = category,
      kind = kind,
    )
}
