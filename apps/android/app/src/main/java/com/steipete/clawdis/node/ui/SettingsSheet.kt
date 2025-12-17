package com.steipete.clawdis.node.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.steipete.clawdis.node.MainViewModel
import com.steipete.clawdis.node.NodeForegroundService

@Composable
fun SettingsSheet(viewModel: MainViewModel) {
  val context = LocalContext.current
  val instanceId by viewModel.instanceId.collectAsState()
  val displayName by viewModel.displayName.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val wakeWords by viewModel.wakeWords.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val manualEnabled by viewModel.manualEnabled.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val bridges by viewModel.bridges.collectAsState()

  val listState = rememberLazyListState()
  val (wakeWordsText, setWakeWordsText) = remember { mutableStateOf("") }
  val (advancedExpanded, setAdvancedExpanded) = remember { mutableStateOf(false) }

  LaunchedEffect(wakeWords) { setWakeWordsText(wakeWords.joinToString(", ")) }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val cameraOk = perms[Manifest.permission.CAMERA] == true
      viewModel.setCameraEnabled(cameraOk)
    }

  fun setCameraEnabledChecked(checked: Boolean) {
    if (!checked) {
      viewModel.setCameraEnabled(false)
      return
    }

    val cameraOk =
      ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
    if (cameraOk) {
      viewModel.setCameraEnabled(true)
    } else {
      permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
    }
  }

  val bridgeDiscoveryFooterText =
    if (bridges.isEmpty()) {
      "Searching for bridges…"
    } else {
      "Discovery active • ${bridges.size} bridge${if (bridges.size == 1) "" else "s"} found"
    }

  LazyColumn(
    state = listState,
    modifier =
      Modifier
        .fillMaxWidth()
        .fillMaxHeight()
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    item { Text("Node", style = MaterialTheme.typography.titleSmall) }
    item {
      OutlinedTextField(
        value = displayName,
        onValueChange = viewModel::setDisplayName,
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
      )
    }
    item { Text("Instance ID: $instanceId", color = MaterialTheme.colorScheme.onSurfaceVariant) }

    item { HorizontalDivider() }

    item { Text("Wake Words", style = MaterialTheme.typography.titleSmall) }
    item {
      OutlinedTextField(
        value = wakeWordsText,
        onValueChange = setWakeWordsText,
        label = { Text("Comma-separated (global)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
      )
    }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(
          onClick = {
            val parsed = com.steipete.clawdis.node.WakeWords.parseCommaSeparated(wakeWordsText)
            viewModel.setWakeWords(parsed)
          },
          enabled = isConnected,
        ) {
          Text("Save + Sync")
        }

        Button(onClick = viewModel::resetWakeWordsDefaults) { Text("Reset defaults") }
      }
    }
    item {
      Text(
        if (isConnected) {
          "Any node can edit wake words. Changes sync via the gateway bridge."
        } else {
          "Connect to a gateway to sync wake words globally."
        },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    item { Text("Camera", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("Allow Camera") },
        supportingContent = { Text("Allows the bridge to request photos or short video clips (foreground only).") },
        trailingContent = { Switch(checked = cameraEnabled, onCheckedChange = ::setCameraEnabledChecked) },
      )
    }
    item {
      Text(
        "Tip: grant Microphone permission for video clips with audio.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    item { Text("Screen", style = MaterialTheme.typography.titleSmall) }
    item {
      ListItem(
        headlineContent = { Text("Prevent Sleep") },
        supportingContent = { Text("Keeps the screen awake while Clawdis is open.") },
        trailingContent = { Switch(checked = preventSleep, onCheckedChange = viewModel::setPreventSleep) },
      )
    }

    item { HorizontalDivider() }

    item { Text("Bridge", style = MaterialTheme.typography.titleSmall) }
    item { ListItem(headlineContent = { Text("Status") }, supportingContent = { Text(statusText) }) }
    if (serverName != null) {
      item { ListItem(headlineContent = { Text("Server") }, supportingContent = { Text(serverName!!) }) }
    }
    if (remoteAddress != null) {
      item { ListItem(headlineContent = { Text("Address") }, supportingContent = { Text(remoteAddress!!) }) }
    }
    item {
      if (isConnected) {
        Button(
          onClick = {
            viewModel.disconnect()
            NodeForegroundService.stop(context)
          },
        ) {
          Text("Disconnect")
        }
      }
    }

    item { HorizontalDivider() }

    item { Text("Discovered Bridges", style = MaterialTheme.typography.titleSmall) }
    if (bridges.isEmpty()) {
      item { Text("No bridges found yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    } else {
      items(items = bridges, key = { it.stableId }) { bridge ->
        ListItem(
          headlineContent = { Text(bridge.name) },
          supportingContent = { Text("${bridge.host}:${bridge.port}") },
          trailingContent = {
            Button(
              onClick = {
                NodeForegroundService.start(context)
                viewModel.connect(bridge)
              },
            ) {
              Text("Connect")
            }
          },
        )
      }
    }
    item {
      Text(
        bridgeDiscoveryFooterText,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    item { HorizontalDivider() }

    item {
      ListItem(
        headlineContent = { Text("Advanced") },
        supportingContent = { Text("Manual bridge connection") },
        trailingContent = {
          Icon(
            imageVector = if (advancedExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
            contentDescription = if (advancedExpanded) "Collapse" else "Expand",
          )
        },
        modifier =
          Modifier.clickable {
            setAdvancedExpanded(!advancedExpanded)
          },
      )
    }
    item {
      AnimatedVisibility(visible = advancedExpanded) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
          ListItem(
            headlineContent = { Text("Use Manual Bridge") },
            supportingContent = { Text("Use this when discovery is blocked.") },
            trailingContent = { Switch(checked = manualEnabled, onCheckedChange = viewModel::setManualEnabled) },
          )

          OutlinedTextField(
            value = manualHost,
            onValueChange = viewModel::setManualHost,
            label = { Text("Host") },
            modifier = Modifier.fillMaxWidth(),
            enabled = manualEnabled,
          )
          OutlinedTextField(
            value = manualPort.toString(),
            onValueChange = { v -> viewModel.setManualPort(v.toIntOrNull() ?: 0) },
            label = { Text("Port") },
            modifier = Modifier.fillMaxWidth(),
            enabled = manualEnabled,
          )

          val hostOk = manualHost.trim().isNotEmpty()
          val portOk = manualPort in 1..65535
          Button(
            onClick = {
              NodeForegroundService.start(context)
              viewModel.connectManual()
            },
            enabled = manualEnabled && hostOk && portOk,
          ) {
            Text("Connect (Manual)")
          }
        }
      }
    }

    item { Spacer(modifier = Modifier.height(20.dp)) }
  }
}

