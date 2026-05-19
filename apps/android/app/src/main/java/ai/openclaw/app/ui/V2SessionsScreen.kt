package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun V2SessionsScreen(
  viewModel: MainViewModel,
  onOpenCommand: () -> Unit,
  onOpenChat: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val chatSessionKey by viewModel.chatSessionKey.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 200)
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(7.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(text = "Sessions", style = ClawTheme.type.display.copy(fontSize = 17.4.sp, lineHeight = 21.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2SessionPlainIconButton(icon = Icons.Default.Search, contentDescription = "Search sessions", onClick = onOpenCommand)
          V2SessionPlainIconButton(icon = Icons.Default.MoreVert, contentDescription = "Session options", onClick = {})
        }
      }

      item {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          V2FilterPill(text = "Recent", icon = Icons.Outlined.AccessTime, active = true)
          V2FilterPill(text = "Live", icon = Icons.Outlined.MicNone, active = false, live = true)
          V2FilterPill(text = "Pinned", icon = Icons.Default.StarBorder, active = false)
        }
      }

      item {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            V2FilterPill(text = "Channel", dropdown = true)
            V2FilterPill(text = "Agent", dropdown = true)
          }
          V2SessionOutlineIconButton(icon = Icons.Default.Storage, contentDescription = "Session layout", onClick = {})
        }
      }

      item {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(text = "Sort: Recent", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
        }
      }

      if (sessions.isEmpty()) {
        item {
          ClawEmptyState(
            title = "No sessions yet",
            body = "Start a new conversation and it will show up here.",
            action = { ClawPrimaryButton(text = "Start Chat", onClick = onOpenChat) },
          )
        }
      } else {
        items(sessions, key = { it.key }) { session ->
          val active = session.key == chatSessionKey
          V2SessionRow(
            title = displaySessionTitle(session.displayName),
            subtitle = if (active) "Current session" else "OpenClaw session",
            metadata = session.updatedAtMs?.let(::relativeSessionTime) ?: "now",
            active = active,
            onClick = {
              viewModel.switchChatSession(session.key)
              onOpenChat()
            },
          )
        }
      }

      item {
        Spacer(modifier = Modifier.height(16.dp))
      }
    }
  }
}

@Composable
private fun V2FilterPill(
  text: String,
  icon: ImageVector? = null,
  active: Boolean = false,
  live: Boolean = false,
  dropdown: Boolean = false,
) {
  Surface(
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
      if (live) {
        Box(modifier = Modifier.size(4.dp).clip(CircleShape).background(ClawTheme.colors.success))
      }
      if (dropdown) {
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun V2SessionRow(
  title: String,
  subtitle: String,
  metadata: String,
  active: Boolean,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Column {
      Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
      ) {
        Surface(
          modifier = Modifier.size(21.dp),
          shape = CircleShape,
          color = Color.Transparent,
          border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = if (active) Icons.Default.StarBorder else Icons.Outlined.ChatBubbleOutline,
              contentDescription = null,
              modifier = Modifier.size(10.dp),
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
          }
          Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
          Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            V2SessionMiniTag(text = "Workspace")
            V2SessionMiniTag(text = if (active) "Active" else "OpenClaw")
          }
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
          Icon(imageVector = Icons.Default.MoreVert, contentDescription = "Session options", modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
          Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
        }
      }
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
    }
  }
}

@Composable
private fun V2SessionPlainIconButton(
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
private fun V2SessionOutlineIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(width = 34.dp, height = 26.dp),
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
private fun V2SessionMiniTag(text: String) {
  Surface(
    shape = RoundedCornerShape(5.dp),
    color = Color.Transparent,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.textMuted,
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 4.dp, vertical = 0.5.dp), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), maxLines = 1)
  }
}

private fun relativeSessionTime(updatedAtMs: Long): String {
  val deltaMs = (System.currentTimeMillis() - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m"
  val hours = minutes / 60
  if (hours < 24) return "${hours}h"
  return "${hours / 24}d"
}

private fun displaySessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: "Main session"
