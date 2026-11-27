package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.chat.ChatSessionEntry
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
    val before = sidebarSessionPresentation(rows, emptyList(), currentSessionKey = "sleeping", nowMs = 99L)
    val after = sidebarSessionPresentation(rows, emptyList(), currentSessionKey = "sleeping", nowMs = 100L)

    assertEquals(emptyList<ChatSessionEntry>(), before.pinned)
    assertEquals(listOf("active"), before.recent.map { it.key })
    assertEquals(listOf("sleeping"), after.pinned.map { it.key })
    assertEquals(before.recent, after.recent)
  }

  @Test
  fun sessionPresentationKeepsEveryFolderMemberAndEmptyKnownFolder() {
    val presentation =
      sidebarSessionPresentation(
        sessions =
          listOf(
            session("pinned", activity = 1, pinned = true),
            session("archived", activity = 100, archived = true),
            session("channel", activity = 12).copy(kind = "group"),
            session("filed-channel", activity = 11, category = "Work").copy(kind = "group"),
          ) +
            (1L..10L).map { activity ->
              session(
                key = "session-$activity",
                activity = activity,
                category = if (activity % 2L == 0L) "Work" else null,
              )
            },
        knownGroups = listOf("Personal"),
      )

    val recentKeys = presentation.recent.map(ChatSessionEntry::key)
    assertEquals(listOf("pinned"), presentation.pinned.map(ChatSessionEntry::key))
    assertEquals(listOf("Personal", "Work"), presentation.groups.map { it.name })
    assertTrue(
      presentation.groups
        .first()
        .entries
        .isEmpty(),
    )
    assertEquals(
      listOf("filed-channel", "session-10", "session-8", "session-6", "session-4", "session-2"),
      presentation.groups
        .last()
        .entries
        .map { it.key },
    )
    assertEquals(listOf("channel"), presentation.chatGroups.map { it.key })
    assertEquals(listOf("session-9", "session-7", "session-5", "session-3", "session-1"), recentKeys)
  }

  @Test
  fun sectionWindowPagesWithoutHidingTheActiveSession() {
    val entries = (1L..35L).map { session("session-$it", activity = it) }
    val first = sidebarSectionWindow(entries, 10, "session-35")
    assertEquals(11, first.rows.size)
    assertEquals("session-35", first.rows.last().key)
    assertTrue(first.canShowMore)
    val expanded = sidebarSectionWindow(entries, 40, "session-35")
    assertEquals(entries, expanded.rows)
    assertFalse(expanded.canShowMore)
    assertTrue(expanded.canShowLess)
  }

  @Test
  fun catalogSessionsAreExcludedBeforeRecentPagination() {
    val sessions = (1L..10L).map { activity -> session("session-$activity", activity = activity) }

    val presentation =
      sidebarSessionPresentation(
        sessions = sessions,
        knownGroups = emptyList(),
        excludedSessionKeys = setOf("session-10", "session-9"),
      )

    assertEquals(
      listOf("session-8", "session-7", "session-6", "session-5", "session-4", "session-3", "session-2", "session-1"),
      presentation.recent.map(ChatSessionEntry::key),
    )
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
        excludedSessionKeys = setOf("catalog-pinned", "catalog-recent"),
      )

    assertEquals(
      listOf("visible-newest-pinned", "catalog-pinned", "visible-pinned"),
      presentation.pinned.map(ChatSessionEntry::key),
    )
    assertEquals(
      listOf("visible-recent"),
      presentation.recent.map(ChatSessionEntry::key),
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
  fun childSessionsNestUnderTheirListedParentInsteadOfTheirOwnRows() {
    val parent = session("agent:main:dashboard:parent", 50)
    val child = session("agent:main:subagent:child", 90).copy(parentSessionKey = parent.key)
    val grandchild = session("agent:main:subagent:grandchild", 80).copy(spawnedBy = child.key)
    val other = session("agent:main:dashboard:other", 40)

    val presentation = sidebarSessionPresentation(listOf(parent, child, grandchild, other), emptyList())

    assertEquals(listOf(parent.key, other.key), presentation.recent.map { it.key })
    assertEquals(listOf(child.key), presentation.childrenByParent[parent.key].orEmpty().map { it.key })
    assertEquals(listOf(grandchild.key), presentation.childrenByParent[child.key].orEmpty().map { it.key })
    assertEquals(parent.key, presentation.rootKeyOf(grandchild.key))
    assertEquals(
      listOf(parent.key, child.key, grandchild.key, other.key),
      presentation.withDescendants(presentation.recent).map { it.key },
    )
  }

  @Test
  fun explicitPlacementAndUnlistedParentsKeepChildSessionsAtTheTopLevel() {
    val parent = session("agent:main:dashboard:parent", 10)
    val pinnedChild = session("agent:main:subagent:pinned", 90, pinned = true).copy(parentSessionKey = parent.key)
    val filedChild = session("agent:main:subagent:filed", 80, category = "Work").copy(parentSessionKey = parent.key)
    val rootChild = session("agent:main:dashboard:root", 70).copy(parentSessionKey = parent.key, sidebarRoot = true)
    val newChat =
      session("agent:main:dashboard:new", 60).copy(parentSessionKey = parent.key, createdVia = "operator", spawnDepth = 0)
    val orphan = session("agent:main:subagent:orphan", 50).copy(parentSessionKey = "agent:main:dashboard:unloaded")
    val catalogChild = session("agent:main:subagent:catalog-child", 40).copy(parentSessionKey = "agent:main:catalog")
    val catalogParent = session("agent:main:catalog", 30)

    val presentation =
      sidebarSessionPresentation(
        listOf(parent, pinnedChild, filedChild, rootChild, newChat, orphan, catalogChild, catalogParent),
        emptyList(),
        excludedSessionKeys = setOf(catalogParent.key),
      )

    assertEquals(listOf(pinnedChild.key), presentation.pinned.map { it.key })
    assertEquals(
      listOf(filedChild.key),
      presentation.groups
        .single()
        .entries
        .map { it.key },
    )
    // A parent shown in its catalog section cannot adopt rows into Recent.
    assertEquals(
      listOf(rootChild.key, newChat.key, orphan.key, catalogChild.key, parent.key),
      presentation.recent.map { it.key },
    )
    assertTrue(presentation.childrenByParent.isEmpty())
  }

  @Test
  fun homeChildrenStayTopLevelConversations() {
    val home = session("agent:main:main", 10)
    val conversation = session("agent:main:dashboard:work", 20).copy(parentSessionKey = home.key)
    val legacyHome = session("main", 5)
    val legacyChild = session("agent:main:subagent:legacy", 15).copy(spawnedBy = legacyHome.key)
    val customHome = session("agent:main:custom-home", 1).copy(isMain = true)
    val customChild = session("agent:main:subagent:custom", 25).copy(parentSessionKey = customHome.key)

    val presentation = sidebarSessionPresentation(listOf(home, conversation, legacyHome, legacyChild, customHome, customChild), emptyList())

    assertTrue(presentation.parentByKey.isEmpty())
    assertEquals(
      listOf(customChild.key, conversation.key, legacyChild.key, home.key, legacyHome.key, customHome.key),
      presentation.recent.map { it.key },
    )
  }

  @Test
  fun aParentRanksByItsNewestChildActivity() {
    val oldParent = session("agent:main:dashboard:old", 10)
    val freshChild = session("agent:main:subagent:fresh", 100).copy(parentSessionKey = oldParent.key)
    val newer = (1..3).map { session("agent:main:dashboard:newer-$it", 50 + it.toLong()) }

    val presentation = sidebarSessionPresentation(listOf(oldParent, freshChild) + newer, emptyList())

    assertEquals(oldParent.key, presentation.recent.first().key)
    assertEquals(oldParent.key, sidebarSectionWindow(presentation.recent, visibleLimit = 1, activeSessionKey = "").rows.single().key)
  }

  @Test
  fun aCollapsedSectionOpensForAnOpenChildOfOneOfItsSessions() {
    val pinnedParent = session("agent:main:dashboard:pinned", 30, pinned = true)
    val child = session("agent:main:subagent:child", 20).copy(parentSessionKey = pinnedParent.key)
    val other = session("agent:main:dashboard:other", 10)
    val presentation = sidebarSessionPresentation(listOf(pinnedParent, child, other), emptyList())

    assertEquals(listOf(pinnedParent.key), presentation.pinned.map { it.key })
    assertTrue(presentation.holdsNestedSession(presentation.pinned, activeSessionKey = child.key))
    assertFalse(presentation.holdsNestedSession(presentation.pinned, activeSessionKey = pinnedParent.key))
    assertFalse(presentation.holdsNestedSession(presentation.recent, activeSessionKey = child.key))
    assertFalse(presentation.holdsNestedSession(presentation.pinned, activeSessionKey = other.key))
  }

  @Test
  fun aCollapsedSectionReportsWorkInItsSessionsHiddenChildren() {
    val pinnedParent = session("agent:main:dashboard:pinned", 30, pinned = true)
    val runningChild = session("agent:main:subagent:child", 20).copy(parentSessionKey = pinnedParent.key, status = "running")
    val other = session("agent:main:dashboard:other", 10)
    val presentation = sidebarSessionPresentation(listOf(pinnedParent, runningChild, other), emptyList())

    assertEquals(SidebarSessionActivity.Running, presentation.collapsedSectionChildActivity(presentation.pinned))
    assertNull(presentation.collapsedSectionChildActivity(presentation.recent))
  }

  @Test
  fun aCollapsedParentReportsItsHiddenChildrensRequests() {
    val parent = session("agent:main:dashboard:parent", 30)
    val child = session("agent:main:subagent:child", 20).copy(parentSessionKey = parent.key)
    val grandchild = session("agent:main:subagent:grandchild", 10).copy(parentSessionKey = child.key)
    val presentation = sidebarSessionPresentation(listOf(parent, child, grandchild), emptyList())

    assertEquals(listOf(parent.key, child.key, grandchild.key), presentation.attentionRows(parent, childrenExpanded = false).map { it.key })
    assertEquals(listOf(parent.key), presentation.attentionRows(parent, childrenExpanded = true).map { it.key })
  }

  @Test
  fun parentsStartCollapsedUnlessTheyHoldTheOpenSessionAndHonorTheUsersChoice() {
    val parent = session("agent:main:dashboard:parent", 50)
    val child = session("agent:main:subagent:child", 40).copy(parentSessionKey = parent.key)
    val grandchild = session("agent:main:subagent:grandchild", 30).copy(parentSessionKey = child.key)
    val presentation = sidebarSessionPresentation(listOf(parent, child, grandchild), emptyList())

    assertFalse(presentation.childrenExpanded(parent.key, activeSessionKey = parent.key, emptyList(), emptyList()))
    assertTrue(presentation.childrenExpanded(parent.key, activeSessionKey = grandchild.key, emptyList(), emptyList()))
    assertFalse(presentation.childrenExpanded(parent.key, activeSessionKey = grandchild.key, emptyList(), listOf(parent.key)))
    assertTrue(presentation.childrenExpanded(parent.key, activeSessionKey = "", listOf(parent.key), emptyList()))
  }

  @Test
  fun collapsedParentsShowHiddenWorkAndUnreadChildrenButNotFailures() {
    fun activityFor(vararg children: ChatSessionEntry): SidebarSessionActivity? {
      val parent = session("parent", 100)
      val rows = listOf(parent) + children.map { it.copy(parentSessionKey = parent.key) }
      return sidebarSessionPresentation(rows, emptyList()).collapsedChildActivity(parent.key)
    }
    val idle = session("agent:main:subagent:idle", 10)

    assertNull(activityFor(idle))
    assertNull(activityFor(idle.copy(status = "failed", lastRunError = "boom")))
    // A failed child shows its failure on its own row, so its unread flag does not fold up either.
    assertNull(activityFor(idle.copy(status = "failed", unread = true)))
    assertEquals(SidebarSessionActivity.Unread, activityFor(idle.copy(unread = true)))
    val queued = session("agent:main:subagent:queued", 30).copy(status = "queued", hasActiveRun = true)
    assertEquals(SidebarSessionActivity.Queued, activityFor(idle.copy(unread = true), queued))
    assertEquals(
      SidebarSessionActivity.Running,
      activityFor(queued, session("agent:main:subagent:busy", 20).copy(status = "running")),
    )
  }

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
    category: String? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = activity,
      lastActivityAt = activity,
      pinned = pinned,
      archived = archived,
      category = category,
    )
}
