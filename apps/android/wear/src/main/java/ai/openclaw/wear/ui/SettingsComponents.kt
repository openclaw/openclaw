package ai.openclaw.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import ai.openclaw.wear.R
import ai.openclaw.wear.gateway.WearGatewayConfig
import ai.openclaw.wear.gateway.WearReplyAction
import ai.openclaw.wear.gateway.WearScreenAwakeMode

internal enum class WearStatusTone {
  CONNECTED,
  ATTENTION,
  ERROR,
}

internal fun previewWearConfig(): WearGatewayConfig =
  WearGatewayConfig(
    usePhoneProxy = true,
    defaultReplyAction = WearReplyAction.VOICE,
    nativeTtsEnabled = true,
    screenAwakeMode = WearScreenAwakeMode.WHILE_WAITING,
    host = "gateway-host",
    port = 18789,
  )

internal fun previewDirectConfig(): WearGatewayConfig =
  WearGatewayConfig(
    usePhoneProxy = false,
    host = "gateway-host",
    port = 18789,
    token = "secret",
    useTls = true,
    defaultReplyAction = WearReplyAction.TEXT,
    nativeTtsEnabled = false,
    screenAwakeMode = WearScreenAwakeMode.ALWAYS,
  )

@Composable
internal fun StatusCard(
  statusTone: WearStatusTone,
  statusText: String,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .clip(RoundedCornerShape(12.dp))
        .background(MaterialTheme.colorScheme.surfaceContainer)
        .padding(horizontal = 12.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(
              when (statusTone) {
                WearStatusTone.CONNECTED -> Color(0xFF58D68D)
                WearStatusTone.ATTENTION -> Color(0xFFFFC857)
                WearStatusTone.ERROR -> Color(0xFFFF6B57)
              },
            ),
      )
      Spacer(modifier = Modifier.width(8.dp))
      Text(
        text = statusText,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurface,
      )
    }
  }
}

@Composable
internal fun InfoCard(title: String, body: String) {
  Box(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(MaterialTheme.colorScheme.surfaceContainer)
        .padding(horizontal = 10.dp, vertical = 8.dp),
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
          Icons.Filled.Info,
          contentDescription = null,
          modifier = Modifier.size(14.dp),
          tint = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
          text = title,
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.primary,
        )
      }
      Text(
        text = body,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
internal fun SettingsNavButton(
  label: String,
  value: String? = null,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
    colors = ButtonDefaults.filledTonalButtonColors(),
    label = {
      Text(
        text = label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    },
    secondaryLabel =
      value?.let {
        {
          Text(
            text = it,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      },
  )
}

@Composable
internal fun SettingsChoiceField(
  label: String,
  value: String,
  helper: String = "",
  onClick: () -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Button(
      onClick = onClick,
      modifier = Modifier.fillMaxWidth(),
      colors = ButtonDefaults.filledTonalButtonColors(),
      label = {
        Text(
          text = label,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      },
      secondaryLabel = {
        Text(
          text = value,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      },
    )
    if (helper.isNotEmpty()) {
      Text(
        text = helper,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 12.dp),
      )
    }
  }
}

@Composable
internal fun SettingsField(label: String, value: String, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
    colors = ButtonDefaults.filledTonalButtonColors(),
    label = {
      Text(
        text = label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    },
    secondaryLabel = {
      Text(
        text = value,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    },
  )
}

@Composable
internal fun buildScreenAwakeModeLabel(mode: WearScreenAwakeMode): String =
  when (mode) {
    WearScreenAwakeMode.DEFAULT -> stringResource(R.string.wear_settings_screen_default)
    WearScreenAwakeMode.WHILE_WAITING -> stringResource(R.string.wear_settings_screen_while_waiting)
    WearScreenAwakeMode.ALWAYS -> stringResource(R.string.wear_settings_screen_always_on)
  }

@Composable
internal fun buildScreenAwakeModeHelper(mode: WearScreenAwakeMode): String =
  when (mode) {
    WearScreenAwakeMode.DEFAULT -> stringResource(R.string.wear_settings_screen_default_helper)
    WearScreenAwakeMode.WHILE_WAITING -> stringResource(R.string.wear_settings_screen_while_waiting_helper)
    WearScreenAwakeMode.ALWAYS -> stringResource(R.string.wear_settings_screen_always_on_helper)
  }

internal fun nextScreenAwakeMode(mode: WearScreenAwakeMode): WearScreenAwakeMode =
  when (mode) {
    WearScreenAwakeMode.DEFAULT -> WearScreenAwakeMode.WHILE_WAITING
    WearScreenAwakeMode.WHILE_WAITING -> WearScreenAwakeMode.ALWAYS
    WearScreenAwakeMode.ALWAYS -> WearScreenAwakeMode.DEFAULT
  }
