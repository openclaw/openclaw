package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.PersonalSessionPinAccess
import ai.openclaw.app.R
import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogState
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatSessionPatch
import ai.openclaw.app.chat.SIDEBAR_SESSION_PAGE_SIZE
import ai.openclaw.app.chat.SIDEBAR_SESSION_SEE_LESS_THRESHOLD
import ai.openclaw.app.chat.SessionSnooze
import ai.openclaw.app.chat.isSessionRunActive
import ai.openclaw.app.chat.normalizeSidebarSectionOrder
import ai.openclaw.app.defaultSidebarPageOrder
import ai.openclaw.app.defaultSidebarVisiblePages
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.operatorScopesAllowWrite
import ai.openclaw.app.sanitizeSidebarPageOrder
import ai.openclaw.app.ui.design.ClawColors
import ai.openclaw.app.ui.design.ClawIcons
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.ProviderBrandIcon
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.util.Collections
import kotlin.math.sign

internal enum class SidebarSessionDragSource {
  Catalog,
  Pinned,
  Recent,
}

internal fun sidebarSessionPinnedAfterDrag(
  source: SidebarSessionDragSource,
  direction: Int,
  currentlyPinned: Boolean = false,
): Boolean? =
  when {
    source == SidebarSessionDragSource.Catalog && direction < 0 && !currentlyPinned -> true
    source == SidebarSessionDragSource.Catalog && direction > 0 && currentlyPinned -> false
    source == SidebarSessionDragSource.Pinned && direction > 0 -> false
    source == SidebarSessionDragSource.Recent && direction < 0 -> true
    else -> null
  }

internal enum class SidebarDestination(
  val stableId: String,
  val settingsRoute: SettingsRoute? = null,
  val tab: Tab? = null,
  val icon: ImageVector = checkNotNull(settingsRoute).icon,
) {
  Settings(stableId = "settings", settingsRoute = SettingsRoute.Home),
  Work(stableId = "work", tab = Tab.Overview, icon = ClawIcons.Overview),
  Home(stableId = "home", tab = Tab.Chat, icon = ClawIcons.Chat),
  Skills(stableId = "skills", settingsRoute = SettingsRoute.Skills),
  Threads(stableId = "threads", tab = Tab.Sessions, icon = ClawIcons.Threads),
  Agents(stableId = "agents", settingsRoute = SettingsRoute.Agents),
  Automations(stableId = "automations", settingsRoute = SettingsRoute.CronJobs),
  Usage(stableId = "usage", settingsRoute = SettingsRoute.Usage),
  Dreaming(stableId = "dreaming", settingsRoute = SettingsRoute.Dreaming),
  Terminal(stableId = "terminal", settingsRoute = SettingsRoute.Terminal),
  Desktop(stableId = "desktop", settingsRoute = SettingsRoute.Desktop),
}

internal fun SidebarDestination.localizedLabel(): String =
  when (this) {
    SidebarDestination.Work -> nativeString("Overview")
    SidebarDestination.Home -> nativeString("Home")
    SidebarDestination.Threads -> nativeString("Threads")
    else -> checkNotNull(settingsRoute).title.resolveNativeText()
  }

private enum class SidebarPagesMenuMode {
  Closed,
  Navigate,
  Edit,
}

internal fun orderedSidebarDestinations(pageIds: List<String>): List<SidebarDestination> {
  val byId = SidebarDestination.entries.associateBy(SidebarDestination::stableId)
  return sanitizeSidebarPageOrder(pageIds).mapNotNull(byId::get)
}

internal fun moveSidebarDestination(
  pageIds: List<String>,
  destinationId: String,
  direction: Int,
  visiblePageIds: Set<String>? = null,
): List<String> {
  val ordered = orderedSidebarDestinations(pageIds).map(SidebarDestination::stableId).toMutableList()
  if (direction == 0) return ordered
  val visibleOrder = ordered.filter { visiblePageIds == null || it in visiblePageIds }
  val fromIndex = visibleOrder.indexOf(destinationId)
  if (fromIndex < 0) return ordered
  val targetId = visibleOrder.getOrNull(fromIndex + direction.sign) ?: return ordered
  // Swap visible slots so hidden pages keep their positions and never consume a drag step.
  Collections.swap(ordered, ordered.indexOf(destinationId), ordered.indexOf(targetId))
  return ordered
}

internal fun updateSidebarDestinationVisibility(
  visibleIds: List<String>,
  destination: SidebarDestination,
  visible: Boolean,
): List<String> {
  val current = visibleIds.toSet()
  if (!visible && destination.stableId in current && current.size == 1) return visibleIds
  val updated = if (visible) current + destination.stableId else current - destination.stableId
  return SidebarDestination.entries.map(SidebarDestination::stableId).filter(updated::contains)
}

internal data class SidebarSessionGroupSection(
  val name: String,
  val entries: List<ChatSessionEntry>,
)

internal data class SidebarSessionPresentation(
  val pinned: List<ChatSessionEntry>,
  val groups: List<SidebarSessionGroupSection>,
  /** Uncategorized channel group chats (gateway kind "group"), not catalog folders. */
  val chatGroups: List<ChatSessionEntry>,
  val recent: List<ChatSessionEntry>,
  /** Child-to-parent links for rows shown under a listed parent rather than in a section. */
  val parentByKey: Map<String, String> = emptyMap(),
  /** Nested children by parent key, in the same recency order as the sections. */
  val childrenByParent: Map<String, List<ChatSessionEntry>> = emptyMap(),
)

private val agentMainSessionKey = Regex("^agent:[^:]+:main$")

private fun isHomeSession(
  key: String,
  entry: ChatSessionEntry?,
): Boolean = entry?.isMain == true || key == "main" || agentMainSessionKey.matches(key)

/**
 * Parent links for the sidebar and Overview. Home is a page rather than a listed row, so its
 * children are top-level conversations, as on the web.
 */
internal fun navigationParentLinks(entries: List<ChatSessionEntry>): Map<String, String> {
  val entriesByKey = entries.associateBy { it.key }
  return sessionParentLinks(entries).filterValues { parent -> !isHomeSession(parent, entriesByKey[parent]) }
}

/** The top-level row that contains [key], so a nested active session keeps its parent on screen. */
internal fun SidebarSessionPresentation.rootKeyOf(key: String): String {
  var current = key
  val seen = mutableSetOf(current)
  while (true) {
    val parent = parentByKey[current] ?: return current
    if (!seen.add(parent)) return current
    current = parent
  }
}

/** [entries] plus their nested descendants, so a collapsed section still reports hidden attention. */
internal fun SidebarSessionPresentation.withDescendants(entries: List<ChatSessionEntry>): List<ChatSessionEntry> = entries.flatMap { entry -> listOf(entry) + descendantsOf(entry.key) }

/** Rows whose questions and approvals a session row reports; a collapsed parent carries its hidden children. */
internal fun SidebarSessionPresentation.attentionRows(
  session: ChatSessionEntry,
  childrenExpanded: Boolean,
): List<ChatSessionEntry> = if (childrenExpanded) listOf(session) else withDescendants(listOf(session))

/** Whether the open session is nested under one of [roots], so their section should reveal it. */
internal fun SidebarSessionPresentation.holdsNestedSession(
  roots: List<ChatSessionEntry>,
  activeSessionKey: String,
): Boolean = activeSessionKey in parentByKey && roots.any { it.key == rootKeyOf(activeSessionKey) }

/** Every nested descendant of [key], depth first. */
internal fun SidebarSessionPresentation.descendantsOf(key: String): List<ChatSessionEntry> = childrenByParent[key].orEmpty().flatMap { child -> listOf(child) + descendantsOf(child.key) }

/**
 * A collapsed parent shows work hidden in its children. Failures stay on the child row, matching
 * the web sidebar, so a finished failure does not keep flagging the parent.
 */
internal fun SidebarSessionPresentation.collapsedChildActivity(key: String): SidebarSessionActivity? = hiddenChildActivity(descendantsOf(key))

/** Child work hidden by a collapsed section, which no longer shows those children elsewhere. */
internal fun SidebarSessionPresentation.collapsedSectionChildActivity(roots: List<ChatSessionEntry>): SidebarSessionActivity? {
  val hidden = roots.flatMap { descendantsOf(it.key) }
  return hiddenChildActivity(hidden)
}

private fun hiddenChildActivity(descendants: List<ChatSessionEntry>): SidebarSessionActivity? {
  // Classify each child as its own row would; a failed child keeps its failure on that row.
  val activities =
    descendants.mapNotNullTo(mutableSetOf()) {
      sidebarSessionActivity(status = it.status, lastRunError = it.lastRunError, hasActiveRun = it.hasActiveRun, unread = it.unread == true)
    }
  return listOf(SidebarSessionActivity.Running, SidebarSessionActivity.Queued, SidebarSessionActivity.Unread).firstOrNull { it in activities }
}

/**
 * Parents start collapsed. One that contains the open session starts expanded so the selection
 * stays visible, unless the user collapsed it.
 */
internal fun SidebarSessionPresentation.childrenExpanded(
  key: String,
  activeSessionKey: String,
  expandedKeys: Collection<String>,
  collapsedKeys: Collection<String>,
): Boolean =
  key in expandedKeys ||
    (key !in collapsedKeys && descendantsOf(key).any { it.key == activeSessionKey })

internal fun sidebarRecentSessions(
  sessions: List<ChatSessionEntry>,
  currentSessionKey: String = "",
  nowMs: Long = System.currentTimeMillis(),
  personalPins: Boolean = false,
): List<ChatSessionEntry> =
  sessions
    .filter { isSessionVisibleInNavigation(it, currentSessionKey, nowMs) }
    .sortedForSessionSections(
      personalPins,
      compareByDescending<ChatSessionEntry> { it.pinned == true }
        .thenByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        .thenBy { it.key },
    )

/**
 * Category folders follow the gateway catalog order, then unknown categories.
 * Empty catalog folders stay. Pinned rows stay in Pinned. kind=="group" rows
 * without a category form the Groups zone. Recent is everything else, so the
 * Recent cap does not hide folder members or channel groups.
 */
internal fun sidebarSessionGroupSections(
  sessions: List<ChatSessionEntry>,
  knownGroups: List<String>,
): List<SidebarSessionGroupSection> {
  val byCategory = linkedMapOf<String, MutableList<ChatSessionEntry>>()
  val known =
    knownGroups.mapNotNull { name ->
      val trimmed = name.trim()
      if (trimmed.isEmpty() || byCategory.containsKey(trimmed)) {
        null
      } else {
        byCategory[trimmed] = mutableListOf()
        trimmed
      }
    }
  for (session in sessions) {
    val category = session.category?.trim()?.takeIf { it.isNotEmpty() } ?: continue
    byCategory.getOrPut(category) { mutableListOf() }.add(session)
  }
  val extras = byCategory.keys.filter { it !in known }.sortedWith(String.CASE_INSENSITIVE_ORDER)
  return (known + extras).map { name -> SidebarSessionGroupSection(name, byCategory[name].orEmpty()) }
}

internal fun sidebarSessionPresentation(
  sessions: List<ChatSessionEntry>,
  knownGroups: List<String>,
  excludedSessionKeys: Set<String> = emptySet(),
  currentSessionKey: String = "",
  nowMs: Long = System.currentTimeMillis(),
  personalPins: Boolean = false,
): SidebarSessionPresentation {
  val activeSessions = sidebarRecentSessions(sessions, currentSessionKey, nowMs, personalPins)
  // Catalog sections own their rows, so those rows neither nest here nor hold children here.
  val listed = activeSessions.filter { it.pinned == true || it.key !in excludedSessionKeys }
  val parentByKey = navigationParentLinks(listed)
  val childrenByParent = listed.filter { it.key in parentByKey }.groupBy { parentByKey.getValue(it.key) }
  val latestActivity = mutableMapOf<String, Long>()

  fun threadActivity(session: ChatSessionEntry): Long =
    latestActivity.getOrPut(session.key) {
      childrenByParent[session.key].orEmpty().fold(session.lastActivityAt ?: session.updatedAtMs ?: 0L) { latest, child ->
        maxOf(latest, threadActivity(child))
      }
    }
  // A parent ranks by its newest child, so a child's new work keeps the thread on the first page.
  val roots =
    listed
      .filter { it.key !in parentByKey }
      .sortedForSessionSections(
        personalPins,
        compareByDescending<ChatSessionEntry> { it.pinned == true }
          .thenByDescending(::threadActivity)
          .thenBy { it.key },
      )
  val pinned = roots.filter { it.pinned == true }
  val navigable = roots.filter { it.pinned != true }
  val grouped = navigable.filter { !it.category.isNullOrBlank() }
  val ungrouped = navigable.filter { it.category.isNullOrBlank() }
  // An explicit category wins, matching web/Mac. Groups is only kind=="group".
  val chatGroups = ungrouped.filter { it.kind == "group" }
  val recent = ungrouped.filter { it.kind != "group" }

  return SidebarSessionPresentation(
    pinned = pinned,
    groups = sidebarSessionGroupSections(grouped, knownGroups),
    chatGroups = chatGroups,
    recent = recent,
    parentByKey = parentByKey,
    childrenByParent = childrenByParent,
  )
}

internal fun sessionPresentationTitle(
  session: ChatSessionEntry,
  unnamedTitle: () -> String,
): String =
  session.label?.trim()?.takeIf(String::isNotEmpty)
    ?: session.displayName?.trim()?.takeIf(String::isNotEmpty)
    ?: session.autoLabel?.trim()?.takeIf(String::isNotEmpty)
    ?: session.localFallbackTitle?.trim()?.takeIf(String::isNotEmpty)
    ?: nativeString("New chat").takeIf { session.isDashboardSession() }
    ?: unnamedTitle()

private fun ChatSessionEntry.isDashboardSession(): Boolean {
  if (classification == "dashboard") return true
  val parts = key.split(':', limit = 4)
  return parts.size == 4 && parts[0] == "agent" && parts[2] == "dashboard"
}

internal data class SidebarCatalogWorkspace(
  val stableId: String,
  val label: String,
  val path: String?,
  val sessions: List<SessionCatalogEntry>,
)

internal data class SidebarCatalogHost(
  val stableId: String,
  val label: String,
  val connected: Boolean,
  val errorText: String?,
  val workspaces: List<SidebarCatalogWorkspace>,
  val canLoadMore: Boolean,
)

internal data class SidebarCatalogSection(
  val catalog: SessionCatalog,
  val expanded: Boolean,
)

internal fun sidebarCatalogSections(
  catalogs: List<SessionCatalog>,
  expandedCatalogIds: Collection<String>,
): List<SidebarCatalogSection> =
  catalogs
    .filter { catalog ->
      catalog.canCreateSession ||
        catalog.errorText != null ||
        catalog.hosts.any { host ->
          host.errorText != null || host.nextCursor != null || host.sessions.any { !it.archived }
        }
    }.map { catalog ->
      SidebarCatalogSection(
        catalog = catalog,
        expanded = catalog.id in expandedCatalogIds,
      )
    }

internal fun sidebarCatalogSessionCreationEnabled(
  catalog: SessionCatalog,
  canMutateSessions: Boolean,
): Boolean = catalog.canCreateSession && canMutateSessions

internal fun toggleSidebarExpansion(
  ids: List<String>,
  id: String,
): List<String> = if (id in ids) ids - id else ids + id

internal fun sidebarCatalogRefreshNeeded(
  catalogAgentId: String?,
  selectedAgentId: String?,
  anyCatalogExpanded: Boolean,
  catalogDiscoveryNeeded: Boolean,
): Boolean {
  val normalizedSelectedAgentId = selectedAgentId?.trim()?.takeIf(String::isNotEmpty)
  return catalogAgentId != normalizedSelectedAgentId ||
    anyCatalogExpanded ||
    catalogDiscoveryNeeded
}

internal fun sidebarCatalogHosts(catalogs: List<SessionCatalog>): List<SidebarCatalogHost> =
  catalogs.flatMap { catalog ->
    catalog.hosts.mapNotNull { host ->
      val workspaces =
        host.sessions
          .asSequence()
          .filterNot(SessionCatalogEntry::archived)
          .groupBy { it.cwd?.trim()?.takeIf(String::isNotEmpty) }
          .map { (cwd, sessions) ->
            val normalizedPath = cwd?.replace('\\', '/')?.trimEnd('/')
            val label =
              normalizedPath
                ?.substringAfterLast('/')
                ?.takeIf(String::isNotEmpty)
                ?: nativeString("Other work")
            SidebarCatalogWorkspace(
              stableId = listOf(catalog.id, host.hostId, cwd.orEmpty()).joinToString("::"),
              label = label,
              path = cwd,
              sessions =
                sessions.sortedWith(
                  compareByDescending<SessionCatalogEntry> { it.recencyAt ?: Double.NEGATIVE_INFINITY }
                    .thenBy { it.name ?: it.threadId },
                ),
            )
          }.sortedWith(
            compareBy<SidebarCatalogWorkspace> { it.path == null }
              .thenBy(String.CASE_INSENSITIVE_ORDER, SidebarCatalogWorkspace::label),
          )
      // Android has no archived catalog view; hide a fully filtered host only after pagination is exhausted.
      if (
        workspaces.isEmpty() &&
        host.sessions.isNotEmpty() &&
        host.nextCursor == null &&
        host.errorText.isNullOrBlank()
      ) {
        return@mapNotNull null
      }
      SidebarCatalogHost(
        stableId = listOf(catalog.id, host.hostId).joinToString("::"),
        label = host.label,
        connected = host.connected,
        errorText = host.errorText,
        workspaces = workspaces,
        canLoadMore = host.nextCursor != null,
      )
    }
  }

internal fun sidebarVisibleCatalogSessionKeys(catalogs: List<SessionCatalog>): Set<String> =
  sidebarCatalogHosts(catalogs)
    .asSequence()
    .flatMap { it.workspaces.asSequence() }
    .flatMap { it.sessions.asSequence() }
    .mapNotNull(SessionCatalogEntry::sessionKey)
    .toSet()

internal data class SidebarPalette(
  val background: Color,
  val elevated: Color,
  val selection: Color,
  val text: Color,
  val muted: Color,
  val hairline: Color,
)

internal fun sidebarPalette(colors: ClawColors): SidebarPalette =
  SidebarPalette(
    background = colors.canvas,
    elevated = colors.surfaceRaised,
    selection = colors.accentSoft,
    text = colors.text,
    muted = colors.textMuted,
    hairline = colors.border,
  )

internal data class SidebarSectionWindow(
  val rows: List<ChatSessionEntry>,
  val canShowMore: Boolean,
  val canShowLess: Boolean,
)

/** The active session stays visible even outside the locally revealed page. */
internal fun sidebarSectionWindow(
  entries: List<ChatSessionEntry>,
  visibleLimit: Int,
  activeSessionKey: String,
): SidebarSectionWindow {
  val limit = visibleLimit.coerceAtLeast(0)
  val total = entries.size
  val canShowLess = limit > SIDEBAR_SESSION_PAGE_SIZE && total > SIDEBAR_SESSION_SEE_LESS_THRESHOLD
  if (limit >= total) {
    return SidebarSectionWindow(
      rows = entries,
      canShowMore = false,
      canShowLess = canShowLess,
    )
  }
  val page = entries.take(limit).toMutableList()
  val shown = page.mapTo(HashSet()) { it.key }
  val active = entries.firstOrNull { it.key == activeSessionKey && it.key !in shown }
  if (active != null) page.add(active)
  return SidebarSectionWindow(
    rows = page,
    canShowMore = true,
    canShowLess = canShowLess && page.size > SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  )
}

@Composable
internal fun OpenClawSidebar(
  viewModel: MainViewModel,
  agents: List<GatewayAgentSummary>,
  selectedAgentId: String?,
  sessions: List<ChatSessionEntry>,
  activeSessionKey: String,
  activeDestination: SidebarDestination?,
  connection: GatewayConnectionDisplay,
  visible: Boolean,
  showCloseButton: Boolean,
  onClose: () -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
  onNewSession: () -> Unit,
  onSelectAgent: (String) -> Unit,
  onSelectSession: (ChatSessionEntry) -> Unit,
  onSelectCatalogSession: (SessionCatalogEntry) -> Unit,
  onCreateCatalogSession: (String) -> Unit,
  onSelectDestination: (SidebarDestination) -> Unit,
) {
  val palette = sidebarPalette(ClawTheme.colors)
  var sessionNowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val scrollState = rememberScrollState()
  val agentPicker = agentPickerState(agents, selectedAgentId)
  val localGroups by viewModel.sessionCustomGroups.collectAsState()
  val groupCatalog by viewModel.sessionGroupCatalog.collectAsState()
  val rosterHasMore by viewModel.sessionRosterHasMore.collectAsState()
  val rosterLoadingMore by viewModel.sessionRosterLoadingMore.collectAsState()
  val rosterLoadFailed by viewModel.sessionRosterLoadFailed.collectAsState()
  val storedGroups = (groupCatalog.names + localGroups).distinct()
  val questions by viewModel.chatQuestions.collectAsState()
  val approvalInbox by viewModel.execApprovalInbox.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val gatewayStableId by viewModel.activeGatewayStableId.collectAsState()
  val attentionRequests = remember(questions, approvalInbox, defaultAgentId) { sidebarAttentionRequests(questions, approvalInbox.approvals, defaultAgentId) }

  fun attentionFor(keys: Collection<String>): SidebarAttention? {
    val canonical = keys.mapTo(mutableSetOf()) { sidebarAttentionSessionKey(it, selectedAgentId ?: defaultAgentId) }
    return summarizeSidebarAttention(attentionRequests.filter { it.sessionKey in canonical }, gatewayStableId)
  }
  val catalogState by viewModel.sessionCatalogState.collectAsState()
  val sessionCreating by viewModel.chatSessionCreating.collectAsState()
  val catalogAvailable by viewModel.sessionCatalogAvailable.collectAsState()
  val operatorScopes by viewModel.operatorScopes.collectAsState()
  val canMutateSessions = operatorScopesAllowWrite(operatorScopes)
  val liveSessionsByKey = remember(sessions) { sessions.associateBy(ChatSessionEntry::key) }
  val pageOrder by viewModel.sidebarPageOrder.collectAsState()
  val visiblePageIds by viewModel.sidebarVisiblePages.collectAsState()
  var query by rememberSaveable { mutableStateOf("") }
  var searchVisible by rememberSaveable { mutableStateOf(false) }
  val searchFocus = remember { FocusRequester() }
  var searchFocused by remember { mutableStateOf(false) }
  val restoreSearchFocus = searchVisible && searchFocused && !showCloseButton
  LaunchedEffect(showCloseButton) {
    // Only the previously focused field may reclaim focus after moving out of the modal host.
    if (restoreSearchFocus) searchFocus.requestFocus()
  }
  var pagesExpanded by rememberSaveable { mutableStateOf(true) }
  var pagesMenuMode by rememberSaveable { mutableStateOf(SidebarPagesMenuMode.Closed) }
  val visibleLimits = remember(gatewayStableId, selectedAgentId) { mutableStateMapOf<String, Int>() }
  var collapsedGroups by rememberSaveable(gatewayStableId, selectedAgentId) { mutableStateOf(emptyList<String>()) }
  var expandedParentKeys by rememberSaveable(gatewayStableId, selectedAgentId) { mutableStateOf(emptyList<String>()) }
  var collapsedParentKeys by rememberSaveable(gatewayStableId, selectedAgentId) { mutableStateOf(emptyList<String>()) }
  var chatGroupsExpanded by rememberSaveable(gatewayStableId, selectedAgentId) { mutableStateOf(true) }
  var expandedCatalogIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
  // Null until the user toggles Pinned; until then it opens only to reveal an open nested child.
  var pinnedExpandedChoice by rememberSaveable { mutableStateOf<Boolean?>(null) }
  var recentExpanded by rememberSaveable { mutableStateOf(false) }
  var collapsedCatalogHostIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
  var collapsedCatalogWorkspaceIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
  val catalogSections = sidebarCatalogSections(catalogState.catalogs, expandedCatalogIds)
  val anyCatalogExpanded = catalogSections.any(SidebarCatalogSection::expanded)
  val catalogDiscoveryNeeded = catalogSections.isEmpty()
  val catalogRefreshNeeded =
    sidebarCatalogRefreshNeeded(
      catalogAgentId = catalogState.agentId,
      selectedAgentId = selectedAgentId,
      anyCatalogExpanded = anyCatalogExpanded,
      catalogDiscoveryNeeded = catalogDiscoveryNeeded,
    )
  val catalogErrorText = catalogState.errorText
  val catalogSessionKeys = sidebarVisibleCatalogSessionKeys(catalogState.catalogs)
  val gatewayPinAccess by viewModel.personalSessionPinAccess.collectAsState()
  val personalPins = gatewayPinAccess != PersonalSessionPinAccess.Unsupported
  val pinAccess = if (connection.isConnected) gatewayPinAccess else PersonalSessionPinAccess.ReadOnly
  val recentPresentation =
    sidebarSessionPresentation(
      sessions = sessions,
      knownGroups = storedGroups,
      excludedSessionKeys = catalogSessionKeys,
      currentSessionKey = activeSessionKey,
      nowMs = sessionNowMs,
      personalPins = personalPins,
    )
  val pinnedSessions = recentPresentation.pinned
  val pinnedExpanded = pinnedExpandedChoice ?: recentPresentation.holdsNestedSession(pinnedSessions, activeSessionKey)
  val recentRows = recentPresentation.recent
  val groupsByName = recentPresentation.groups.associateBy { it.name }
  val sectionOrder =
    normalizeSidebarSectionOrder(
      groupCatalog.sectionOrder,
      recentPresentation.groups.map { it.name },
      if (catalogAvailable) catalogSections.map { it.catalog.id } else emptyList(),
    )
  val desktopObserveAvailable by viewModel.desktopObserveAvailable.collectAsState()
  val orderedPages = orderedSidebarDestinations(pageOrder).filter { it.settingsRoute?.isAvailable(desktopObserveAvailable) != false }
  val visiblePageIdSet = visiblePageIds.toSet()
  val visiblePages = orderedPages.filter { it.stableId in visiblePageIdSet }

  fun movePage(
    destination: SidebarDestination,
    direction: Int,
    visibleOnly: Boolean,
  ): Boolean {
    // Drag and accessibility both recheck authoritative preferences, including back-to-back actions.
    val current = viewModel.sidebarPageOrder.value
    val next =
      moveSidebarDestination(
        pageIds = current,
        destinationId = destination.stableId,
        direction = direction,
        visiblePageIds =
          orderedPages.map(SidebarDestination::stableId).toSet().let { available ->
            if (visibleOnly) available.intersect(viewModel.sidebarVisiblePages.value.toSet()) else available
          },
      )
    if (next == current) return false
    viewModel.setSidebarPageOrder(next)
    return true
  }
  val setSessionPinned: (String, String?, Boolean) -> Unit = { key, ownerAgentId, pinned ->
    scope.launch {
      viewModel.patchChatSession(ChatSessionPatch(key = key, ownerAgentId = ownerAgentId, pinned = pinned))
    }
  }

  @Composable
  fun SessionNode(
    session: ChatSessionEntry,
    depth: Int,
    dragSource: SidebarSessionDragSource?,
    nested: Boolean,
  ) {
    val children = if (nested) recentPresentation.childrenByParent[session.key].orEmpty() else emptyList()
    val expanded =
      children.isNotEmpty() &&
        recentPresentation.childrenExpanded(session.key, activeSessionKey, expandedParentKeys, collapsedParentKeys)
    // Flat search rows stand alone; only a disclosure may carry hidden children's requests.
    val attentionRows = if (nested) recentPresentation.attentionRows(session, expanded) else listOf(session)
    SidebarSessionRow(
      session = session,
      attention = attentionFor(attentionRows.map { sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId) }),
      selected = session.key == activeSessionKey,
      palette = palette,
      onClick = { onSelectSession(session) },
      onDragCommit =
        if (dragSource != null && pinAccess.nextSessionPin(session, sessionNowMs) != null) {
          { direction ->
            sidebarSessionPinnedAfterDrag(dragSource, direction)?.takeIf { it == pinAccess.nextSessionPin(session, sessionNowMs) }?.let { pinned ->
              setSessionPinned(session.key, session.ownerAgentId, pinned)
            }
          }
        } else {
          null
        },
      onDragActiveChange = if (dragSource == null) ({}) else onDragActiveChange,
      depth = depth,
      children =
        children.takeIf { it.isNotEmpty() }?.let {
          SidebarSessionChildren(
            count = it.size,
            expanded = expanded,
            collapsedActivity = recentPresentation.collapsedChildActivity(session.key),
            onToggle = {
              if (expanded) {
                expandedParentKeys = expandedParentKeys - session.key
                collapsedParentKeys = collapsedParentKeys + session.key
              } else {
                collapsedParentKeys = collapsedParentKeys - session.key
                expandedParentKeys = expandedParentKeys + session.key
              }
            },
          )
        },
    )
    // Child rows are reached through their parent; pinning by drag stays a top-level gesture.
    if (expanded) children.forEach { child -> SessionNode(child, depth + 1, dragSource = null, nested = true) }
  }

  @Composable
  fun SessionRows(
    entries: List<ChatSessionEntry>,
    dragSource: SidebarSessionDragSource?,
    nested: Boolean = true,
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      entries.forEach { session -> SessionNode(session, depth = 0, dragSource = dragSource, nested = nested) }
    }
  }
  LaunchedEffect(connection.isConnected, gatewayStableId, selectedAgentId, visible) {
    if (connection.isConnected && visible) {
      viewModel.refreshSessionGroups()
      viewModel.refreshCurrentChatSessionWindow()
    }
  }
  val sectionRows: @Composable (String, List<ChatSessionEntry>) -> Unit = { token, entries ->
    val window = sidebarSectionWindow(entries, visibleLimits[token] ?: SIDEBAR_SESSION_PAGE_SIZE, recentPresentation.rootKeyOf(activeSessionKey))
    SessionRows(window.rows, SidebarSessionDragSource.Recent)
    if (window.canShowMore) {
      SidebarActionRow(nativeString("Show more"), Icons.Default.KeyboardArrowDown, palette, onClick = {
        visibleLimits[token] = (visibleLimits[token] ?: SIDEBAR_SESSION_PAGE_SIZE) + SIDEBAR_SESSION_PAGE_SIZE
      })
    }
    if (window.canShowLess) {
      SidebarActionRow(nativeString("Show less"), Icons.Default.KeyboardArrowUp, palette, onClick = {
        visibleLimits[token] = SIDEBAR_SESSION_PAGE_SIZE
      })
    }
  }
  LaunchedEffect(
    connection.isConnected,
    selectedAgentId,
    anyCatalogExpanded,
    catalogRefreshNeeded,
    catalogDiscoveryNeeded,
    visible,
    lifecycle,
    catalogAvailable,
  ) {
    if (
      !connection.isConnected ||
      !catalogAvailable ||
      !visible
    ) {
      return@LaunchedEffect
    }
    if (!catalogRefreshNeeded) return@LaunchedEffect
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      viewModel.refreshSessionCatalog(selectedAgentId)
      viewModel.sessionCatalogState
        .map { state ->
          state.errorText != null ||
            state.catalogs.any { catalog ->
              catalog.errorText != null || catalog.hosts.any { it.errorText != null }
            }
        }.distinctUntilChanged()
        .collectLatest { failed ->
          while (true) {
            delay(if (failed) 30_000L else 120_000L)
            viewModel.refreshSessionCatalog(selectedAgentId)
          }
        }
    }
  }
  // Canonical debounced gateway search shared with the Sessions browser; the
  // controller falls back to filtering cached rows when the gateway is offline.
  val searchState =
    rememberSessionBrowserSearchState(
      viewModel = viewModel,
      sessions = sessions,
      query = query,
      archived = false,
    )
  val windowWake by viewModel.sessionWindowWake.collectAsState()
  val nextWake =
    listOfNotNull(
      SessionSnooze.nextWake(sessions, sessionNowMs, windowWake),
      SessionSnooze.nextWake(searchState.entries, sessionNowMs, windowWake),
    ).minByOrNull { it.localMs }
  LaunchedEffect(nextWake, personalPins, gatewayStableId, visible, lifecycle) {
    val wake = nextWake ?: return@LaunchedEffect
    if (!visible) return@LaunchedEffect
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      sessionNowMs = awaitSessionStatusExpiry(wake.localMs)
      if (personalPins) viewModel.refreshChatSessionsAfterWake(wake)
    }
  }
  val searchResults =
    resolveSessionBrowserEntries(
      entries = searchState.entries,
      currentSessionKey = activeSessionKey,
      filter = SessionFilter.Recent,
      recentFirst = true,
      nowMs = sessionNowMs,
      personalPins = personalPins,
    )

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(palette.background)
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(horizontal = 14.dp, vertical = 10.dp),
  ) {
    // The compact search field is opt-in from the header, matching the web sidebar.
    Row(
      modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      if (agentPicker.selected != null) {
        AgentPicker(
          state = agentPicker,
          onSelectAgent = onSelectAgent,
          modifier = Modifier.weight(1f),
        )
      } else {
        OpenClawMascot(modifier = Modifier.size(28.dp))
        Text(
          text = "OpenClaw",
          modifier = Modifier.weight(1f),
          style = ClawTheme.type.title,
          color = palette.text,
          maxLines = 1,
        )
      }
      IconButton(
        onClick = {
          if (searchVisible) query = ""
          searchVisible = !searchVisible
        },
        modifier = Modifier.size(48.dp).testTag("sidebar-search-toggle"),
      ) {
        Icon(
          imageVector = Icons.Default.Search,
          contentDescription = nativeString(if (searchVisible) "Hide search" else "Search sessions"),
          tint = palette.text,
          modifier = Modifier.size(20.dp),
        )
      }
      IconButton(
        onClick = onNewSession,
        enabled = !sessionCreating,
        modifier =
          Modifier.size(48.dp).semantics {
            contentDescription = nativeString("New session")
            if (sessionCreating) stateDescription = nativeString("Loading")
          },
      ) {
        if (sessionCreating) {
          CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = palette.text)
        } else {
          Icon(
            imageVector = Icons.Default.Add,
            contentDescription = null,
            tint = palette.text,
            modifier = Modifier.size(22.dp),
          )
        }
      }
      if (showCloseButton) {
        IconButton(onClick = onClose, modifier = Modifier.size(48.dp).testTag("sidebar-close")) {
          Icon(
            imageVector = Icons.Default.Close,
            contentDescription = nativeString("Hide Sidebar"),
            tint = palette.text,
            modifier = Modifier.size(20.dp),
          )
        }
      }
    }
    if (searchVisible) {
      SidebarSearchField(
        query = query,
        onQueryChange = { query = it },
        palette = palette,
        modifier =
          Modifier
            .padding(top = 4.dp, bottom = 10.dp)
            .focusRequester(searchFocus)
            .onFocusChanged { searchFocused = it.isFocused },
      )
    }

    // Cancel gesture-bearing rows when changing hosts; keep navigation, search and scroll above it.
    key(showCloseButton) {
      Column(
        modifier =
          Modifier
            .weight(1f)
            .fillMaxWidth()
            .verticalScroll(scrollState),
      ) {
        if (searchState.query.isNotEmpty()) {
          SidebarSectionTitle(nativeString("Threads"), palette)
          if (searchResults.isEmpty()) {
            Text(
              text = if (searchState.loading) nativeString("Searching threads") else nativeString("No matching threads"),
              style = ClawTheme.type.caption,
              color = palette.muted,
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            )
          } else {
            // Search lists each match once, without pulling in children that did not match.
            SessionRows(searchResults, dragSource = null, nested = false)
          }
        } else {
          SidebarPagesHeader(
            expanded = pagesExpanded,
            menuMode = pagesMenuMode,
            destinations = orderedPages,
            visiblePageIds = visiblePageIdSet,
            activeDestination = activeDestination,
            palette = palette,
            onToggleExpanded = { pagesExpanded = !pagesExpanded },
            onMenuModeChange = { pagesMenuMode = it },
            onSelectDestination = onSelectDestination,
            onVisibilityChange = { destination, visible ->
              viewModel.setSidebarVisiblePages(
                updateSidebarDestinationVisibility(
                  visibleIds = visiblePageIds,
                  destination = destination,
                  visible = visible,
                ),
              )
            },
            onMove = { destination, direction -> movePage(destination, direction, visibleOnly = false) },
            onReset = {
              viewModel.setSidebarPageOrder(defaultSidebarPageOrder)
              viewModel.setSidebarVisiblePages(defaultSidebarVisiblePages)
            },
            onDragActiveChange = onDragActiveChange,
          )
          if (pagesExpanded) {
            visiblePages.forEachIndexed { index, destination ->
              key(destination.stableId) {
                SidebarNavigationRow(
                  destination = destination,
                  selected = destination == activeDestination,
                  palette = palette,
                  onClick = { onSelectDestination(destination) },
                  canMoveUp = index > 0,
                  canMoveDown = index < visiblePages.lastIndex,
                  onMove = { direction -> movePage(destination, direction, visibleOnly = true) },
                  onDragActiveChange = onDragActiveChange,
                )
              }
            }
          }
          SidebarCollapsibleHeader(
            label = nativeString("Pinned"),
            attention = if (pinnedExpanded) null else attentionFor(recentPresentation.withDescendants(pinnedSessions).map { sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId) }),
            expanded = pinnedExpanded,
            palette = palette,
            hiddenActivity = if (pinnedExpanded) null else recentPresentation.collapsedSectionChildActivity(pinnedSessions),
            onClick = { pinnedExpandedChoice = !pinnedExpanded },
            modifier = Modifier.padding(top = 10.dp),
          )
          if (pinnedExpanded) {
            if (connection.isConnected && !personalPins) {
              SidebarCatalogStatus(nativeString("Update the Gateway to change personal session pins."), palette)
            } else if (connection.isConnected && pinAccess == PersonalSessionPinAccess.ReadOnly) {
              SidebarCatalogStatus(nativeString("Personal pins are read-only here."), palette)
            }
            if (pinnedSessions.isEmpty()) {
              Text(
                text = nativeString("No pinned sessions"),
                style = ClawTheme.type.caption,
                color = palette.muted,
                modifier = Modifier.padding(horizontal = 40.dp, vertical = 10.dp),
              )
            } else {
              SessionRows(pinnedSessions, SidebarSessionDragSource.Pinned)
            }
          }

          for (token in sectionOrder) {
            when {
              token.startsWith("catalog:") -> {
                val section = catalogSections.firstOrNull { it.catalog.id == token.removePrefix("catalog:") }
                if (section != null) {
                  val catalog = section.catalog
                  key("catalog:${catalog.id}") {
                    SidebarCollapsibleHeader(
                      label = catalog.label,
                      attention = if (section.expanded) null else attentionFor(sidebarVisibleCatalogSessionKeys(listOf(catalog))),
                      expanded = section.expanded,
                      palette = palette,
                      iconContent = {
                        ProviderBrandIcon(provider = catalog.id, size = 18.dp)
                      },
                      trailingContent =
                        if (
                          sidebarCatalogSessionCreationEnabled(catalog, canMutateSessions) &&
                          catalogState.continuingEntryId == null
                        ) {
                          {
                            IconButton(
                              onClick = { onCreateCatalogSession(catalog.id) },
                              enabled = !sessionCreating,
                              modifier = Modifier.size(40.dp),
                            ) {
                              Icon(
                                imageVector = Icons.Default.Add,
                                contentDescription = nativeString("New session"),
                                tint = palette.text,
                                modifier = Modifier.size(18.dp),
                              )
                            }
                          }
                        } else {
                          null
                        },
                      onClick = {
                        expandedCatalogIds = toggleSidebarExpansion(expandedCatalogIds, catalog.id)
                      },
                    )
                    if (section.expanded) {
                      SidebarSessionCatalog(
                        attentionFor = ::attentionFor,
                        state = catalogState,
                        catalog = catalog,
                        activeSessionKey = activeSessionKey,
                        liveSessionsByKey = liveSessionsByKey,
                        collapsedHostIds = collapsedCatalogHostIds.toSet(),
                        collapsedWorkspaceIds = collapsedCatalogWorkspaceIds.toSet(),
                        palette = palette,
                        onToggleHost = { stableId ->
                          collapsedCatalogHostIds = toggleSidebarExpansion(collapsedCatalogHostIds, stableId)
                        },
                        onToggleWorkspace = { stableId ->
                          collapsedCatalogWorkspaceIds = toggleSidebarExpansion(collapsedCatalogWorkspaceIds, stableId)
                        },
                        onSelectSession = onSelectCatalogSession,
                        onLoadMore = viewModel::loadMoreSessionCatalog,
                        canMutateSessions = canMutateSessions,
                        pinAccess = pinAccess,
                        nowMs = sessionNowMs,
                        onPinSession = setSessionPinned,
                        onDragActiveChange = onDragActiveChange,
                      )
                    }
                  }
                }
              }

              token.startsWith("category:") -> {
                val group = groupsByName[token.removePrefix("category:")] ?: continue
                val expanded = group.name !in collapsedGroups
                SidebarCollapsibleHeader(
                  label = group.name,
                  attention = if (expanded) null else attentionFor(recentPresentation.withDescendants(group.entries).map { it.key }),
                  expanded = expanded,
                  palette = palette,
                  iconContent = { Icon(Icons.Outlined.Folder, contentDescription = null, modifier = Modifier.size(18.dp)) },
                  hiddenActivity = if (expanded) null else recentPresentation.collapsedSectionChildActivity(group.entries),
                  onClick = { collapsedGroups = toggleSidebarExpansion(collapsedGroups, group.name) },
                )
                if (expanded) sectionRows(token, group.entries)
              }

              token == "groups" && recentPresentation.chatGroups.isNotEmpty() -> {
                SidebarCollapsibleHeader(
                  label = nativeString("Groups"),
                  attention = if (chatGroupsExpanded) null else attentionFor(recentPresentation.withDescendants(recentPresentation.chatGroups).map { it.key }),
                  expanded = chatGroupsExpanded,
                  palette = palette,
                  hiddenActivity = if (chatGroupsExpanded) null else recentPresentation.collapsedSectionChildActivity(recentPresentation.chatGroups),
                  onClick = { chatGroupsExpanded = !chatGroupsExpanded },
                )
                if (chatGroupsExpanded) sectionRows(token, recentPresentation.chatGroups)
              }

              token == "ungrouped" -> {
                SidebarCollapsibleHeader(
                  label = nativeString("Recent"),
                  attention = if (recentExpanded) null else attentionFor(recentPresentation.withDescendants(recentRows).map { it.key }),
                  expanded = recentExpanded,
                  palette = palette,
                  hiddenActivity = if (recentExpanded) null else recentPresentation.collapsedSectionChildActivity(recentRows),
                  onClick = { recentExpanded = !recentExpanded },
                )
                if (recentExpanded) {
                  if (recentRows.isEmpty()) {
                    Text(
                      nativeString("No recent sessions"),
                      style = ClawTheme.type.caption,
                      color = palette.muted,
                      modifier = Modifier.padding(horizontal = 40.dp, vertical = 10.dp),
                    )
                  } else {
                    sectionRows(token, recentRows)
                  }
                }
              }
            }
          }
          if (catalogAvailable) {
            if (catalogState.loading) SidebarCatalogStatus(nativeString("Loading"), palette, progress = true)
            catalogErrorText?.let { SidebarCatalogStatus(it, palette) }
          }
          if (rosterHasMore) {
            if (rosterLoadFailed) {
              SidebarCatalogStatus(nativeString("Could not load more sessions. Try again."), palette)
            }
            SidebarActionRow(
              label = nativeString(if (rosterLoadingMore) "Loading" else "Load more sessions"),
              icon = Icons.Default.KeyboardArrowDown,
              palette = palette,
              onClick = { if (!rosterLoadingMore) scope.launch { viewModel.loadMoreChatSessions() } },
            )
          }
        }
      }
    }
    HorizontalDivider(color = palette.hairline)
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Box(Modifier.weight(1f)) {
        SidebarGatewayControl(viewModel, connection, palette) {
          viewModel.openGatewaySettings()
          onClose()
        }
      }
      IconButton(
        onClick = { onSelectDestination(SidebarDestination.Settings) },
        modifier = Modifier.size(48.dp),
      ) {
        Icon(
          imageVector = SettingsRoute.Home.icon,
          contentDescription = nativeString("Settings"),
          tint = palette.text,
          modifier = Modifier.size(20.dp),
        )
      }
    }
  }
}

@Composable
private fun SidebarPagesHeader(
  expanded: Boolean,
  menuMode: SidebarPagesMenuMode,
  destinations: List<SidebarDestination>,
  visiblePageIds: Set<String>,
  activeDestination: SidebarDestination?,
  palette: SidebarPalette,
  onToggleExpanded: () -> Unit,
  onMenuModeChange: (SidebarPagesMenuMode) -> Unit,
  onSelectDestination: (SidebarDestination) -> Unit,
  onVisibilityChange: (SidebarDestination, Boolean) -> Unit,
  onMove: (SidebarDestination, Int) -> Boolean,
  onReset: () -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      modifier =
        Modifier
          .weight(1f)
          .heightIn(min = 44.dp)
          .clip(RoundedCornerShape(10.dp))
          .clickable(role = Role.Button, onClick = onToggleExpanded)
          .padding(horizontal = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      SidebarDisclosureIcon(expanded, palette)
      Text(
        text = nativeString("Pages"),
        style = ClawTheme.type.caption.copy(fontWeight = FontWeight.Medium),
        color = palette.muted,
        maxLines = 1,
      )
    }

    Box {
      IconButton(
        onClick = { onMenuModeChange(SidebarPagesMenuMode.Navigate) },
        modifier = Modifier.size(48.dp).testTag("sidebar-pages-menu"),
      ) {
        Icon(
          painter = painterResource(R.drawable.ic_web_pen_line),
          contentDescription = nativeString("Edit pinned items"),
          tint = palette.text,
          modifier = Modifier.size(18.dp),
        )
      }

      AppDropdownMenu(
        expanded = menuMode != SidebarPagesMenuMode.Closed,
        onDismissRequest = { onMenuModeChange(SidebarPagesMenuMode.Closed) },
        modifier = Modifier.widthIn(min = 210.dp, max = 340.dp),
        containerColor = palette.elevated,
      ) {
        when (menuMode) {
          SidebarPagesMenuMode.Closed -> {}

          SidebarPagesMenuMode.Navigate -> {
            destinations.forEach { destination ->
              DropdownMenuItem(
                text = { Text(destination.localizedLabel(), maxLines = 1) },
                leadingIcon = {
                  Icon(
                    imageVector = destination.icon,
                    contentDescription = null,
                    tint = palette.text,
                    modifier = Modifier.size(18.dp),
                  )
                },
                trailingIcon = {
                  if (destination == activeDestination) {
                    Icon(
                      painter = painterResource(R.drawable.ic_web_check),
                      contentDescription = nativeString("Selected"),
                      tint = palette.text,
                      modifier = Modifier.size(18.dp),
                    )
                  }
                },
                onClick = {
                  onMenuModeChange(SidebarPagesMenuMode.Closed)
                  onSelectDestination(destination)
                },
              )
            }
            HorizontalDivider(color = palette.hairline)
            DropdownMenuItem(
              text = { Text(nativeString("Edit pinned items"), maxLines = 1) },
              leadingIcon = {
                Icon(
                  painter = painterResource(R.drawable.ic_web_pen_line),
                  contentDescription = null,
                  tint = palette.text,
                  modifier = Modifier.size(18.dp),
                )
              },
              onClick = { onMenuModeChange(SidebarPagesMenuMode.Edit) },
            )
          }

          SidebarPagesMenuMode.Edit -> {
            Text(
              text = nativeString("EDIT PINNED ITEMS"),
              style =
                ClawTheme.type.caption.copy(
                  fontWeight = FontWeight.SemiBold,
                  letterSpacing = 0.8.sp,
                ),
              color = palette.muted,
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
            destinations.forEachIndexed { index, destination ->
              key(destination.stableId) {
                val visible = destination.stableId in visiblePageIds
                SidebarNavigationRow(
                  destination = destination,
                  selected = false,
                  pinned = visible,
                  palette = palette,
                  onClick = { onVisibilityChange(destination, !visible) },
                  canMoveUp = index > 0,
                  canMoveDown = index < destinations.lastIndex,
                  onMove = { direction -> onMove(destination, direction) },
                  onDragActiveChange = onDragActiveChange,
                )
              }
            }
            HorizontalDivider(color = palette.hairline)
            DropdownMenuItem(
              text = { Text(nativeString("Reset pinned items"), maxLines = 1) },
              leadingIcon = {
                Icon(
                  painter = painterResource(R.drawable.ic_web_refresh),
                  contentDescription = null,
                  tint = palette.text,
                  modifier = Modifier.size(18.dp),
                )
              },
              onClick = onReset,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun SidebarSessionCatalog(
  attentionFor: (Collection<String>) -> SidebarAttention?,
  state: SessionCatalogState,
  catalog: SessionCatalog,
  activeSessionKey: String,
  liveSessionsByKey: Map<String, ChatSessionEntry>,
  collapsedHostIds: Set<String>,
  collapsedWorkspaceIds: Set<String>,
  palette: SidebarPalette,
  onToggleHost: (String) -> Unit,
  onToggleWorkspace: (String) -> Unit,
  onSelectSession: (SessionCatalogEntry) -> Unit,
  onLoadMore: (String) -> Unit,
  canMutateSessions: Boolean,
  pinAccess: PersonalSessionPinAccess,
  nowMs: Long,
  onPinSession: (String, String?, Boolean) -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
) {
  val hosts = sidebarCatalogHosts(listOf(catalog))
  when {
    hosts.isEmpty() -> {
      SidebarCatalogStatus(catalog.errorText ?: nativeString("No sessions"), palette)
    }

    else -> {
      catalog.errorText?.let { error ->
        SidebarCatalogStatus(error, palette)
      }
      hosts.forEach { host ->
        val hostExpanded = host.stableId !in collapsedHostIds
        Row(
          modifier =
            Modifier
              .fillMaxWidth()
              .clickable(role = Role.Button) { onToggleHost(host.stableId) }
              .padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          SidebarDisclosureIcon(hostExpanded, palette)
          Icon(
            imageVector = Icons.Outlined.DesktopWindows,
            contentDescription = null,
            tint = palette.muted,
            modifier = Modifier.size(16.dp),
          )
          Text(
            text = host.label,
            style = ClawTheme.type.caption,
            color = palette.muted,
            modifier = Modifier.weight(1f),
            maxLines = 1,
          )
          if (!host.errorText.isNullOrBlank()) {
            Icon(
              imageVector = Icons.Outlined.ErrorOutline,
              contentDescription = nativeString("Host error"),
              tint = ClawTheme.colors.danger,
              modifier = Modifier.size(16.dp),
            )
          } else {
            Text(
              text = if (host.connected) host.workspaces.sumOf { it.sessions.size }.toString() else nativeString("Offline"),
              style = ClawTheme.type.caption,
              color = palette.muted,
              maxLines = 1,
            )
          }
          if (!hostExpanded) attentionFor(host.workspaces.flatMap { it.sessions }.mapNotNull { it.sessionKey })?.let { SidebarAttentionIndicator(it, palette) }
        }
        if (hostExpanded) {
          host.errorText?.let { SidebarCatalogStatus(it, palette) }
          if (host.workspaces.isEmpty() && host.errorText == null) {
            SidebarCatalogStatus(nativeString("No sessions"), palette)
          }
          host.workspaces.forEach { workspace ->
            val expanded = workspace.stableId !in collapsedWorkspaceIds
            Row(
              modifier =
                Modifier
                  .fillMaxWidth()
                  .clickable(role = Role.Button) { onToggleWorkspace(workspace.stableId) }
                  .padding(start = 24.dp, end = 12.dp, top = 7.dp, bottom = 7.dp),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
              SidebarDisclosureIcon(expanded, palette)
              Icon(
                imageVector = Icons.Outlined.Folder,
                contentDescription = null,
                tint = palette.muted,
                modifier = Modifier.size(16.dp),
              )
              Column(modifier = Modifier.weight(1f)) {
                Text(
                  text = workspace.label,
                  style = ClawTheme.type.body,
                  color = palette.text,
                  maxLines = 1,
                )
                workspace.path?.takeIf { it != workspace.label }?.let { path ->
                  Text(
                    text = path,
                    style = ClawTheme.type.caption,
                    color = palette.muted,
                    maxLines = 1,
                  )
                }
              }
              Text(
                text = workspace.sessions.size.toString(),
                style = ClawTheme.type.caption,
                color = palette.muted,
                maxLines = 1,
              )
              if (!expanded) attentionFor(workspace.sessions.mapNotNull { it.sessionKey })?.let { SidebarAttentionIndicator(it, palette) }
            }
            if (expanded) {
              workspace.sessions.forEach { session ->
                val liveSession = session.sessionKey?.let(liveSessionsByKey::get)
                SidebarCatalogSessionRow(
                  session = session,
                  attention = session.sessionKey?.let { attentionFor(listOf(sidebarAttentionSessionKey(it, session.agentId ?: state.agentId))) },
                  liveSession = liveSession,
                  selected = session.sessionKey == activeSessionKey,
                  continuing = state.continuingEntryId == session.locatorId,
                  selectionEnabled = state.continuingEntryId == null,
                  palette = palette,
                  onClick = { onSelectSession(session) },
                  canMutateSessions = canMutateSessions,
                  nextPinned = liveSession?.let { pinAccess.nextSessionPin(it, nowMs) },
                  onPinSession = onPinSession,
                  onDragActiveChange = onDragActiveChange,
                )
              }
            }
          }
        }
      }
      if (hosts.any(SidebarCatalogHost::canLoadMore)) {
        if (catalog.id in state.loadingMoreCatalogIds) {
          SidebarCatalogStatus(nativeString("Loading more sessions"), palette, progress = true)
        } else {
          SidebarActionRow(
            label = nativeString("Load more"),
            icon = Icons.Default.KeyboardArrowDown,
            palette = palette,
            onClick = { onLoadMore(catalog.id) },
          )
        }
      }
    }
  }
}

internal fun sidebarCatalogSessionSelectionEnabled(
  session: SessionCatalogEntry,
  canMutateSessions: Boolean,
): Boolean = session.sessionKey != null || (session.canContinue && canMutateSessions)

@Composable
private fun SidebarCatalogSessionRow(
  session: SessionCatalogEntry,
  attention: SidebarAttention?,
  liveSession: ChatSessionEntry?,
  selected: Boolean,
  continuing: Boolean,
  selectionEnabled: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
  canMutateSessions: Boolean,
  nextPinned: Boolean?,
  onPinSession: (String, String?, Boolean) -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
) {
  val enabled = sidebarCatalogSessionSelectionEnabled(session, canMutateSessions)
  val nativeTitle = session.name?.takeIf(String::isNotBlank) ?: session.threadId
  val pinned = liveSession?.pinned == true
  val draggableSession = liveSession?.takeIf { nextPinned != null }
  val activity =
    sidebarSessionActivity(
      // Adopted rows use Gateway state; unadopted catalogs also call their running state "active".
      status =
        if (liveSession != null) {
          liveSession.status
        } else {
          session.status
            .trim()
            .lowercase()
            .let { if (it == "active") "running" else it }
        },
      lastRunError = liveSession?.lastRunError,
      hasActiveRun = liveSession?.hasActiveRun,
      unread = liveSession?.unread == true,
      continuing = continuing,
    )
  SidebarRowSurface(
    selected = selected,
    stateDescription = attention?.status,
    palette = palette,
    enabled = enabled && selectionEnabled,
    onClick = onClick,
    dragKey = session.locatorId.takeIf { draggableSession != null },
    onDragCommit =
      draggableSession?.let { live ->
        { direction: Int ->
          sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction, currentlyPinned = nextPinned == false)?.let { requested ->
            onPinSession(live.key, live.ownerAgentId, requested)
          }
        }
      },
    onDragActiveChange = onDragActiveChange,
    contentPadding = PaddingValues(start = 48.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(
        text = liveSession?.let { sessionPresentationTitle(it) { nativeTitle } } ?: nativeTitle,
        style = ClawTheme.type.body,
        color = if (enabled) palette.text else palette.muted,
        maxLines = 1,
      )
      val detail =
        listOfNotNull(
          nativeString("Pinned").takeIf { pinned },
          session.gitBranch,
        ).joinToString(" \u00b7 ")
      if (detail.isNotEmpty()) {
        Text(text = detail, style = ClawTheme.type.caption, color = palette.muted, maxLines = 1)
      }
    }
    if (attention != null) {
      SidebarAttentionIndicator(attention, palette)
    } else {
      activity?.let { SidebarSessionActivityIndicator(activity = it, palette = palette) }
    }
  }
}

@Composable
private fun SidebarCatalogStatus(
  text: String,
  palette: SidebarPalette,
  progress: Boolean = false,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (progress) {
      CircularProgressIndicator(
        modifier = Modifier.size(14.dp),
        color = palette.text,
        strokeWidth = 2.dp,
      )
    }
    Text(text = text, style = ClawTheme.type.caption, color = palette.muted)
  }
}
