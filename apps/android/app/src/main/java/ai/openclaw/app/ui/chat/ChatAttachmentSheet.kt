package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.node.LocationCaptureManager
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.foldAwareSheet
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.ext.SdkExtensions
import android.view.SurfaceView
import android.widget.photopicker.EmbeddedPhotoPickerClient
import android.widget.photopicker.EmbeddedPhotoPickerFeatureInfo
import android.widget.photopicker.EmbeddedPhotoPickerProviderFactory
import android.widget.photopicker.EmbeddedPhotoPickerSession
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresExtension
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.util.Locale

private enum class AttachmentTab { Gallery, File, Location }

/** One owner-bound opening; external results still pass through the composer's media leases. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatAttachmentSheet(
  opening: ChatModelPickerSession,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
  onSelectMedia: (List<Uri>) -> Boolean,
  onBrowseGallery: () -> Unit,
  onPickFile: () -> Unit,
  onPickVideo: () -> Unit,
  onLocation: (String) -> Unit,
) {
  var tab by remember { mutableStateOf(AttachmentTab.Gallery) }
  ModalBottomSheet(
    modifier = Modifier.foldAwareSheet(opening.geometry),
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
  ) {
    BackHandler { onDismiss() }
    Column(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
      Text(
        text =
          when (tab) {
            AttachmentTab.Gallery -> nativeString("Gallery")
            AttachmentTab.File -> nativeString("File")
            AttachmentTab.Location -> nativeString("Location")
          },
        style = ClawTheme.type.label,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
      )
      Box(Modifier.fillMaxWidth().weight(1f).heightIn(min = 96.dp)) {
        when (tab) {
          AttachmentTab.Gallery -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.UPSIDE_DOWN_CAKE) >= 15) {
              EmbeddedGallery(admit = admit, onSelect = onSelectMedia, onBrowse = onBrowseGallery)
            } else {
              AttachmentActions {
                Button(onClick = { if (admit()) onBrowseGallery() }) { Text(nativeString("Choose from gallery")) }
              }
            }
          }

          AttachmentTab.File -> {
            AttachmentActions {
              Button(onClick = { if (admit()) onPickFile() }) { Text(nativeString("Files")) }
              TextButton(onClick = { if (admit()) onPickVideo() }) { Text(nativeString("Videos")) }
            }
          }

          AttachmentTab.Location -> {
            LocationAttachment(admit = admit, onLocation = onLocation)
          }
        }
      }
      Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AttachmentTab.entries.forEach { item ->
          Surface(
            onClick = { if (admit()) tab = item },
            modifier =
              Modifier.weight(1f).semantics {
                selected = tab == item
                role = Role.Tab
              },
            shape = RoundedCornerShape(20.dp),
            color = if (tab == item) ClawTheme.colors.primary else Color.Transparent,
            contentColor = if (tab == item) ClawTheme.colors.primaryText else ClawTheme.colors.text,
          ) {
            Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
              Icon(
                when (item) {
                  AttachmentTab.Gallery -> Icons.Default.Photo
                  AttachmentTab.File -> Icons.Default.Description
                  AttachmentTab.Location -> Icons.Default.LocationOn
                },
                contentDescription = null,
                modifier = Modifier.size(24.dp),
              )
              Text(
                when (item) {
                  AttachmentTab.Gallery -> nativeString("Gallery")
                  AttachmentTab.File -> nativeString("File")
                  AttachmentTab.Location -> nativeString("Location")
                },
                style = ClawTheme.type.caption,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun AttachmentActions(content: @Composable () -> Unit) {
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) { content() }
}

@RequiresExtension(extension = Build.VERSION_CODES.UPSIDE_DOWN_CAKE, version = 15)
@Composable
private fun EmbeddedGallery(
  admit: () -> Boolean,
  onSelect: (List<Uri>) -> Boolean,
  onBrowse: () -> Unit,
) {
  var failed by remember { mutableStateOf(false) }
  val currentAdmit by rememberUpdatedState(admit)
  val currentSelect by rememberUpdatedState(onSelect)
  if (failed) {
    AttachmentActions {
      Text(nativeString("Gallery is unavailable. Open the system picker to choose media."))
      Button(onClick = { if (admit()) onBrowse() }) { Text(nativeString("Choose from gallery")) }
    }
  } else {
    val accent =
      ClawTheme.colors.primary
        .toArgb()
        .toLong()
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { context ->
        GalleryPickerView(
          context = context,
          accent = accent,
          onError = { failed = true },
          onComplete = { uris -> currentAdmit() && currentSelect(uris) },
        )
      },
    )
  }
}

/** The platform owns media access and rendering; detach fences late service callbacks. */
@RequiresExtension(extension = Build.VERSION_CODES.UPSIDE_DOWN_CAKE, version = 15)
@SuppressLint("ViewConstructor") // Constructed only by AndroidView with required callbacks, never inflated from XML.
private class GalleryPickerView(
  context: Context,
  private val accent: Long,
  private val onError: () -> Unit,
  private val onComplete: (List<Uri>) -> Boolean,
) : SurfaceView(context) {
  private var session: EmbeddedPhotoPickerSession? = null
  private var selection: EmbeddedGallerySelection? = null
  private var generation = 0
  private var opening = false

  init {
    setZOrderOnTop(true)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    openWhenReady()
  }

  override fun onSizeChanged(
    w: Int,
    h: Int,
    oldw: Int,
    oldh: Int,
  ) {
    super.onSizeChanged(w, h, oldw, oldh)
    session?.notifyResized(w, h)
    openWhenReady()
  }

  override fun onDetachedFromWindow() {
    generation += 1
    selection?.dispose()
    selection = null
    session = null
    opening = false
    super.onDetachedFromWindow()
  }

  @Suppress("DEPRECATION") // SurfaceView's host token is required by the embedded picker API.
  private fun openWhenReady() {
    if (!isAttachedToWindow || width <= 0 || height <= 0 || opening || session != null) return
    val token = hostToken ?: return
    val current = generation
    opening = true
    var openedSession: EmbeddedPhotoPickerSession? = null
    val permissions =
      EmbeddedGallerySelection(
        close = { openedSession?.close() },
      )
    selection = permissions
    val client =
      object : EmbeddedPhotoPickerClient {
        fun current() = generation == current && isAttachedToWindow

        override fun onSessionOpened(newSession: EmbeddedPhotoPickerSession) {
          if (!current()) {
            newSession.close()
            return
          }
          openedSession = newSession
          session = newSession
          setChildSurfacePackage(newSession.surfacePackage)
          newSession.notifyResized(width, height)
          newSession.notifyConfigurationChanged(resources.configuration)
          newSession.notifyPhotoPickerExpanded(true)
        }

        override fun onSessionError(error: Throwable) {
          if (current()) onError()
        }

        override fun onUriPermissionGranted(uris: List<Uri>) {
          permissions.granted(uris)
        }

        override fun onUriPermissionRevoked(uris: List<Uri>) {
          permissions.revoked(uris)
        }

        override fun onSelectionComplete() {
          if (current()) permissions.complete(onComplete)
        }
      }
    try {
      val features =
        EmbeddedPhotoPickerFeatureInfo
          .Builder()
          .setAccentColor(accent)
          .setMaxSelectionLimit(CHAT_COMPOSER_MAX_ATTACHMENTS)
          .build()
      EmbeddedPhotoPickerProviderFactory
        .create(context.applicationContext)
        .openSession(token, display.displayId, width, height, features, context.mainExecutor, client)
    } catch (_: Exception) {
      onError()
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
          LocationCaptureManager(context).getLocation(
            desiredProviders = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER),
            maxAgeMs = 60_000,
            timeoutMs = 15_000,
          )
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
  AttachmentActions {
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
