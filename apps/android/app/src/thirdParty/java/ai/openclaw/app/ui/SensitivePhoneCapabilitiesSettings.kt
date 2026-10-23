package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.accessibility.AccessibilityComponentController
import ai.openclaw.app.i18n.nativeString
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

@Composable
internal fun FlavorPhoneCapabilitiesSettings(viewModel: MainViewModel) {
  val context = LocalContext.current
  val enabled by viewModel.accessibilityControlEnabled.collectAsState()
  var showDisclosure by rememberSaveable { mutableStateOf(false) }

  fun setControlEnabled(checked: Boolean) {
    if (checked) {
      showDisclosure = true
      return
    }
    viewModel.setAccessibilityControlEnabled(false)
    AccessibilityComponentController(context).setEnabled(false)
  }

  SettingsTogglePanel(
    rows =
      listOf(
        SettingsToggleRow(
          title = nativeString("Control other apps"),
          subtitle =
            if (enabled) {
              nativeString("Shown in Android Accessibility settings.")
            } else {
              nativeString("Other apps stay untouched.")
            },
          icon = Icons.AutoMirrored.Filled.ScreenShare,
          checked = enabled,
          onCheckedChange = ::setControlEnabled,
        ),
      ),
  )

  if (showDisclosure) {
    AppConfirmationDialog(
      onDismiss = { showDisclosure = false },
      title = nativeString("Allow control of other apps?"),
      confirmLabel = nativeString("Enable and Open Settings"),
      dismissLabel = nativeString("Not Now"),
      onConfirm = {
        showDisclosure = false
        viewModel.setAccessibilityControlEnabled(true)
        AccessibilityComponentController(context).setEnabled(true)
        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      },
      text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text(
            nativeString(
              "Enabling lets OpenClaw observe and control other apps' screens when armed. Android accessibility access is required.",
            ),
          )
        }
      },
    )
  }
}
