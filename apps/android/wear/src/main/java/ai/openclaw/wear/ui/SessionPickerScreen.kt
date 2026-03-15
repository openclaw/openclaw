package ai.openclaw.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.tooling.preview.devices.WearDevices
import ai.openclaw.wear.R
import ai.openclaw.wear.WearViewModel
import ai.openclaw.android.gateway.GatewaySessionEntry

@Composable
fun SessionPickerScreen(
  viewModel: WearViewModel,
  onBack: () -> Unit,
) {
  val sessions by viewModel.sessions.collectAsState()
  val currentKey by viewModel.sessionKey.collectAsState()

  LaunchedEffect(viewModel) {
    viewModel.refreshSessions()
  }

  SessionPickerContent(
    sessions = sessions,
    currentKey = currentKey,
    onSelectSession = { key ->
      viewModel.switchSession(key)
      onBack()
    },
  )
}

@Composable
private fun SessionPickerContent(
  sessions: List<GatewaySessionEntry>,
  currentKey: String,
  onSelectSession: (String) -> Unit,
) {

  val listState = rememberScalingLazyListState()

  ScreenScaffold(scrollState = listState) {
    ScalingLazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      item {
        Text(
          text = stringResource(R.string.wear_sessions_title),
          style = MaterialTheme.typography.titleSmall,
          color = MaterialTheme.colorScheme.primary,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
      }

      if (sessions.isEmpty()) {
        item {
          Text(
            text = stringResource(R.string.wear_sessions_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
          )
        }
      }

      items(sessions, key = { it.key }) { session ->
        SessionItem(
          session = session,
          isSelected = session.key == currentKey,
          onClick = { onSelectSession(session.key) },
        )
      }

      item { Spacer(modifier = Modifier.height(16.dp)) }
    }
  }
}

@Composable
private fun SessionItem(
  session: GatewaySessionEntry,
  isSelected: Boolean,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 12.dp),
    colors = if (isSelected) {
      ButtonDefaults.buttonColors()
    } else {
      ButtonDefaults.filledTonalButtonColors()
    },
    label = {
      Text(
        text = session.displayName ?: session.key,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    },
    secondaryLabel = if (session.displayName != null && session.displayName != session.key) {
      {
        Text(
          text = session.key,
          maxLines = 4,
          overflow = TextOverflow.Clip,
        )
      }
    } else null,
    icon = if (isSelected) {
      {
        Icon(
          Icons.Filled.Check,
          contentDescription = null,
          modifier = Modifier.size(16.dp),
        )
      }
    } else null,
  )
}

private fun previewSessions(): List<GatewaySessionEntry> =
  listOf(
    GatewaySessionEntry(
      key = "agent:main:main",
      updatedAtMs = 1_000,
      displayName = "Heartbeat",
    ),
    GatewaySessionEntry(
      key = "agent:main:matrix:channel:!123456789abcdef:matrix.org",
      updatedAtMs = 2_000,
      displayName = "matrix:#cool-channel-matrix.org",
    ),
  )

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Preview(device = WearDevices.SMALL_ROUND, showSystemUi = true)
@Composable
private fun SessionPickerScreenPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      SessionPickerContent(
        sessions = previewSessions(),
        currentKey = "agent:main:matrix:channel:!123456789abcdef:matrix.org",
        onSelectSession = {},
      )
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Composable
private fun SessionPickerEmptyPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      SessionPickerContent(
        sessions = emptyList(),
        currentKey = "agent:main:main",
        onSelectSession = {},
      )
    }
  }
}
