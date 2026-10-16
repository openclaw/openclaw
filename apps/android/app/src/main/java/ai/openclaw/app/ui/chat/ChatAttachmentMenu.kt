package ai.openclaw.app.ui.chat

import ai.openclaw.app.NodeApp
import ai.openclaw.app.chat.ChatPermissionMode
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.node.LocationCaptureManager
import ai.openclaw.app.node.LocationDisclosure
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.util.Locale

private enum class AttachmentPage { Menu, Location }

/** One owner-bound opening; external results still pass through the composer's media leases. */
@Composable
internal fun ChatAttachmentMenu(
  opening: ChatModelPickerSession,
  composerAnchor: LayoutCoordinates?,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
  permissionMode: ChatPermissionMode?,
  permissionModePending: Boolean,
  permissionsEnabled: Boolean,
  onOpenPermissions: () -> Unit,
  onOpenCamera: () -> Unit,
  onBrowseGallery: () -> Unit,
  onPickFile: () -> Unit,
  onLocation: (String) -> Unit,
) {
  var page by remember { mutableStateOf(AttachmentPage.Menu) }
  ChatComposerPopover(
    geometry = opening.geometry,
    title = nativeString("Add attachment"),
    composerAnchor = composerAnchor,
    admit = admit,
    onDismiss = onDismiss,
    maximumWidth = 280.dp,
    horizontalAlignment = Alignment.Start,
    shape = RoundedCornerShape(24.dp),
  ) { admitAction ->
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(8.dp)) {
      if (page != AttachmentPage.Menu) {
        TextButton(onClick = { if (admitAction()) page = AttachmentPage.Menu }) { Text(nativeString("Back")) }
      }
      when (page) {
        AttachmentPage.Location -> {
          LocationAttachment(admit = admitAction, onLocation = onLocation)
        }

        AttachmentPage.Menu -> {
          AttachmentMenuAction(
            nativeString("Camera"),
            onClick = { if (admitAction()) onOpenCamera() },
          ) {
            Icon(Icons.Default.PhotoCamera, contentDescription = null, modifier = Modifier.size(22.dp))
          }
          AttachmentMenuAction(nativeString("Gallery"), onClick = { if (admitAction()) onBrowseGallery() }) {
            Icon(Icons.Default.Photo, contentDescription = null, modifier = Modifier.size(22.dp))
          }
          AttachmentMenuAction(nativeString("Files"), onClick = { if (admitAction()) onPickFile() }) {
            Icon(Icons.Default.Description, contentDescription = null, modifier = Modifier.size(22.dp))
          }
          AttachmentMenuAction(nativeString("Location"), onClick = { if (admitAction()) page = AttachmentPage.Location }) {
            Icon(Icons.Default.LocationOn, contentDescription = null, modifier = Modifier.size(22.dp))
          }
          HorizontalDivider(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), color = ClawTheme.colors.border)
          AttachmentMenuAction(
            label = nativeString("Permissions"),
            description = if (permissionModePending) nativeString("Applying permissions…") else chatPermissionModeLabel(permissionMode),
            enabled = permissionsEnabled,
            onClick = { if (admitAction()) onOpenPermissions() },
          ) {
            ChatPermissionIcon(permissionMode, null, Modifier.size(22.dp))
          }
        }
      }
    }
  }
}

@Composable
private fun AttachmentMenuAction(
  label: String,
  onClick: () -> Unit,
  description: String? = null,
  enabled: Boolean = true,
  icon: @Composable () -> Unit,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier =
      Modifier.fillMaxWidth().semantics {
        contentDescription = label
        if (description != null) stateDescription = description
        role = Role.Button
      },
    shape = RoundedCornerShape(16.dp),
    color = Color.Transparent,
    contentColor = if (enabled) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
  ) {
    Row(
      Modifier.heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Box(
        Modifier.size(40.dp).background(ClawTheme.colors.text.copy(alpha = 0.06f), CircleShape),
        contentAlignment = Alignment.Center,
      ) { icon() }
      Column(Modifier.weight(1f)) {
        Text(label, style = ClawTheme.type.body)
        if (description != null) Text(description, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
      if (description != null) Icon(Icons.Default.ChevronRight, contentDescription = null, modifier = Modifier.size(20.dp))
    }
  }
}

@Composable
internal fun LocationAttachment(
  admit: () -> Boolean,
  onLocation: (String) -> Unit,
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val app = context.applicationContext as NodeApp
  val disclosure =
    remember(app) {
      LocationDisclosure(
        preciseEnabled = { app.prefs.locationPreciseEnabled.value },
        hasFinePermission = {
          ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        },
        capture = LocationCaptureManager(app)::getLocation,
      )
    }
  var busy by remember { mutableStateOf(false) }
  var failed by remember { mutableStateOf(false) }
  var permissionDenied by remember { mutableStateOf(false) }

  fun capture() {
    if (busy || !admit()) return
    busy = true
    failed = false
    permissionDenied = false
    scope.launch {
      try {
        val location =
          disclosure
            .getLocation(
              maxAgeMs = 60_000,
              timeoutMs = 15_000,
            ).location
        if (admit()) {
          onLocation(String.format(Locale.ROOT, "https://www.google.com/maps?q=%.6f,%.6f", location.latitude, location.longitude))
        }
      } catch (_: TimeoutCancellationException) {
        currentCoroutineContext().ensureActive()
        failed = true
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        failed = true
      } finally {
        busy = false
      }
    }
  }
  val permission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
      if (result.values.any { it }) capture() else permissionDenied = true
    }
  Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text(nativeString("Add your current location to the draft. Review it before sending."))
    if (failed) Text(nativeString("Could not get your location. Check device location settings and try again."), color = ClawTheme.colors.warning)
    if (permissionDenied) Text(nativeString("Location permission is required. Allow it in Android settings or try again."), color = ClawTheme.colors.warning)
    Button(
      enabled = !busy,
      onClick = {
        if (admit()) {
          if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            capture()
          } else {
            permission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
          }
        }
      },
    ) { Text(if (busy) nativeString("Getting location…") else nativeString("Use current location")) }
  }
}
