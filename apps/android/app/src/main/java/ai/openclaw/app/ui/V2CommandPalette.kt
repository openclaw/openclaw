package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun V2CommandPalette(
  viewModel: MainViewModel,
  onDismiss: () -> Unit,
  onOpenChat: () -> Unit,
  onOpenVoice: () -> Unit,
  onOpenSessions: () -> Unit,
  onOpenProviders: () -> Unit,
  onOpenSettings: () -> Unit,
  onOpenSession: (String) -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  var query by rememberSaveable { mutableStateOf("") }
  val normalizedQuery = query.trim().lowercase()
  val quickActions =
    listOf(
      V2CommandItem("Open Chat", "Start or continue a conversation", Icons.Outlined.ChatBubbleOutline, onOpenChat),
      V2CommandItem("Start Voice", "Talk or dictate with OpenClaw", Icons.Outlined.MicNone, onOpenVoice),
      V2CommandItem("Browse Sessions", "Find previous conversations", Icons.Outlined.AccessTime, onOpenSessions),
      V2CommandItem("Providers & Models", providerCommandSubtitle(isConnected, providers, models), Icons.Outlined.Inventory2, onOpenProviders),
      V2CommandItem("Settings", "Gateway, voice, notifications, privacy", Icons.Outlined.Settings, onOpenSettings),
    )
  val actionRows = quickActions.filter { it.matches(normalizedQuery) }
  val sessionRows =
    sessions
      .filter { session ->
        val title = commandSessionTitle(session.displayName)
        normalizedQuery.isEmpty() || title.lowercase().contains(normalizedQuery)
      }.take(5)

  Surface(modifier = Modifier.fillMaxSize(), color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
          ) {
            V2CommandIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close search", onClick = onDismiss)
            Text(text = "Search", style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
            V2CommandAvatar(text = "OC")
          }
        }

        item {
          ClawTextField(value = query, onValueChange = { query = it }, placeholder = "Search OpenClaw")
        }

        item {
          V2CommandSectionLabel(title = "Quick actions")
        }

        if (actionRows.isEmpty()) {
          item {
            ClawEmptyState(title = "No actions found", body = "Try Chat, Voice, Sessions, Providers, or Settings.")
          }
        } else {
          item {
            V2CommandActionList(rows = actionRows)
          }
        }

        item {
          V2CommandSectionLabel(title = "Sessions")
        }

        if (sessionRows.isEmpty()) {
          item {
            ClawPanel {
              Text(
                text = if (isConnected) "No matching sessions yet." else "Connect the Gateway to search sessions.",
                style = ClawTheme.type.body,
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        } else {
          item {
            V2CommandSessionList(
              rows =
                sessionRows.map { session ->
                  V2CommandSessionRow(
                    key = session.key,
                    title = commandSessionTitle(session.displayName),
                    subtitle = if (pendingRunCount > 0) "Assistant working" else "OpenClaw session",
                    metadata = session.updatedAtMs?.let(::commandRelativeTime) ?: "now",
                  )
                },
              onOpen = onOpenSession,
            )
          }
        }
      }
    }
  }
}

private data class V2CommandItem(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val onClick: () -> Unit,
) {
  fun matches(query: String): Boolean = query.isEmpty() || title.lowercase().contains(query) || subtitle.lowercase().contains(query)
}

private data class V2CommandSessionRow(
  val key: String,
  val title: String,
  val subtitle: String,
  val metadata: String,
)

@Composable
private fun V2CommandActionList(rows: List<V2CommandItem>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2CommandActionRow(row = row)
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2CommandActionRow(row: V2CommandItem) {
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = row.onClick)
          .padding(vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun V2CommandSessionList(
  rows: List<V2CommandSessionRow>,
  onOpen: (String) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2CommandSessionListRow(row = row, onClick = { onOpen(row.key) })
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2CommandSessionListRow(
  row: V2CommandSessionRow,
  onClick: () -> Unit,
) {
  Surface(color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(24.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1)
      }
      Text(text = row.metadata, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open session",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun V2CommandIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, modifier = Modifier.size(30.dp), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
private fun V2CommandAvatar(text: String) {
  Surface(
    modifier = Modifier.size(28.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = text.take(2).uppercase(), style = ClawTheme.type.label)
    }
  }
}

@Composable
private fun V2CommandSectionLabel(title: String) {
  Row(modifier = Modifier.fillMaxWidth()) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
}

private fun providerCommandSubtitle(
  isConnected: Boolean,
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): String {
  if (!isConnected) return "Connect Gateway to load models"
  val readyProviderCount = providers.count { modelProviderReady(it.status) }
  if (readyProviderCount > 0) return "$readyProviderCount providers ready"
  if (models.isNotEmpty()) return "${models.size} models available"
  return "Configure model access"
}

private fun commandSessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: "Main session"

private fun commandRelativeTime(updatedAtMs: Long): String {
  val deltaMs = (System.currentTimeMillis() - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m"
  val hours = minutes / 60
  if (hours < 24) return "${hours}h"
  return "${hours / 24}d"
}
