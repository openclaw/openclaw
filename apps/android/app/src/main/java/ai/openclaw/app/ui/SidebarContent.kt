package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.R
import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogHost
import ai.openclaw.app.SessionCatalogState
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatSessionPatch
import ai.openclaw.app.chat.SIDEBAR_SESSION_PAGE_SIZE
import ai.openclaw.app.chat.SIDEBAR_SESSION_SEE_LESS_THRESHOLD
import ai.openclaw.app.chat.SessionSnooze
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
import androidx.compose.material.icons.filled.MoreVert
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
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Collections
import kotlin.math.sign

private const val SIDEBAR_CATALOG_REFRESH_MS = 30_000L

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

private const val SIDEBAR_SESSION_LIMIT = 8

internal data class SidebarSessionGroupSection(
  val name: String,
  val entries: List<ChatSessionEntry>,
)

internal data class SidebarSessionPresentation(
  val pinned: List<ChatSessionEntry>,
  val groups: List<SidebarSessionGroupSection>,
  /** Uncategorized channel group chats (gateway kind "group"), not catalog folders. */
  val chatGroups: List<ChatSessionEntry>,
  val recentSections: List<SessionSection>,
  val canExpandRecent: Boolean,
)

internal fun sidebarRecentSessions(
  sessions: List<ChatSessionEntry>,
  currentSessionKey: String = "",
  nowMs: Long = System.currentTimeMillis(),
): List<ChatSessionEntry> =
  sessions
    .asSequence()
    .filter { isSessionVisibleInNavigation(it, currentSessionKey, nowMs) }
    .sortedWith(
      compareByDescending<ChatSessionEntry> { it.pinned == true }
        .thenByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        .thenBy { it.key },
    ).toList()

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
  expanded: Boolean,
  excludedSessionKeys: Set<String> = emptySet(),
  currentSessionKey: String = "",
  nowMs: Long = System.currentTimeMillis(),
): SidebarSessionPresentation {
  val activeSessions = sidebarRecentSessions(sessions, currentSessionKey, nowMs)
  val pinned = activeSessions.filter { it.pinned == true }
  val navigable =
    activeSessions.filter { session ->
      session.pinned != true && session.key !in excludedSessionKeys
    }
  val grouped = navigable.filter { !it.category.isNullOrBlank() }
  val ungrouped = navigable.filter { it.category.isNullOrBlank() }
  // An explicit category wins, matching web/Mac. Groups is only kind=="group".
  val chatGroups = ungrouped.filter { it.kind == "group" }
  val recent = ungrouped.filter { it.kind != "group" }

  val visibleRecent = if (expanded) recent else recent.take(SIDEBAR_SESSION_LIMIT)
  return SidebarSessionPresentation(
    pinned = pinned,
    groups = sidebarSessionGroupSections(grouped, knownGroups),
    chatGroups = chatGroups,
    recentSections =
      if (visibleRecent.isEmpty()) {
        emptyList()
      } else {
        listOf(SessionSection(title = null, entries = visibleRecent))
      },
    canExpandRecent = recent.size > SIDEBAR_SESSION_LIMIT,
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

internal data class SidebarSectionWindow(
  val rows: List<ChatSessionEntry>,
  val totalCount: Int,
  val canShowMore: Boolean,
  val canShowLess: Boolean,
)

/**
 * Reveals a page of rows the roster already holds. [totalCount] is the loaded
 * membership, not the page, so a collapsed badge matches the web section count.
 * The active row stays visible past the cap the way the web projection keeps it.
 */
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
      totalCount = total,
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
    totalCount = total,
    canShowMore = true,
    canShowLess = canShowLess && page.size > SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  )
}

/** Sections the drawer draws. Hidden work stays in the stored order but is not a move step. */
internal fun sidebarReorderVisibleTokens(
  sectionTokens: List<String>,
  categoryNames: Set<String>,
  showGroupsZone: Boolean,
  catalogIds: Set<String>,
): List<String> =
  sectionTokens.mapNotNull { token ->
    when {
      token.startsWith("category:") -> token.takeIf { token.removePrefix("category:") in categoryNames }
      token == "ungrouped" -> token
      token == "groups" -> token.takeIf { showGroupsZone }
      token.startsWith("catalog:") -> token.takeIf { token.removePrefix("catalog:") in catalogIds }
      else -> null
    }
  }

/**
 * Collapsed badge. The web projection's `totalRowCount` is the loaded section
 * membership (`section.rows.length` in app-sidebar-session-projection.ts), painted
 * as soon as the folder is collapsed. A later roster page grows that number.
 * It is not withheld until `sessions.list` reports `hasMore: false`.
 */
internal fun sidebarCollapsedCount(loadedCount: Int): Int? = loadedCount.takeIf { it > 0 }

/**
 * Collapsed catalog badge. Web paints the loaded `visibleHosts` session length
 * while a host still has `nextCursor` (app-sidebar-session-catalog-render.ts).
 */
internal fun sidebarCatalogLoadedCount(hosts: List<SessionCatalogHost>): Int? = hosts.sumOf { host -> host.sessions.count { !it.archived } }.takeIf { it > 0 }

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

internal class SidebarRowHost {
  private data class Placement(
    val band: IntRect?,
    val viewport: IntRect,
  )

  private var placement: Placement? = null
  var generation by mutableLongStateOf(0L)
    private set

  fun recordPlacement(
    band: IntRect?,
    viewport: IntRect,
  ) {
    val next = Placement(band, viewport)
    if (next != placement) {
      placement = next
      generation++
    }
  }
}

internal fun sidebarPalette(colors: ClawColors): SidebarPalette =
  SidebarPalette(
    background = colors.canvas,
    elevated = colors.surfaceRaised,
    selection = colors.accentSoft,
    text = colors.text,
    muted = colors.textMuted,
    hairline = colors.border,
  )

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
  rowHostBand: IntRect? = null,
) {
  val palette = sidebarPalette(ClawTheme.colors)
  var sessionNowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val scrollState = rememberScrollState()
  val rowHost = remember { SidebarRowHost() }
  val agentPicker = agentPickerState(agents, selectedAgentId)
  val storedGroups by viewModel.sessionCustomGroups.collectAsState()
  val storedSectionOrder by viewModel.sessionSectionOrder.collectAsState()
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
  val sectionVisibleLimits = remember { mutableStateMapOf<String, Int>() }
  val rosterHasMore by viewModel.chatSessionRosterHasMore.collectAsState()
  val rosterLoadingMore by viewModel.chatSessionRosterLoadingMore.collectAsState()
  var expandedCatalogIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
  var pinnedExpanded by rememberSaveable { mutableStateOf(false) }
  var groupsExpanded by rememberSaveable { mutableStateOf(true) }
  var collapsedGroupNames by rememberSaveable { mutableStateOf(emptyList<String>()) }
  var recentExpanded by rememberSaveable { mutableStateOf(false) }
  var newGroupDialogVisible by rememberSaveable { mutableStateOf(false) }
  var pendingNewGroupGatewayId by rememberSaveable { mutableStateOf<String?>(null) }
  var renameGroupTarget by rememberSaveable(stateSaver = SessionGroupActionTargetSaver) { mutableStateOf<SessionGroupActionTarget?>(null) }
  var deleteGroupTarget by rememberSaveable(stateSaver = SessionGroupActionTargetSaver) { mutableStateOf<SessionGroupActionTarget?>(null) }
  var newGroupForSessionTarget by rememberSaveable(stateSaver = SessionActionTargetSaver) { mutableStateOf<SessionActionTarget?>(null) }
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
  val recentPresentation =
    sidebarSessionPresentation(
      sessions = sessions,
      knownGroups = storedGroups,
      expanded = true,
      excludedSessionKeys = catalogSessionKeys,
      currentSessionKey = activeSessionKey,
      nowMs = sessionNowMs,
    )
  val pinnedSessions = recentPresentation.pinned
  val groupSections = recentPresentation.groups
  val chatGroups = recentPresentation.chatGroups
  val recentSections = recentPresentation.recentSections
  renameGroupTarget = renameGroupTarget?.takeIf { it.gatewayStableId == gatewayStableId }
  deleteGroupTarget = deleteGroupTarget?.takeIf { it.gatewayStableId == gatewayStableId }
  newGroupForSessionTarget = newGroupForSessionTarget?.takeIf { it.matchesGateway(gatewayStableId) }
  if (pendingNewGroupGatewayId != null && pendingNewGroupGatewayId != gatewayStableId) {
    pendingNewGroupGatewayId = null
    newGroupDialogVisible = false
  }
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
  val sessionRows: @Composable (List<ChatSessionEntry>, SidebarSessionDragSource?) -> Unit = { entries, dragSource ->
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      entries.forEach { session ->
        SidebarSessionRow(
          session = session,
          attention = attentionFor(listOf(sidebarAttentionSessionKey(session.key, session.ownerAgentId ?: selectedAgentId ?: defaultAgentId))),
          rowHost = rowHost,
          selected = session.key == activeSessionKey,
          palette = palette,
          onClick = { onSelectSession(session) },
          onDragCommit =
            if (canMutateSessions && dragSource != null) {
              { direction ->
                sidebarSessionPinnedAfterDrag(dragSource, direction)?.let { pinned ->
                  setSessionPinned(session.key, session.ownerAgentId, pinned)
                }
              }
            } else {
              null
            },
          onDragActiveChange = if (dragSource == null) ({}) else onDragActiveChange,
          groupNames = if (canMutateSessions) storedGroups else emptyList(),
          onMoveToGroup =
            if (canMutateSessions) {
              { category ->
                viewModel.captureChatSessionRequestLease(gatewayStableId)?.let { lease ->
                  scope.launch {
                    viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, category = category, requestLease = lease)
                  }
                }
              }
            } else {
              null
            },
          onRemoveFromGroup =
            if (canMutateSessions && !session.category.isNullOrBlank()) {
              {
                viewModel.captureChatSessionRequestLease(gatewayStableId)?.let { lease ->
                  scope.launch {
                    viewModel.patchChatSession(key = session.key, ownerAgentId = session.ownerAgentId, clearCategory = true, requestLease = lease)
                  }
                }
              }
            } else {
              null
            },
          onNewGroup =
            if (canMutateSessions) {
              { newGroupForSessionTarget = session.toActionTarget(gatewayStableId) }
            } else {
              null
            },
        )
      }
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
      while (true) {
        delay(SIDEBAR_CATALOG_REFRESH_MS)
        viewModel.refreshSessionCatalog(selectedAgentId)
      }
    }
  }
  LaunchedEffect(connection.isConnected, gatewayStableId, visible, lifecycle) {
    if (!connection.isConnected || !visible) return@LaunchedEffect
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      viewModel.refreshSessionGroups()
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
  val nextWakeMs =
    listOfNotNull(
      SessionSnooze.nextWakeMs(sessions, sessionNowMs),
      SessionSnooze.nextWakeMs(searchState.entries, sessionNowMs),
    ).minOrNull()
  LaunchedEffect(nextWakeMs) {
    nextWakeMs?.let { sessionNowMs = awaitSessionStatusExpiry(it) }
  }
  val searchResults =
    resolveSessionBrowserEntries(
      entries = searchState.entries,
      currentSessionKey = activeSessionKey,
      filter = SessionFilter.Recent,
      recentFirst = true,
      nowMs = sessionNowMs,
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
            .onPlaced {
              // Observe the viewport, never row reorder/drag offsets or the scrolling content.
              rowHost.recordPlacement(rowHostBand, IntRect(it.positionInParent().round(), it.size))
            }.verticalScroll(scrollState),
      ) {
        if (searchState.query.isNotEmpty()) {
          SidebarSectionTitle(nativeString("Threads"), palette)
          if (searchState.loading || searchResults.isEmpty()) {
            Text(
              text = if (searchState.loading) nativeString("Searching threads") else nativeString("No matching threads"),
              style = ClawTheme.type.caption,
              color = palette.muted,
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            )
          } else {
            sessionRows(searchResults, null)
          }
        } else {
          SidebarPagesHeader(
            rowHost = rowHost,
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
                  rowHost = rowHost,
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
            attention = if (pinnedExpanded) null else attentionFor(pinnedSessions.map { sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId) }),
            expanded = pinnedExpanded,
            palette = palette,
            onClick = { pinnedExpanded = !pinnedExpanded },
            modifier = Modifier.padding(top = 10.dp),
          )
          if (pinnedExpanded) {
            if (pinnedSessions.isEmpty()) {
              Text(
                text = nativeString("No pinned sessions"),
                style = ClawTheme.type.caption,
                color = palette.muted,
                modifier = Modifier.padding(horizontal = 40.dp, vertical = 10.dp),
              )
            } else {
              sessionRows(pinnedSessions, SidebarSessionDragSource.Pinned)
            }
          }

          // groupSidebarSessionRows / ChatSessionSidebarGrouping: gateway sectionOrder,
          // then default built-ins (Other, Groups, hidden empty work) and provider catalogs.
          val sectionTokens =
            normalizeSidebarSectionOrder(
              stored = storedSectionOrder,
              knownGroups = groupSections.map { it.name },
              catalogIds = if (catalogAvailable) catalogSections.map { it.catalog.id } else emptyList(),
            )
          val groupsByName = groupSections.associateBy { it.name }
          val catalogsById = catalogSections.associateBy { it.catalog.id }
          val showGroupsZone =
            chatGroups.isNotEmpty() || groupSections.any { section -> section.entries.any { it.kind == "group" } }
          if (canMutateSessions) {
            SidebarActionRow(
              label = nativeString("New group"),
              icon = Icons.Default.Add,
              palette = palette,
              onClick = {
                pendingNewGroupGatewayId = gatewayStableId
                newGroupDialogVisible = true
              },
            )
          }
          val visibleReorderTokens =
            sidebarReorderVisibleTokens(
              sectionTokens = sectionTokens,
              categoryNames = groupsByName.keys,
              showGroupsZone = showGroupsZone,
              catalogIds = catalogsById.keys,
            )

          fun limitFor(token: String): Int = sectionVisibleLimits[token] ?: SIDEBAR_SESSION_PAGE_SIZE

          fun revealAnotherPage(token: String) {
            sectionVisibleLimits[token] = limitFor(token) + SIDEBAR_SESSION_PAGE_SIZE
          }

          fun collapseToFirstPage(token: String) {
            sectionVisibleLimits[token] = SIDEBAR_SESSION_PAGE_SIZE
          }

          fun moveSection(
            token: String,
            direction: Int,
          ) {
            val gatewayId = gatewayStableId ?: return
            scope.launch {
              viewModel.moveChatSessionSection(
                sourceToken = token,
                direction = direction,
                visibleTokens = visibleReorderTokens,
                catalogIds = if (catalogAvailable) catalogSections.map { it.catalog.id } else emptyList(),
                expectedGatewayStableId = gatewayId,
              )
            }
          }

          fun canMove(
            token: String,
            direction: Int,
          ): Boolean {
            val index = visibleReorderTokens.indexOf(token)
            return index >= 0 && visibleReorderTokens.getOrNull(index + direction) != null
          }
          var showedCatalogChrome = false
          for (token in sectionTokens) {
            when {
              token.startsWith("category:") -> {
                val section = groupsByName[token.removePrefix("category:")] ?: continue
                val collapsed = section.name in collapsedGroupNames
                val window = sidebarSectionWindow(section.entries, limitFor(token), activeSessionKey)
                key("group:${section.name}") {
                  SidebarCollapsibleHeader(
                    label = section.name,
                    attention =
                      if (collapsed) {
                        attentionFor(section.entries.map { sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId) })
                      } else {
                        null
                      },
                    expanded = !collapsed,
                    palette = palette,
                    modifier = Modifier.padding(top = 10.dp),
                    count = sidebarCollapsedCount(window.totalCount),
                    iconContent = {
                      Icon(
                        imageVector = Icons.Outlined.Folder,
                        contentDescription = null,
                        tint = palette.muted,
                        modifier = Modifier.size(16.dp),
                      )
                    },
                    trailingContent = {
                      if (canMutateSessions) {
                        SidebarGroupFolderMenu(
                          palette = palette,
                          canMoveUp = canMove(token, -1),
                          canMoveDown = canMove(token, 1),
                          onMove = { direction -> moveSection(token, direction) },
                          onRename = { renameGroupTarget = SessionGroupActionTarget(gatewayStableId, section.name) },
                          onNewGroup = {
                            pendingNewGroupGatewayId = gatewayStableId
                            newGroupDialogVisible = true
                          },
                          onDelete = { deleteGroupTarget = SessionGroupActionTarget(gatewayStableId, section.name) },
                        )
                      }
                    },
                    onClick = { collapsedGroupNames = toggleSidebarExpansion(collapsedGroupNames, section.name) },
                  )
                  if (!collapsed && window.rows.isNotEmpty()) {
                    sessionRows(window.rows, SidebarSessionDragSource.Recent)
                  }
                  if (!collapsed) {
                    SidebarSectionPageControls(
                      window = window,
                      palette = palette,
                      onShowMore = { revealAnotherPage(token) },
                      onShowLess = { collapseToFirstPage(token) },
                    )
                  }
                }
              }

              token == "ungrouped" -> {
                val recentEntries = recentSections.flatMap { it.entries }
                val window = sidebarSectionWindow(recentEntries, limitFor(token), activeSessionKey)
                SidebarCollapsibleHeader(
                  label = nativeString("Other"),
                  attention =
                    if (recentExpanded) {
                      null
                    } else {
                      attentionFor(
                        recentEntries.map {
                          sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId)
                        },
                      )
                    },
                  expanded = recentExpanded,
                  palette = palette,
                  count = sidebarCollapsedCount(window.totalCount),
                  trailingContent = {
                    if (canMutateSessions) {
                      SidebarSectionMoveMenu(
                        palette = palette,
                        canMoveUp = canMove(token, -1),
                        canMoveDown = canMove(token, 1),
                        onMove = { direction -> moveSection(token, direction) },
                      )
                    }
                  },
                  onClick = { recentExpanded = !recentExpanded },
                )
                if (recentExpanded) {
                  if (window.rows.isEmpty()) {
                    Text(
                      text = nativeString("No recent sessions"),
                      style = ClawTheme.type.caption,
                      color = palette.muted,
                      modifier = Modifier.padding(horizontal = 40.dp, vertical = 10.dp),
                    )
                  } else {
                    sessionRows(window.rows, SidebarSessionDragSource.Recent)
                  }
                  SidebarSectionPageControls(
                    window = window,
                    palette = palette,
                    onShowMore = { revealAnotherPage(token) },
                    onShowLess = { collapseToFirstPage(token) },
                  )
                }
              }

              token == "groups" && showGroupsZone -> {
                val window = sidebarSectionWindow(chatGroups, limitFor(token), activeSessionKey)
                SidebarCollapsibleHeader(
                  label = nativeString("Groups"),
                  attention =
                    if (groupsExpanded) {
                      null
                    } else {
                      attentionFor(chatGroups.map { sidebarAttentionSessionKey(it.key, it.ownerAgentId ?: selectedAgentId ?: defaultAgentId) })
                    },
                  expanded = groupsExpanded,
                  palette = palette,
                  modifier = Modifier.padding(top = 10.dp),
                  count = sidebarCollapsedCount(window.totalCount),
                  trailingContent = {
                    if (canMutateSessions) {
                      SidebarSectionMoveMenu(
                        palette = palette,
                        canMoveUp = canMove(token, -1),
                        canMoveDown = canMove(token, 1),
                        onMove = { direction -> moveSection(token, direction) },
                      )
                    }
                  },
                  onClick = { groupsExpanded = !groupsExpanded },
                )
                if (groupsExpanded) {
                  if (window.rows.isNotEmpty()) {
                    sessionRows(window.rows, SidebarSessionDragSource.Recent)
                  }
                  SidebarSectionPageControls(
                    window = window,
                    palette = palette,
                    onShowMore = { revealAnotherPage(token) },
                    onShowLess = { collapseToFirstPage(token) },
                  )
                }
              }

              token == "work" -> {
                // Empty coding section stays a stored token. Android does not draw it.
              }

              token.startsWith("catalog:") -> {
                val section = catalogsById[token.removePrefix("catalog:")] ?: continue
                if (!showedCatalogChrome && catalogState.loading) {
                  SidebarCatalogStatus(nativeString("Loading"), palette, progress = true)
                }
                showedCatalogChrome = true
                val catalog = section.catalog
                key("catalog:${catalog.id}") {
                  SidebarCollapsibleHeader(
                    label = catalog.label,
                    attention = if (section.expanded) null else attentionFor(sidebarVisibleCatalogSessionKeys(listOf(catalog))),
                    expanded = section.expanded,
                    palette = palette,
                    count = sidebarCatalogLoadedCount(catalog.hosts),
                    iconContent = {
                      ProviderBrandIcon(provider = catalog.id, size = 18.dp)
                    },
                    trailingContent = {
                      Row(verticalAlignment = Alignment.CenterVertically) {
                        if (canMutateSessions) {
                          SidebarSectionMoveMenu(
                            palette = palette,
                            canMoveUp = canMove(token, -1),
                            canMoveDown = canMove(token, 1),
                            onMove = { direction -> moveSection(token, direction) },
                          )
                        }
                        if (
                          sidebarCatalogSessionCreationEnabled(catalog, canMutateSessions) &&
                          catalogState.continuingEntryId == null
                        ) {
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
                      }
                    },
                    onClick = {
                      expandedCatalogIds = toggleSidebarExpansion(expandedCatalogIds, catalog.id)
                    },
                  )
                  if (section.expanded) {
                    SidebarSessionCatalog(
                      attentionFor = ::attentionFor,
                      rowHost = rowHost,
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
                      onPinSession = setSessionPinned,
                      onDragActiveChange = onDragActiveChange,
                    )
                  }
                }
              }
            }
          }
          if (rosterHasMore) {
            SidebarActionRow(
              label = nativeString(if (rosterLoadingMore) "Loading" else "Load more sessions"),
              icon = Icons.Default.KeyboardArrowDown,
              palette = palette,
              onClick = {
                if (rosterLoadingMore) return@SidebarActionRow
                scope.launch {
                  if (viewModel.loadMoreChatSessions()) {
                    // A new roster page is useless if every section keeps its old cap.
                    for (token in sectionTokens) revealAnotherPage(token)
                  }
                }
              },
            )
          }
          if (catalogAvailable && catalogSections.isEmpty()) {
            when {
              catalogState.loading -> SidebarCatalogStatus(nativeString("Loading"), palette, progress = true)
              catalogErrorText != null -> SidebarCatalogStatus(catalogErrorText, palette)
              else -> SidebarCatalogStatus(nativeString("No sessions"), palette)
            }
          } else if (showedCatalogChrome) {
            catalogErrorText?.let { SidebarCatalogStatus(it, palette) }
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
  if (newGroupDialogVisible) {
    val ownerGatewayId = pendingNewGroupGatewayId
    SessionTextDialog(
      title = nativeString("New group"),
      stateKey = "sidebar-group-new:${ownerGatewayId.orEmpty()}",
      initialValue = "",
      confirmLabel = nativeString("Create"),
      allowEmpty = false,
      onDismiss = {
        newGroupDialogVisible = false
        pendingNewGroupGatewayId = null
      },
      onConfirm = { value ->
        newGroupDialogVisible = false
        pendingNewGroupGatewayId = null
        if (ownerGatewayId != viewModel.activeGatewayStableId.value) return@SessionTextDialog
        scope.launch { viewModel.addChatSessionGroup(value, expectedGatewayStableId = ownerGatewayId) }
      },
    )
  }
  renameGroupTarget?.let { target ->
    SessionTextDialog(
      title = nativeString("Rename group"),
      stateKey = "sidebar-group-rename:${target.gatewayStableId}:${target.name}",
      initialValue = target.name,
      confirmLabel = nativeString("Rename"),
      allowEmpty = false,
      onDismiss = { renameGroupTarget = null },
      onConfirm = { value ->
        renameGroupTarget = null
        if (target.gatewayStableId != viewModel.activeGatewayStableId.value) return@SessionTextDialog
        val next = value.trim()
        if (next.isNotEmpty() && next != target.name) {
          scope.launch {
            viewModel.renameChatSessionGroup(from = target.name, to = next, expectedGatewayStableId = target.gatewayStableId)
          }
        }
      },
    )
  }
  deleteGroupTarget?.let { target ->
    SessionDeleteDialog(
      title = nativeString("Delete group?"),
      text = nativeString("Threads in \"\$group\" are kept and move back to Ungrouped.", target.name),
      onDismiss = { deleteGroupTarget = null },
      onConfirm = {
        deleteGroupTarget = null
        if (target.gatewayStableId != viewModel.activeGatewayStableId.value) return@SessionDeleteDialog
        scope.launch { viewModel.deleteChatSessionGroup(target.name, expectedGatewayStableId = target.gatewayStableId) }
      },
    )
  }
  newGroupForSessionTarget?.let { target ->
    SessionTextDialog(
      title = nativeString("New group"),
      stateKey = "sidebar-group-for:${target.stateKey}",
      initialValue = "",
      confirmLabel = nativeString("Create"),
      allowEmpty = false,
      onDismiss = { newGroupForSessionTarget = null },
      onConfirm = { value ->
        newGroupForSessionTarget = null
        if (!target.matchesGateway(viewModel.activeGatewayStableId.value)) return@SessionTextDialog
        scope.launch {
          viewModel.addChatSessionGroup(
            value,
            expectedGatewayStableId = target.gatewayStableId,
            sessionKey = target.key,
            ownerAgentId = target.ownerAgentId,
          )
        }
      },
    )
  }
}

@Composable
private fun SidebarSectionPageControls(
  window: SidebarSectionWindow,
  palette: SidebarPalette,
  onShowMore: () -> Unit,
  onShowLess: () -> Unit,
) {
  if (window.canShowMore) {
    SidebarActionRow(
      label = nativeString("Show more"),
      icon = Icons.Default.KeyboardArrowDown,
      palette = palette,
      onClick = onShowMore,
    )
  }
  if (window.canShowLess) {
    SidebarActionRow(
      label = nativeString("Show less"),
      icon = Icons.Default.KeyboardArrowUp,
      palette = palette,
      onClick = onShowLess,
    )
  }
}

@Composable
private fun SidebarSectionMoveMenu(
  palette: SidebarPalette,
  canMoveUp: Boolean,
  canMoveDown: Boolean,
  onMove: (Int) -> Unit,
) {
  if (!canMoveUp && !canMoveDown) return
  var expanded by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { expanded = true }, modifier = Modifier.size(40.dp)) {
      Icon(
        imageVector = Icons.Default.MoreVert,
        contentDescription = nativeString("Reorder"),
        tint = palette.text,
        modifier = Modifier.size(18.dp),
      )
    }
    AppDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      if (canMoveUp) {
        DropdownMenuItem(
          text = { Text(nativeString("Move up"), style = ClawTheme.type.body) },
          onClick = {
            expanded = false
            onMove(-1)
          },
        )
      }
      if (canMoveDown) {
        DropdownMenuItem(
          text = { Text(nativeString("Move down"), style = ClawTheme.type.body) },
          onClick = {
            expanded = false
            onMove(1)
          },
        )
      }
    }
  }
}

@Composable
private fun SidebarGroupFolderMenu(
  palette: SidebarPalette,
  onRename: () -> Unit,
  onNewGroup: () -> Unit,
  onDelete: () -> Unit,
  canMoveUp: Boolean = false,
  canMoveDown: Boolean = false,
  onMove: (Int) -> Unit = {},
) {
  var expanded by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { expanded = true }, modifier = Modifier.size(40.dp)) {
      Icon(
        imageVector = Icons.Default.MoreVert,
        contentDescription = nativeString("Group menu"),
        tint = palette.text,
        modifier = Modifier.size(18.dp),
      )
    }
    AppDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      if (canMoveUp) {
        DropdownMenuItem(
          text = { Text(nativeString("Move up"), style = ClawTheme.type.body) },
          onClick = {
            expanded = false
            onMove(-1)
          },
        )
      }
      if (canMoveDown) {
        DropdownMenuItem(
          text = { Text(nativeString("Move down"), style = ClawTheme.type.body) },
          onClick = {
            expanded = false
            onMove(1)
          },
        )
      }
      DropdownMenuItem(
        text = { Text(nativeString("Rename group…"), style = ClawTheme.type.body) },
        onClick = {
          expanded = false
          onRename()
        },
      )
      DropdownMenuItem(
        text = { Text(nativeString("New group…"), style = ClawTheme.type.body) },
        onClick = {
          expanded = false
          onNewGroup()
        },
      )
      DropdownMenuItem(
        text = { Text(nativeString("Delete group…"), style = ClawTheme.type.body) },
        onClick = {
          expanded = false
          onDelete()
        },
      )
    }
  }
}

@Composable
private fun SidebarPagesHeader(
  rowHost: SidebarRowHost,
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
        modifier = Modifier.size(44.dp).testTag("sidebar-pages-menu"),
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
                  rowHost = rowHost,
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
  rowHost: SidebarRowHost,
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
                SidebarCatalogSessionRow(
                  session = session,
                  attention = session.sessionKey?.let { attentionFor(listOf(sidebarAttentionSessionKey(it, session.agentId ?: state.agentId))) },
                  rowHost = rowHost,
                  liveSession = session.sessionKey?.let(liveSessionsByKey::get),
                  selected = session.sessionKey == activeSessionKey,
                  continuing = state.continuingEntryId == session.locatorId,
                  selectionEnabled = state.continuingEntryId == null,
                  palette = palette,
                  onClick = { onSelectSession(session) },
                  canMutateSessions = canMutateSessions,
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
  rowHost: SidebarRowHost,
  liveSession: ChatSessionEntry?,
  selected: Boolean,
  continuing: Boolean,
  selectionEnabled: Boolean,
  palette: SidebarPalette,
  onClick: () -> Unit,
  canMutateSessions: Boolean,
  onPinSession: (String, String?, Boolean) -> Unit,
  onDragActiveChange: (Boolean) -> Unit,
) {
  val enabled = sidebarCatalogSessionSelectionEnabled(session, canMutateSessions)
  val nativeTitle = session.name?.takeIf(String::isNotBlank) ?: session.threadId
  val pinned = liveSession?.pinned == true
  val draggableSession = liveSession?.takeIf { canMutateSessions }
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
    rowHost = rowHost,
    palette = palette,
    enabled = enabled && selectionEnabled,
    onClick = onClick,
    dragKey = session.locatorId.takeIf { draggableSession != null },
    onDragCommit =
      draggableSession?.let { live ->
        { direction: Int ->
          sidebarSessionPinnedAfterDrag(SidebarSessionDragSource.Catalog, direction, pinned)?.let { nextPinned ->
            onPinSession(live.key, live.ownerAgentId, nextPinned)
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
