package ai.openclaw.app.ui

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.PopupProperties
import androidx.compose.material3.AlertDialog as PlatformAlertDialog
import androidx.compose.material3.DropdownMenu as PlatformDropdownMenu
import androidx.compose.material3.ModalBottomSheet as PlatformModalBottomSheet
import androidx.compose.ui.window.Dialog as PlatformDialog
import androidx.compose.ui.window.Popup as PlatformPopup

// Native Compose windows install their own LocalDensity. Preserve the caller's
// effective text scaling, without changing native focus, dismissal or geometry.
private fun windowContent(
  density: Density,
  content: @Composable () -> Unit,
): @Composable () -> Unit =
  {
    CompositionLocalProvider(LocalDensity provides density, content = content)
  }

@Composable
internal fun AppDialog(
  onDismissRequest: () -> Unit,
  properties: DialogProperties = DialogProperties(),
  content: @Composable () -> Unit,
) {
  val density = LocalDensity.current
  PlatformDialog(onDismissRequest, properties, windowContent(density, content))
}

@Composable
internal fun AppDropdownMenu(
  expanded: Boolean,
  onDismissRequest: () -> Unit,
  modifier: Modifier = Modifier,
  containerColor: Color = MenuDefaults.containerColor,
  content: @Composable ColumnScope.() -> Unit,
) {
  val density = LocalDensity.current
  PlatformDropdownMenu(expanded, onDismissRequest, modifier = modifier, containerColor = containerColor) {
    CompositionLocalProvider(LocalDensity provides density) { content() }
  }
}

@Composable
internal fun AppAlertDialog(
  onDismissRequest: () -> Unit,
  confirmButton: @Composable () -> Unit,
  dismissButton: (@Composable () -> Unit)? = null,
  title: (@Composable () -> Unit)? = null,
  text: (@Composable () -> Unit)? = null,
  containerColor: Color = AlertDialogDefaults.containerColor,
) {
  val density = LocalDensity.current
  PlatformAlertDialog(
    onDismissRequest = onDismissRequest,
    confirmButton = windowContent(density, confirmButton),
    dismissButton = dismissButton?.let { windowContent(density, it) },
    title = title?.let { windowContent(density, it) },
    text = text?.let { windowContent(density, it) },
    containerColor = containerColor,
  )
}

@Composable
internal fun AppPopup(
  alignment: Alignment,
  offset: IntOffset,
  onDismissRequest: () -> Unit,
  properties: PopupProperties,
  content: @Composable () -> Unit,
) {
  val density = LocalDensity.current
  PlatformPopup(alignment, offset, onDismissRequest, properties, windowContent(density, content))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppModalBottomSheet(
  onDismissRequest: () -> Unit,
  sheetState: SheetState,
  containerColor: Color,
  contentColor: Color,
  modifier: Modifier = Modifier,
  properties: ModalBottomSheetProperties = ModalBottomSheetProperties(),
  content: @Composable ColumnScope.() -> Unit,
) {
  val density = LocalDensity.current
  PlatformModalBottomSheet(
    onDismissRequest = onDismissRequest,
    sheetState = sheetState,
    containerColor = containerColor,
    contentColor = contentColor,
    modifier = modifier,
    properties = properties,
  ) {
    CompositionLocalProvider(LocalDensity provides density) { content() }
  }
}
