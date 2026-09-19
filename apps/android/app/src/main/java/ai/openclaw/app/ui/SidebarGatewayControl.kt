package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTonalElevationEnabled
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun SidebarGatewayControl(
  viewModel: MainViewModel,
  connection: GatewayConnectionDisplay,
  palette: SidebarPalette,
  openSettings: () -> Unit,
) {
  val entries by viewModel.pairedGateways.collectAsState()
  val handoff by viewModel.gatewayConnectionHandoff.collectAsState()
  val focused = entries.firstOrNull { it.stableId == handoff.focusedStableId }
  val activity = LocalActivity.current
  val host = LocalView.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  // A native window opening never survives replacement of its Activity or sidebar host.
  var opening by remember(activity, host, lifecycle) { mutableStateOf<FoldAwareSheetState?>(null) }
  val features by rememberWindowDisplayFeatureState { opening?.publishFeatures(it) }

  fun dismiss(expected: FoldAwareSheetState? = opening) {
    expected?.revoke()
    if (opening === expected) opening = null
  }
  DisposableEffect(activity, host, lifecycle) {
    onDispose { opening?.revoke() }
  }
  LaunchedEffect(entries.size) { if (entries.size <= 1) dismiss() }
  val label = if (entries.isEmpty()) nativeString("Add Gateway") else focused?.name ?: nativeString("Gateways")
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(min = 56.dp)
        .testTag("sidebar-gateway-control")
        .clickable(role = Role.Button) {
          if (entries.isEmpty()) {
            viewModel.openGatewayAddition()
          } else if (entries.size == 1) {
            openSettings()
          } else if (opening == null) {
            var next: FoldAwareSheetState? = null
            next =
              FoldAwareSheetState(activity, host, lifecycle) {
                // Geometry can be revoked during placement; defer Compose removal, not revocation.
                host.post { if (opening === next) opening = null }
              }
            next.publishFeatures(features)
            if (next.canOpen()) opening = next
          }
        }.padding(horizontal = 12.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(Icons.Outlined.Storage, contentDescription = null, tint = palette.muted, modifier = Modifier.size(20.dp))
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      Text(label, style = ClawTheme.type.body, color = palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (entries.isNotEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          GatewayStatus(connection, palette, Modifier.weight(1f, fill = false))
          Text(savedGatewayCount(entries.size), style = ClawTheme.type.caption, color = palette.muted, maxLines = 1)
        }
      }
    }
    if (entries.size > 1) {
      Icon(Icons.Default.UnfoldMore, contentDescription = null, tint = palette.muted, modifier = Modifier.size(20.dp))
    }
  }
  opening?.let { geometry ->
    key(geometry) {
      GatewayPickerSheet(
        geometry = geometry,
        palette = palette,
        entries = entries,
        focusedStableId = handoff.focusedStableId,
        connection = connection,
        selectionEnabled = !handoff.pending,
        onDismiss = { dismiss(geometry) },
        onSelect = { stableId ->
          if (geometry.refresh()) {
            dismiss()
            viewModel.switchGatewayFromSidebar(stableId)
          }
        },
        onAdd = { if (geometry.refresh()) viewModel.openGatewayAddition() },
        openSettings = {
          if (geometry.refresh()) {
            dismiss()
            openSettings()
          }
        },
      )
    }
  }
}

private fun savedGatewayCount(count: Int): String = if (count == 1) nativeString("1 gateway") else nativeString("\$count gateways", count)

private fun gatewayPickerAddress(entry: GatewayRegistryEntry): String {
  val host = entry.host ?: return entry.stableId
  val address = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
  val port = entry.port?.let { ":$it" }.orEmpty()
  return "${if (entry.tls) "wss" else "ws"}://$address$port${entry.contextPath}"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GatewayPickerSheet(
  geometry: FoldAwareSheetState,
  palette: SidebarPalette,
  entries: List<GatewayRegistryEntry>,
  focusedStableId: String?,
  connection: GatewayConnectionDisplay,
  selectionEnabled: Boolean,
  onDismiss: () -> Unit,
  onSelect: (String) -> Unit,
  onAdd: () -> Unit,
  openSettings: () -> Unit,
) {
  var query by rememberSaveable { mutableStateOf("") }
  val showSearch = entries.size > 4
  val filter = if (showSearch) query.trim() else ""
  val visible = entries.filter { it.name.contains(filter, ignoreCase = true) || gatewayPickerAddress(it).contains(filter, ignoreCase = true) }
  val density = LocalDensity.current
  // Match the sidebar exactly, including themes whose canvas equals Material surface.
  // Surface also adds inherited tonal elevation, so zero elevation alone is insufficient.
  CompositionLocalProvider(LocalTonalElevationEnabled provides false) {
    ModalBottomSheet(
      modifier = Modifier.foldAwareSheet(geometry),
      onDismissRequest = onDismiss,
      sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
      containerColor = palette.background,
      tonalElevation = 0.dp,
      contentColor = palette.text,
      contentWindowInsets = { WindowInsets.safeDrawing },
      dragHandle = { BottomSheetDefaults.DragHandle(color = palette.muted) },
    ) {
      CompositionLocalProvider(LocalDensity provides density) {
        // Keep one bounded viewport as search and registry updates change the rows.
        // Resizing the content under the native fold host can leave its previous sheet offset.
        BoxWithConstraints(
          Modifier
            .fillMaxWidth()
            .heightIn(max = 620.dp)
            .fillMaxHeight()
            .testTag("gateway-picker-sheet"),
        ) {
          // The search field stays in the same lazy item when the keyboard changes pane height.
          // Only management moves into the list in a short pane so results retain a viewport.
          val scrollControls = maxHeight < 320.dp * density.fontScale
          val manage: @Composable () -> Unit = {
            Column {
              HorizontalDivider(color = palette.hairline, thickness = 0.5.dp, modifier = Modifier.padding(top = 8.dp))
              Row(
                modifier =
                  Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button, onClick = openSettings)
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 24.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
              ) {
                Icon(Icons.Outlined.Settings, contentDescription = null, tint = palette.muted, modifier = Modifier.size(20.dp))
                Text(nativeString("Manage Gateways"), style = ClawTheme.type.body)
              }
            }
          }
          Column(Modifier.fillMaxHeight()) {
            LazyColumn(Modifier.fillMaxWidth().weight(1f).testTag("gateway-picker-list")) {
              item(key = "header") {
                Row(
                  modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp),
                  verticalAlignment = Alignment.CenterVertically,
                ) {
                  Column(Modifier.weight(1f)) {
                    Text(nativeString("Gateways"), style = ClawTheme.type.title)
                    Text(savedGatewayCount(entries.size), style = ClawTheme.type.caption, color = palette.muted)
                  }
                  TextButton(onClick = onAdd, colors = ButtonDefaults.textButtonColors(contentColor = palette.text)) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(nativeString("Add Gateway"), modifier = Modifier.padding(start = 4.dp))
                  }
                }
                if (showSearch) {
                  OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text(nativeString("Search gateways")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).testTag("gateway-picker-search"),
                  )
                }
              }
              if (visible.isEmpty()) {
                item {
                  Text(nativeString("No matching gateways"), color = palette.muted, modifier = Modifier.padding(20.dp))
                }
              }
              items(visible, key = GatewayRegistryEntry::stableId) { entry ->
                val selected = entry.stableId == focusedStableId
                Row(
                  modifier =
                    Modifier
                      .padding(horizontal = 12.dp, vertical = 2.dp)
                      .fillMaxWidth()
                      .clip(RoundedCornerShape(ClawTheme.radii.row))
                      .background(if (selected) palette.selection else Color.Transparent)
                      .selectable(selected = selected, enabled = selectionEnabled, role = Role.RadioButton) { onSelect(entry.stableId) }
                      .semantics { if (selected) stateDescription = gatewayStatusLabel(connection) }
                      .heightIn(min = 64.dp)
                      .padding(horizontal = 12.dp, vertical = 10.dp),
                  verticalAlignment = Alignment.CenterVertically,
                  horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                  Icon(Icons.Outlined.Storage, contentDescription = null, tint = palette.muted, modifier = Modifier.size(20.dp))
                  Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(entry.name, style = ClawTheme.type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(gatewayPickerAddress(entry), style = ClawTheme.type.caption, color = palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (selected) {
                      GatewayStatus(connection, palette)
                    }
                  }
                  if (selected) Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(20.dp))
                }
              }
              if (scrollControls) item(key = "manage") { manage() }
            }
            if (!scrollControls) manage()
          }
        }
      }
    }
  }
}

@Composable
private fun GatewayStatus(
  connection: GatewayConnectionDisplay,
  palette: SidebarPalette,
  modifier: Modifier = Modifier,
) {
  Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    Box(
      Modifier
        .size(6.dp)
        .clip(CircleShape)
        .background(if (connection.isConnected) ClawTheme.colors.success else palette.muted)
        .clearAndSetSemantics {},
    )
    Text(
      gatewayStatusLabel(connection),
      modifier = Modifier.weight(1f, fill = false),
      style = ClawTheme.type.caption,
      color = palette.muted,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}
