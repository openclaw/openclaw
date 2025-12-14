package com.steipete.clawdis.node.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
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
  LaunchedEffect(wakeWords) { setWakeWordsText(wakeWords.joinToString(", ")) }

  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
      val cameraOk = perms[Manifest.permission.CAMERA] == true
      viewModel.setCameraEnabled(cameraOk)
    }

  LazyColumn(
    state = listState,
    modifier = Modifier.fillMaxWidth().imePadding(),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    item { Text("Node") }
    item {
      OutlinedTextField(
        value = displayName,
        onValueChange = viewModel::setDisplayName,
        label = { Text("Name") },
        modifier = Modifier.fillMaxWidth(),
      )
    }
    item { Text("Instance ID: $instanceId") }

    item { HorizontalDivider() }

    item { Text("Wake Words") }
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
      )
    }

    item { HorizontalDivider() }

    item { Text("Camera") }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        Switch(
          checked = cameraEnabled,
          onCheckedChange = { enabled ->
            if (!enabled) {
              viewModel.setCameraEnabled(false)
              return@Switch
            }

            val cameraOk =
              ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
            if (cameraOk) {
              viewModel.setCameraEnabled(true)
            } else {
              permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
            }
          },
        )
        Text(if (cameraEnabled) "Allow Camera" else "Camera Disabled")
      }
    }
    item { Text("Tip: grant Microphone permission for video clips with audio.") }

    item { HorizontalDivider() }

    item { Text("Bridge") }
    item { Text("Status: $statusText") }
    item { if (serverName != null) Text("Server: $serverName") }
    item { if (remoteAddress != null) Text("Address: $remoteAddress") }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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

    item { Text("Advanced") }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        Switch(checked = manualEnabled, onCheckedChange = viewModel::setManualEnabled)
        Text(if (manualEnabled) "Manual Bridge Enabled" else "Manual Bridge Disabled")
      }
    }
    item {
      OutlinedTextField(
        value = manualHost,
        onValueChange = viewModel::setManualHost,
        label = { Text("Host") },
        modifier = Modifier.fillMaxWidth(),
        enabled = manualEnabled,
      )
    }
    item {
      OutlinedTextField(
        value = manualPort.toString(),
        onValueChange = { v -> viewModel.setManualPort(v.toIntOrNull() ?: 0) },
        label = { Text("Port") },
        modifier = Modifier.fillMaxWidth(),
        enabled = manualEnabled,
      )
    }
    item {
      Button(
        onClick = {
          NodeForegroundService.start(context)
          viewModel.connectManual()
        },
        enabled = manualEnabled,
      ) {
        Text("Connect (Manual)")
      }
    }

    item { HorizontalDivider() }

    item { Text("Discovered Bridges") }
    if (bridges.isEmpty()) {
      item { Text("No bridges found yet.") }
    } else {
      items(items = bridges, key = { it.stableId }) { bridge ->
        Row(
          modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
          horizontalArrangement = Arrangement.SpaceBetween,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text(bridge.name)
            Text("${bridge.host}:${bridge.port}")
          }
          Spacer(modifier = Modifier.padding(4.dp))
          Button(
            onClick = {
              NodeForegroundService.start(context)
              viewModel.connect(bridge)
            },
          ) {
            Text("Connect")
          }
        }
        HorizontalDivider()
      }
    }

    item { Spacer(modifier = Modifier.height(20.dp)) }
  }
}
