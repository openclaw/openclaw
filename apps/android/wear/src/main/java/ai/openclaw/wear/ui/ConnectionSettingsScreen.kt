package ai.openclaw.wear.ui

import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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

private const val HOST_KEY = "gw_host"
private const val PORT_KEY = "gw_port"
private const val TOKEN_KEY = "gw_token"

@Composable
fun ConnectionSettingsScreen(
  config: WearGatewayConfig,
  onConfigChange: (WearGatewayConfig) -> Unit,
) {
  val context = LocalContext.current
  val hostLauncher = remoteInputLauncher(HOST_KEY) { value ->
    onConfigChange(config.copy(host = value))
  }
  val portLauncher = remoteInputLauncher(PORT_KEY) { value ->
    value.toIntOrNull()?.let { onConfigChange(config.copy(port = it)) }
  }
  val tokenLauncher = remoteInputLauncher(TOKEN_KEY) { value ->
    onConfigChange(config.copy(token = value))
  }

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
          text = stringResource(R.string.wear_connection_title),
          style = androidx.wear.compose.material3.MaterialTheme.typography.titleSmall,
          color = androidx.wear.compose.material3.MaterialTheme.colorScheme.primary,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
      }

      item {
        SwitchButton(
          checked = config.usePhoneProxy,
          onCheckedChange = { checked ->
            onConfigChange(config.copy(usePhoneProxy = checked))
          },
          label = { Text(stringResource(R.string.wear_connection_route_phone)) },
          modifier =
            Modifier
              .fillMaxWidth()
              .padding(horizontal = 12.dp),
        )
      }
      item {
        Text(
          text = stringResource(R.string.wear_connection_route_phone_help),
          style = androidx.wear.compose.material3.MaterialTheme.typography.labelSmall,
          color = androidx.wear.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
        )
      }

      if (config.usePhoneProxy) {
        item {
          InfoCard(
            title = stringResource(R.string.wear_connection_phone_proxy_title),
            body = stringResource(R.string.wear_connection_phone_proxy_body),
          )
        }
      } else {
        item {
          SettingsField(
            label = stringResource(R.string.wear_connection_host),
            value = config.host.ifEmpty { stringResource(R.string.wear_connection_not_set) },
            onClick = {
              launchRemoteInput(
                key = HOST_KEY,
                label = context.getString(R.string.wear_connection_gateway_host),
                launcher = hostLauncher,
              )
            },
          )
        }

        item {
          SettingsField(
            label = stringResource(R.string.wear_connection_port),
            value = config.port.toString(),
            onClick = {
              launchRemoteInput(
                key = PORT_KEY,
                label = context.getString(R.string.wear_connection_gateway_port),
                launcher = portLauncher,
              )
            },
          )
        }

        item {
          SettingsField(
            label = stringResource(R.string.wear_connection_token),
            value =
              if (config.token.isNotEmpty()) {
                stringResource(R.string.wear_connection_saved)
              } else {
                stringResource(R.string.wear_connection_not_set)
              },
            onClick = {
              launchRemoteInput(
                key = TOKEN_KEY,
                label = context.getString(R.string.wear_connection_gateway_token),
                launcher = tokenLauncher,
              )
            },
          )
        }

        item {
          SwitchButton(
            checked = config.useTls,
            onCheckedChange = { checked ->
              onConfigChange(config.copy(useTls = checked))
            },
            label = { Text(stringResource(R.string.wear_connection_use_tls)) },
            modifier =
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
          )
        }
        item {
          Text(
            text =
              if (config.useTls) {
                stringResource(R.string.wear_connection_connect_wss)
              } else {
                stringResource(R.string.wear_connection_connect_ws)
              },
            style = androidx.wear.compose.material3.MaterialTheme.typography.labelSmall,
            color = androidx.wear.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
          )
        }
      }

      item { Spacer(modifier = Modifier.height(28.dp)) }
    }
  }
}

private fun launchRemoteInput(
  key: String,
  label: String,
  launcher: androidx.activity.result.ActivityResultLauncher<android.content.Intent>,
) {
  val remoteInputs =
    listOf(
      RemoteInput.Builder(key)
        .setLabel(label)
        .build(),
    )
  val intent = androidx.wear.input.RemoteInputIntentHelper.createActionRemoteInputIntent()
  androidx.wear.input.RemoteInputIntentHelper.putRemoteInputsExtra(intent, remoteInputs)
  launcher.launch(intent)
}

@Composable
private fun remoteInputLauncher(
  key: String,
  onResult: (String) -> Unit,
) =
  rememberLauncherForActivityResult(
    ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    result.data?.let { data ->
      val results = RemoteInput.getResultsFromIntent(data)
      val value = results?.getCharSequence(key)?.toString()
      if (value != null) {
        onResult(value)
      }
    }
  }

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Preview(device = WearDevices.SMALL_ROUND, showSystemUi = true)
@Composable
private fun ConnectionSettingsScreenPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ConnectionSettingsScreen(
        config = previewDirectConfig(),
        onConfigChange = {},
      )
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Composable
private fun ConnectionSettingsPhoneProxyPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ConnectionSettingsScreen(
        config = previewWearConfig(),
        onConfigChange = {},
      )
    }
  }
}
