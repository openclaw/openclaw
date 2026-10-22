package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.OUTBOX_MAX_VIDEO_COMMAND_ATTACHMENT_BYTES
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.ui.OpenClawTheme
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Surface
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlipCameraAndroid
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import java.io.File
import java.util.UUID

/** A single user-owned capture; the originating composer owns admission and directory cleanup. */
class ChatCameraActivity : ComponentActivity() {
  companion object {
    const val EXTRA_CAPTURE_ID = "captureId"
  }

  private enum class Mode { Photo, Video }

  private lateinit var directory: File
  private val preview = Preview.Builder().build()
  private val imageCapture = ImageCapture.Builder().build()
  private val videoCapture =
    VideoCapture.withOutput(
      Recorder
        .Builder()
        .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.HD)))
        .build(),
    )
  private var provider: ProcessCameraProvider? = null
  private var cameraLease: AutoCloseable? = null
  private var recording by mutableStateOf<Recording?>(null)
  private var retired = false
  private var capturePending = false
  private var mode by mutableStateOf(Mode.Photo)
  private var frontFacing by mutableStateOf(false)
  private var canSwitchCamera by mutableStateOf(false)
  private var ready by mutableStateOf(false)
  private var busy by mutableStateOf(false)
  private var stoppingVideo by mutableStateOf(false)
  private var error by mutableStateOf<String?>(null)

  private val audioPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      busy = false
      if (!isCurrent()) return@registerForActivityResult
      if (granted) startVideo() else error = nativeString("Microphone permission is required.")
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setResult(RESULT_CANCELED)
    val captureId = intent.getStringExtra(EXTRA_CAPTURE_ID)
    val validId = captureId != null && runCatching { UUID.fromString(captureId).toString() == captureId }.getOrDefault(false)
    val root = File(cacheDir, "chat-camera")
    val requestedDirectory = captureId?.let { File(root, it) }
    if (
      savedInstanceState != null || !validId || requestedDirectory == null || !requestedDirectory.isDirectory ||
      requestedDirectory.canonicalFile.parentFile != root.canonicalFile
    ) {
      retired = true
      finish()
      return
    }
    directory = requestedDirectory
    WindowCompat.setDecorFitsSystemWindows(window, false)
    setContent {
      OpenClawTheme {
        ClawDesignTheme {
          CameraScreen()
        }
      }
    }
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener(
      {
        if (!retired) {
          try {
            provider = future.get()
            bindCamera()
          } catch (_: Exception) {
            error = nativeString("Could not start the camera.")
          }
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

  override fun onStart() {
    super.onStart()
    bindCamera()
  }

  override fun onStop() {
    cancelCapture()
    super.onStop()
  }

  override fun onDestroy() {
    retire()
    super.onDestroy()
  }

  private fun isCurrent(): Boolean = !retired && !isFinishing && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  private fun bindCamera() {
    val cameraProvider = provider ?: return
    if (!isCurrent() || busy) return
    ready = false
    error = null
    if (cameraLease == null) cameraLease = CameraCaptureManager.tryAcquireCamera()
    if (cameraLease == null) {
      error = nativeString("Camera is busy. Close other camera capture and try again.")
      return
    }
    try {
      var selector = if (frontFacing) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
      if (!cameraProvider.hasCamera(selector)) {
        selector = if (frontFacing) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
        check(cameraProvider.hasCamera(selector))
        frontFacing = !frontFacing
      }
      canSwitchCamera = cameraProvider.hasCamera(if (frontFacing) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA)
      cameraProvider.unbind(preview, imageCapture, videoCapture)
      val rotation = display?.rotation ?: Surface.ROTATION_0
      preview.targetRotation = rotation
      imageCapture.targetRotation = rotation
      videoCapture.targetRotation = rotation
      cameraProvider.bindToLifecycle(this, selector, preview, if (mode == Mode.Photo) imageCapture else videoCapture)
      ready = true
    } catch (_: Exception) {
      cameraProvider.unbind(preview, imageCapture, videoCapture)
      releaseCamera()
      canSwitchCamera = false
      error = nativeString("Could not start the camera.")
    }
  }

  private fun takePhoto() {
    if (!isCurrent() || !ready || busy) return
    val file = createOutput("photo-", ".jpg") ?: return
    busy = true
    capturePending = true
    error = null
    try {
      imageCapture.targetRotation = display?.rotation ?: Surface.ROTATION_0
      imageCapture.takePicture(
        ImageCapture.OutputFileOptions.Builder(file).build(),
        ContextCompat.getMainExecutor(this),
        object : ImageCapture.OnImageSavedCallback {
          override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
            completeCapture(file, success = true)
          }

          override fun onError(exception: ImageCaptureException) {
            completeCapture(file, success = false)
          }
        },
      )
    } catch (_: Exception) {
      completeCapture(file, success = false)
    }
  }

  private fun requestVideo() {
    if (!isCurrent() || !ready || busy) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      startVideo()
    } else {
      busy = true
      try {
        audioPermission.launch(Manifest.permission.RECORD_AUDIO)
      } catch (_: Exception) {
        busy = false
        error = nativeString("Microphone permission is required.")
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun startVideo() {
    if (!isCurrent() || !ready || busy || mode != Mode.Video) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      error = nativeString("Microphone permission is required.")
      return
    }
    val file = createOutput("video-", ".mp4") ?: return
    busy = true
    capturePending = true
    stoppingVideo = false
    error = null
    try {
      videoCapture.targetRotation = display?.rotation ?: Surface.ROTATION_0
      val output = FileOutputOptions.Builder(file).setFileSizeLimit(OUTBOX_MAX_VIDEO_COMMAND_ATTACHMENT_BYTES).build()
      recording =
        videoCapture.output
          .prepareRecording(this, output)
          .withAudioEnabled()
          .start(ContextCompat.getMainExecutor(this)) { event ->
            if (event is VideoRecordEvent.Finalize) {
              recording = null
              stoppingVideo = false
              val usable = !event.hasError() || event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
              completeCapture(file, usable && file.length() <= OUTBOX_MAX_VIDEO_COMMAND_ATTACHMENT_BYTES)
            }
          }
    } catch (_: Exception) {
      recording = null
      completeCapture(file, success = false)
    }
  }

  private fun createOutput(
    prefix: String,
    suffix: String,
  ): File? =
    try {
      File.createTempFile(prefix, suffix, directory)
    } catch (_: Exception) {
      error = nativeString("Could not capture media. Try again.")
      null
    }

  private fun completeCapture(
    file: File,
    success: Boolean,
  ) {
    capturePending = false
    busy = false
    if (!isCurrent() || !success || file.length() == 0L) {
      file.delete()
      if (retired) releaseCamera() else error = nativeString("Could not capture media. Try again.")
      return
    }
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    setResult(RESULT_OK, Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    retire()
    finish()
  }

  private fun cancelCapture() {
    if (retired) return
    retire()
    finish()
  }

  private fun retire() {
    if (retired) return
    retired = true
    ready = false
    recording?.stop()
    provider?.unbind(preview, imageCapture, videoCapture)
    // Capture callbacks own their files until CameraX finishes writing, even after Activity stop.
    if (!capturePending) releaseCamera()
  }

  private fun releaseCamera() {
    cameraLease?.close()
    cameraLease = null
  }

  @Composable
  private fun CameraScreen() {
    BackHandler(onBack = ::cancelCapture)
    Column(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding()) {
      Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        IconButton(onClick = ::cancelCapture) {
          Icon(Icons.Default.Close, nativeString("Close"), tint = Color.White)
        }
        Text(nativeString("Camera"), color = Color.White, style = ClawTheme.type.title)
        IconButton(
          enabled = canSwitchCamera && !busy,
          onClick = {
            frontFacing = !frontFacing
            bindCamera()
          },
        ) {
          Icon(Icons.Default.FlipCameraAndroid, nativeString("Switch camera"), tint = Color.White)
        }
      }
      Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
        AndroidView(
          factory = { context ->
            PreviewView(context).apply {
              implementationMode = PreviewView.ImplementationMode.COMPATIBLE
              preview.setSurfaceProvider(surfaceProvider)
            }
          },
          modifier = Modifier.fillMaxSize(),
        )
        if (!ready && error == null) Text(nativeString("Starting camera…"), color = Color.White)
      }
      Column(
        Modifier.fillMaxWidth().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        error?.let { message ->
          Text(message, color = ClawTheme.colors.warning)
          if (!ready && provider != null) TextButton(onClick = ::bindCamera) { Text(nativeString("Try again")) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
          for (option in Mode.entries) {
            FilterChip(
              selected = mode == option,
              enabled = !busy,
              onClick = {
                mode = option
                bindCamera()
              },
              label = { Text(if (option == Mode.Photo) nativeString("Photo") else nativeString("Video")) },
            )
          }
        }
        IconButton(
          modifier = Modifier.size(72.dp).background(if (mode == Mode.Video) ClawTheme.colors.accent else Color.White, CircleShape),
          enabled = ready && (!busy || (recording != null && !stoppingVideo)),
          onClick = {
            if (recording != null) {
              stoppingVideo = true
              recording?.stop()
            } else if (mode == Mode.Photo) {
              takePhoto()
            } else {
              requestVideo()
            }
          },
        ) {
          val (icon, label) =
            when {
              recording != null -> Icons.Default.Stop to nativeString("Stop recording")
              mode == Mode.Photo -> Icons.Default.PhotoCamera to nativeString("Take photo")
              else -> Icons.Default.Videocam to nativeString("Record video")
            }
          Icon(icon, label, modifier = Modifier.size(32.dp), tint = if (mode == Mode.Photo) Color.Black else Color.White)
        }
      }
    }
  }
}
