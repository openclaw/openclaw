package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.AppAlertDialog
import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import java.io.File
import java.util.UUID

@Composable
internal fun rememberChatCameraCapture(
  viewModel: MainViewModel,
  owner: ChatComposerOwner,
  mainSessionKey: String,
): () -> Unit {
  val context = LocalContext.current
  val app = context.applicationContext
  val currentOwner by rememberUpdatedState(owner)
  val currentMainSessionKey by rememberUpdatedState(mainSessionKey)
  val composer = viewModel.chatComposerState
  val checkpoint = rememberSaveable(saver = ChatComposerMediaCheckpoint.Saver) { ChatComposerMediaCheckpoint() }
  var captureId by rememberSaveable { mutableStateOf<String?>(null) }
  var failure by remember { mutableStateOf<String?>(null) }
  val directory = remember(app) { File(app.cacheDir, "chat-camera") }

  fun cancelCapture() {
    captureId?.let { File(directory, it).deleteRecursively() }
    captureId = null
    checkpoint.clear()?.let { composer.cancelMediaAcquisition(it.authorizationId) }
  }

  val camera =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val captureDirectory = captureId?.let { File(directory, it) }
      captureId = null
      val lease = checkpoint.consume()
      val uri = result.data?.data
      val file = uri?.lastPathSegment?.let { name -> captureDirectory?.let { File(it, name) } }
      val validResult =
        result.resultCode == Activity.RESULT_OK &&
          file != null && file.isFile && file.length() > 0 &&
          file.parentFile == captureDirectory &&
          FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file) == uri
      if (!validResult || lease == null) {
        captureDirectory?.deleteRecursively()
        lease?.let { composer.cancelMediaAcquisition(it.authorizationId) }
        if (result.resultCode == Activity.RESULT_OK) failure = nativeString("Could not stage an attachment for sending.")
      } else {
        val importOwner =
          if (shouldMigrateComposerDraft(lease.owner, currentOwner, currentMainSessionKey)) currentOwner else lease.owner
        val importJob =
          viewModel.importChatComposerAttachments(importOwner, lease.authorizationId, currentMainSessionKey, expectedCount = 1) {
            listOf(loadPickedMediaOrDocumentAttachment(app.contentResolver, checkNotNull(uri)))
          }
        // The originating composer owns admission; the camera never sends or changes the target chat.
        if (importJob == null) captureDirectory.deleteRecursively() else importJob.invokeOnCompletion { captureDirectory.deleteRecursively() }
      }
    }

  fun launchCapture() {
    val lease = checkpoint.consume() ?: return
    if (!viewModel.isCurrentChatComposerOwner(lease.owner) || !composer.isMediaAcquisitionActive(lease.authorizationId)) {
      composer.cancelMediaAcquisition(lease.authorizationId)
      return
    }
    checkpoint.begin(lease.owner, lease.authorizationId)
    try {
      val id = UUID.randomUUID().toString()
      captureId = id
      check(File(directory, id).mkdirs())
      camera.launch(Intent(context, ChatCameraActivity::class.java).putExtra(ChatCameraActivity.EXTRA_CAPTURE_ID, id))
    } catch (_: Exception) {
      cancelCapture()
      failure = nativeString("Could not start the camera.")
    }
  }

  val permission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) {
        launchCapture()
      } else {
        cancelCapture()
        failure = nativeString("Permission required")
      }
    }

  failure?.let { message ->
    AppAlertDialog(
      onDismissRequest = { failure = null },
      title = { Text(nativeString("Camera")) },
      text = { Text(message) },
      confirmButton = {
        TextButton(onClick = {
          failure = null
          context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${app.packageName}".toUri()))
        }) { Text(nativeString("Open settings")) }
      },
      dismissButton = { TextButton(onClick = { failure = null }) { Text(nativeString("Cancel")) } },
    )
  }

  return capture@{
    if (checkpoint.owner != null || !viewModel.isCurrentChatComposerOwner(currentOwner)) return@capture
    val authorizationId = composer.beginMediaAcquisition(currentOwner) ?: return@capture
    checkpoint.begin(currentOwner, authorizationId)
    failure = null
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      launchCapture()
    } else {
      try {
        permission.launch(Manifest.permission.CAMERA)
      } catch (_: Exception) {
        cancelCapture()
        failure = nativeString("Could not start the camera.")
      }
    }
  }
}
