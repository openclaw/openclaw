package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** Session browser for active, current, and archived chat sessions. */
@Composable
internal fun SessionsScreen(
  viewModel: MainViewModel,
  onOpenCommand: () -> Unit,
  onOpenChat: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val chatSessionKey by viewModel.chatSessionKey.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val coroutineScope = rememberCoroutineScope()
  var filter by rememberSaveable { mutableStateOf(SessionFilter.Recent) }
  var compactLayout by rememberSaveable { mutableStateOf(false) }
  var recentFirst by rememberSaveable { mutableStateOf(true) }
  var renameSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  var groupSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  var deleteSessionKey by rememberSaveable { mutableStateOf<String?>(null) }
  val visibleSessions =
    sessions
      .let { rows ->
        when (filter) {
          SessionFilter.Recent -> rows.filter { it.archived != true }
          SessionFilter.Current -> rows.filter { it.key == chatSessionKey && it.archived != true }
          // Gate on the entry's own archived flag so the pre-toggle active list can
          // never render with archived-only actions while the refetch is in flight.
          SessionFilter.Archived -> rows.filter { it.archived == true }
        }
      }.let { rows ->
        if (recentFirst) {
          rows.sortedByDescending { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        } else {
          rows.sortedBy { it.lastActivityAt ?: it.updatedAtMs ?: 0L }
        }
      }
  val sections = groupSessionEntries(visibleSessions)
  val categories =
    sessions
      .mapNotNull { it.category?.trim()?.takeIf(String::isNotEmpty) }
      .distinctBy { it.lowercase() }
      .sortedWith(String.CASE_INSENSITIVE_ORDER)

  LaunchedEffect(isConnected, filter) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 200, archived = filter == SessionFilter.Archived)
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 4.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(9.dp),
      contentPadding = PaddingValues(bottom = 4.dp),
    ) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(text = "Sessions", style = ClawTheme.type.display.copy(fontSize = 24.sp, lineHeight = 28.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(icon = Icons.Default.Search, contentDescription = "Search sessions", onClick = onOpenCommand)
          ClawPlainIconButton(icon = Icons.Default.SwapVert, contentDescription = "Reverse session sort", onClick = { recentFirst = !recentFirst })
        }
      }

      item {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          FilterPill(text = "Recent", icon = Icons.Outlined.AccessTime, active = filter == SessionFilter.Recent, onClick = { filter = SessionFilter.Recent })
          FilterPill(text = "Current", icon = Icons.Outlined.MicNone, active = filter == SessionFilter.Current, showDot = sessions.any { it.key == chatSessionKey }, onClick = { filter = SessionFilter.Current })
          FilterPill(text = "Archived", icon = Icons.Outlined.Archive, active = filter == SessionFilter.Archived, onClick = { filter = SessionFilter.Archived })
        }
      }

      item {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
          Row(
            modifier =
              Modifier
                .clip(RoundedCornerShape(ClawTheme.radii.row))
                .clickable { recentFirst = !recentFirst }
                .padding(horizontal = 2.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
          ) {
            Text(text = "Sort: ${if (recentFirst) "Newest" else "Oldest"}", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
          }
          SessionOutlineIconButton(icon = Icons.Default.Storage, contentDescription = "Toggle session layout", onClick = { compactLayout = !compactLayout })
        }
      }

      item {
        Text(text = if (compactLayout) "Layout: Compact" else "Layout: Detailed", style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      }

      if (visibleSessions.isEmpty()) {
        item {
          Box(
            modifier = Modifier.fillParentMaxHeight(0.56f).fillMaxWidth(),
            contentAlignment = Alignment.Center,
          ) {
            ClawEmptyState(
              title = emptySessionTitle(filter),
              body = emptySessionBody(filter),
              action = { ClawPrimaryButton(text = "Start Chat", onClick = onOpenChat) },
            )
          }
        }
      } else {
        sections.forEachIndexed { index, section ->
          section.title?.let { title ->
            item(key = "section:$index:$title") {
              Text(
                text = title,
                style = ClawTheme.type.label,
                color = ClawTheme.colors.textMuted,
                modifier = Modifier.padding(top = 6.dp),
              )
            }
          }
          items(section.entries, key = { it.key }) { session ->
            val active = session.key == chatSessionKey
            SessionRow(
              session = session,
              title = displaySessionTitle(session),
              subtitle = if (active) "Current session" else "OpenClaw session",
              metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::relativeSessionTime) ?: "now",
              active = active,
              compact = compactLayout,
              archived = session.archived == true,
              categories = categories,
              onClick = {
                viewModel.switchChatSession(session.key)
                onOpenChat()
              },
              onSetPinned = { pinned ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, pinned = pinned) }
              },
              onSetUnread = { unread ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, unread = unread) }
              },
              onRename = { renameSessionKey = session.key },
              onFork = {
                coroutineScope.launch {
                  viewModel.forkChatSession(session.key)?.let { newKey ->
                    viewModel.switchChatSession(newKey)
                    onOpenChat()
                  }
                }
              },
              onMoveToGroup = { category ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, category = category) }
              },
              onNewGroup = { groupSessionKey = session.key },
              onRemoveFromGroup = {
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, clearCategory = true) }
              },
              onSetArchived = { archived ->
                coroutineScope.launch { viewModel.patchChatSession(key = session.key, archived = archived) }
              },
              onDelete = { deleteSessionKey = session.key },
            )
          }
        }
      }
    }
  }

  sessions.firstOrNull { it.key == renameSessionKey }?.let { session ->
    SessionTextDialog(
      title = "Rename session",
      stateKey = session.key,
      initialValue = session.label ?: session.displayName.orEmpty(),
      confirmLabel = "Rename",
      allowEmpty = true,
      onDismiss = { renameSessionKey = null },
      onConfirm = { value ->
        renameSessionKey = null
        val label = value.trim()
        coroutineScope.launch {
          viewModel.patchChatSession(
            key = session.key,
            label = label.takeIf(String::isNotEmpty),
            clearLabel = label.isEmpty(),
          )
        }
      },
    )
  }

  sessions.firstOrNull { it.key == groupSessionKey }?.let { session ->
    SessionTextDialog(
      title = "New group",
      stateKey = session.key,
      initialValue = "",
      confirmLabel = "Create",
      allowEmpty = false,
      onDismiss = { groupSessionKey = null },
      onConfirm = { value ->
        groupSessionKey = null
        coroutineScope.launch { viewModel.patchChatSession(key = session.key, category = value.trim()) }
      },
    )
  }

  sessions.firstOrNull { it.key == deleteSessionKey }?.let { session ->
    AlertDialog(
      onDismissRequest = { deleteSessionKey = null },
      containerColor = ClawTheme.colors.surfaceRaised,
      title = { Text("Delete session?", style = ClawTheme.type.section, color = ClawTheme.colors.text) },
      text = { Text("This permanently deletes the session and its transcript.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      confirmButton = {
        TextButton(
          onClick = {
            deleteSessionKey = null
            coroutineScope.launch { viewModel.deleteChatSession(session.key) }
          },
        ) {
          Text("Delete", color = ClawTheme.colors.danger)
        }
      },
      dismissButton = {
        TextButton(onClick = { deleteSessionKey = null }) {
          Text("Cancel")
        }
      },
    )
  }
}

@Composable
private fun FilterPill(
  text: String,
  icon: ImageVector? = null,
  active: Boolean = false,
  showDot: Boolean = false,
  dropdown: Boolean = false,
  onClick: (() -> Unit)? = null,
) {
  Surface(
    onClick = onClick ?: {},
    enabled = onClick != null,
    shape = RoundedCornerShape(7.dp),
    color = if (active) ClawTheme.colors.surfaceRaised else Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      icon?.let { Icon(imageVector = it, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.text) }
      Text(text = text, style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
      if (showDot) {
        Box(modifier = Modifier.size(4.dp).clip(CircleShape).background(ClawTheme.colors.success))
      }
      if (dropdown) {
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun SessionRow(
  session: ChatSessionEntry,
  title: String,
  subtitle: String,
  metadata: String,
  active: Boolean,
  compact: Boolean,
  archived: Boolean,
  categories: List<String>,
  onClick: () -> Unit,
  onSetPinned: (Boolean) -> Unit,
  onSetUnread: (Boolean) -> Unit,
  onRename: () -> Unit,
  onFork: () -> Unit,
  onMoveToGroup: (String) -> Unit,
  onNewGroup: () -> Unit,
  onRemoveFromGroup: () -> Unit,
  onSetArchived: (Boolean) -> Unit,
  onDelete: () -> Unit,
) {
  var menuExpanded by remember { mutableStateOf(false) }
  var groupMenuVisible by remember { mutableStateOf(false) }

  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box {
      Column {
        Row(
          modifier =
            Modifier
              .fillMaxWidth()
              .combinedClickable(
                onClick = onClick,
                onLongClick = {
                  groupMenuVisible = false
                  menuExpanded = true
                },
              ).heightIn(min = 58.dp)
              .padding(vertical = 5.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
          Surface(
            modifier = Modifier.size(30.dp),
            shape = CircleShape,
            color = Color.Transparent,
            border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(
                imageVector = if (active) Icons.Default.StarBorder else Icons.Outlined.ChatBubbleOutline,
                contentDescription = null,
                modifier = Modifier.size(15.dp),
                tint = ClawTheme.colors.text,
              )
            }
          }

          Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
              Text(
                text = title,
                style = ClawTheme.type.body,
                color = ClawTheme.colors.text,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
              )
              if (active) {
                Box(modifier = Modifier.size(3.5.dp).clip(CircleShape).background(ClawTheme.colors.success))
              }
              if (session.unread == true) {
                Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(ClawTheme.colors.primary))
              }
              if (session.pinned == true) {
                Icon(imageVector = Icons.Default.PushPin, contentDescription = "Pinned", modifier = Modifier.size(12.dp), tint = ClawTheme.colors.textMuted)
              }
            }
            if (!compact) {
              Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
              Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                SessionMiniTag(text = "Workspace")
                SessionMiniTag(text = if (active) "Current" else "OpenClaw")
              }
            }
          }

          Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
            Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
          }
        }
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      }
      DropdownMenu(
        expanded = menuExpanded,
        onDismissRequest = {
          menuExpanded = false
          groupMenuVisible = false
        },
      ) {
        if (archived) {
          SessionMenuItem("Unarchive") {
            menuExpanded = false
            onSetArchived(false)
          }
          SessionMenuItem("Delete…") {
            menuExpanded = false
            onDelete()
          }
        } else if (groupMenuVisible) {
          SessionMenuItem("← Back") { groupMenuVisible = false }
          categories.forEach { category ->
            SessionMenuItem(category) {
              menuExpanded = false
              groupMenuVisible = false
              onMoveToGroup(category)
            }
          }
          SessionMenuItem("New group…") {
            menuExpanded = false
            groupMenuVisible = false
            onNewGroup()
          }
          if (!session.category.isNullOrBlank()) {
            SessionMenuItem("Remove from group") {
              menuExpanded = false
              groupMenuVisible = false
              onRemoveFromGroup()
            }
          }
        } else {
          SessionMenuItem(if (session.pinned == true) "Unpin" else "Pin") {
            menuExpanded = false
            onSetPinned(session.pinned != true)
          }
          SessionMenuItem(if (session.unread == true) "Mark as read" else "Mark as unread") {
            menuExpanded = false
            onSetUnread(session.unread != true)
          }
          SessionMenuItem("Rename…") {
            menuExpanded = false
            onRename()
          }
          SessionMenuItem("Fork") {
            menuExpanded = false
            onFork()
          }
          SessionMenuItem("Move to group") { groupMenuVisible = true }
          SessionMenuItem("Archive") {
            menuExpanded = false
            onSetArchived(true)
          }
          SessionMenuItem("Delete…") {
            menuExpanded = false
            onDelete()
          }
        }
      }
    }
  }
}

@Composable
private fun SessionMenuItem(
  text: String,
  onClick: () -> Unit,
) {
  DropdownMenuItem(
    text = { Text(text, style = ClawTheme.type.body) },
    onClick = onClick,
  )
}

@Composable
private fun SessionTextDialog(
  title: String,
  stateKey: String,
  initialValue: String,
  confirmLabel: String,
  allowEmpty: Boolean,
  onDismiss: () -> Unit,
  onConfirm: (String) -> Unit,
) {
  var value by rememberSaveable(stateKey) { mutableStateOf(initialValue) }
  val canConfirm = allowEmpty || value.isNotBlank()
  AlertDialog(
    onDismissRequest = onDismiss,
    containerColor = ClawTheme.colors.surfaceRaised,
    title = { Text(title, style = ClawTheme.type.section, color = ClawTheme.colors.text) },
    text = {
      OutlinedTextField(
        value = value,
        onValueChange = { value = it },
        singleLine = true,
        label = { Text(if (allowEmpty) "Name" else "Group name") },
      )
    },
    confirmButton = {
      TextButton(onClick = { onConfirm(value) }, enabled = canConfirm) {
        Text(confirmLabel)
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text("Cancel")
      }
    },
  )
}

@Composable
private fun SessionOutlineIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = RoundedCornerShape(7.dp),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(14.dp))
    }
  }
}

@Composable
private fun SessionMiniTag(text: String) {
  Surface(
    shape = RoundedCornerShape(5.dp),
    color = Color.Transparent,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.textMuted,
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 4.dp, vertical = 0.5.dp), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), maxLines = 1)
  }
}

private enum class SessionFilter {
  Recent,
  Current,
  Archived,
}

internal data class SessionSection(
  val title: String?,
  val entries: List<ChatSessionEntry>,
)

/** Groups pinned sessions once, followed by alphabetical categories and remaining sessions. */
internal fun groupSessionEntries(entries: List<ChatSessionEntry>): List<SessionSection> {
  if (entries.isEmpty()) return emptyList()
  val pinned = entries.filter { it.pinned == true }
  val remaining = entries.filterNot { it.pinned == true }
  val categorized = remaining.filter { !it.category.isNullOrBlank() }
  val categories =
    categorized
      .groupBy { it.category.orEmpty().trim() }
      .toList()
      .sortedBy { it.first.lowercase() }
  val ungrouped = remaining.filter { it.category.isNullOrBlank() }
  return buildList {
    if (pinned.isNotEmpty()) add(SessionSection(title = "Pinned", entries = pinned))
    categories.forEach { (category, sessions) -> add(SessionSection(title = category, entries = sessions)) }
    if (ungrouped.isNotEmpty()) {
      add(SessionSection(title = "Ungrouped".takeIf { categories.isNotEmpty() }, entries = ungrouped))
    }
  }
}

/** Empty-state title selected by the active session browser filter. */
private fun emptySessionTitle(filter: SessionFilter): String =
  when (filter) {
    SessionFilter.Recent -> "No sessions yet"
    SessionFilter.Current -> "No current session"
    SessionFilter.Archived -> "No archived sessions"
  }

/** Empty-state body selected by the active session browser filter. */
private fun emptySessionBody(filter: SessionFilter): String =
  when (filter) {
    SessionFilter.Recent -> "Start a new conversation and it will show up here."
    SessionFilter.Current -> "Open Chat to start or resume the current session."
    SessionFilter.Archived -> "Archived sessions will show up here."
  }

/** Formats session timestamps for compact mobile metadata. */
private fun relativeSessionTime(updatedAtMs: Long): String {
  val deltaMs = (System.currentTimeMillis() - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m"
  val hours = minutes / 60
  if (hours < 24) return "${hours}h"
  return "${hours / 24}d"
}

/** Prefers the editable label, then falls back to the gateway display name. */
private fun displaySessionTitle(session: ChatSessionEntry): String =
  session.label?.takeIf { it.isNotBlank() }
    ?: session.displayName?.takeIf { it.isNotBlank() }
    ?: "Main session"
