package ai.openclaw.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyColumnDefaults
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.tooling.preview.devices.WearDevices
import ai.openclaw.wear.R
import ai.openclaw.wear.gateway.WearGatewayConfig
import ai.openclaw.wear.gateway.WearReplyAction

@Composable
fun ChatSettingsScreen(
  config: WearGatewayConfig,
  onConfigChange: (WearGatewayConfig) -> Unit,
) {
  val listState = rememberScalingLazyListState()

  ScreenScaffold(scrollState = listState) {
    ScalingLazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      scalingParams = ScalingLazyColumnDefaults.scalingParams(),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      item {
        Text(
          text = stringResource(R.string.wear_settings_behavior_title),
          style = androidx.wear.compose.material3.MaterialTheme.typography.titleSmall,
          color = androidx.wear.compose.material3.MaterialTheme.colorScheme.primary,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
      }

      item {
        SwitchButton(
          checked = config.defaultReplyAction == WearReplyAction.VOICE,
          onCheckedChange = { checked ->
            onConfigChange(
              config.copy(
                defaultReplyAction = if (checked) WearReplyAction.VOICE else WearReplyAction.TEXT,
              ),
            )
          },
          label = { Text(stringResource(R.string.wear_settings_reply_voice_default)) },
          modifier =
            Modifier
              .fillMaxWidth()
              .padding(horizontal = 12.dp),
        )
      }

      item {
        SwitchButton(
          checked = config.nativeTtsEnabled,
          onCheckedChange = { checked ->
            onConfigChange(config.copy(nativeTtsEnabled = checked))
          },
          label = { Text(stringResource(R.string.wear_settings_tts_label)) },
          modifier =
            Modifier
              .fillMaxWidth()
              .padding(horizontal = 12.dp),
        )
      }

      item {
        SettingsChoiceField(
          label = stringResource(R.string.wear_settings_screen_awake),
          value = buildScreenAwakeModeLabel(config.screenAwakeMode),
          helper = buildScreenAwakeModeHelper(config.screenAwakeMode),
          onClick = {
            onConfigChange(
              config.copy(
                screenAwakeMode = nextScreenAwakeMode(config.screenAwakeMode),
              ),
            )
          },
        )
      }

      item { Spacer(modifier = Modifier.height(28.dp)) }
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Preview(device = WearDevices.SMALL_ROUND, showSystemUi = true)
@Composable
private fun ChatSettingsScreenPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ChatSettingsScreen(
        config = previewWearConfig(),
        onConfigChange = {},
      )
    }
  }
}
