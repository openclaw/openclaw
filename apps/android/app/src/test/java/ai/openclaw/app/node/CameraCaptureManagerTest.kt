package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Looper
import android.util.Base64
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.PendingRecording
import androidx.camera.video.Recording
import androidx.camera.video.VideoRecordEvent
import androidx.core.util.Consumer
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNativeBitmap
import org.robolectric.util.ReflectionHelpers
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/** CameraX is the hardware boundary; the manager and gateway handler remain real. */
@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  application = Application::class,
  instrumentedPackages = ["androidx.camera"],
  shadows = [CaptureProvider::class, CaptureProviderFactory::class, HeldImageCapture::class, HeldPendingRecording::class, HeldRecording::class],
)
@OptIn(ExperimentalCoroutinesApi::class)
class CameraCaptureManagerTest {
  @Before
  fun setUp() {
    CaptureProvider.bound.clear()
    CaptureProvider.failBind = false
    HeldImageCapture.callbacks.clear()
    HeldImageCapture.outputFiles.clear()
    HeldPixelBitmap.hold = null
    HeldPendingRecording.started = 0
    HeldPendingRecording.listener = null
    HeldRecording.closed = 0
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.CAMERA)
  }

  @After
  fun tearDown() {
    Dispatchers.resetMain()
  }

  @Test
  fun clipRejectsSnapWithoutDetachingTheRecording() = verifyClipOverlap(snap = true)

  @Test
  fun clipRejectsSilentClipWithoutDetachingTheRecording() = verifyClipOverlap(snap = false)

  private fun verifyClipOverlap(snap: Boolean) =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val handler = handler()
      val clip = async { handler.handleClip(SILENT_CLIP) }
      drainCaptureTasks()
      assertEquals(2, CaptureProvider.bound.size)
      advanceTimeBy(1_500)
      drainCaptureTasks()
      assertEquals(1, HeldPendingRecording.started)

      try {
        // Check both the recording interval and the wait for CameraX finalization.
        for (finalizing in listOf(false, true)) {
          if (finalizing) {
            advanceTimeBy(10_000)
            drainCaptureTasks()
          }
          val overlap = async { if (snap) handler.handleSnap(null) else handler.handleClip(SILENT_CLIP) }
          try {
            drainCaptureTasks()
            assertTrue("overlapping capture must return immediately", overlap.isCompleted)
            val result = overlap.await()
            assertEquals("CAMERA_BUSY", result.error?.code)
            assertEquals(2, CaptureProvider.bound.size)
            assertEquals(if (finalizing) 1 else 0, HeldRecording.closed)
            assertFalse(clip.isCompleted)
          } finally {
            overlap.cancelAndJoin()
          }
        }
      } finally {
        clip.cancelAndJoin()
      }
      assertTrue(CaptureProvider.bound.isEmpty())
      assertTrue(HeldRecording.closed > 0)
      assertNextSnapReachesCamera(handler)
    }

  @Test
  fun snapRejectsAnotherSnapAndReleasesOwnershipOnCaptureFailure() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val handler = handler()
      val first = async { handler.handleSnap(null) }
      drainCaptureTasks()
      assertEquals(1, CaptureProvider.bound.size)
      val second = async { handler.handleSnap(null) }
      try {
        drainCaptureTasks()
        assertTrue("second snapshot must return immediately", second.isCompleted)
        assertEquals("CAMERA_BUSY", second.await().error?.code)
        assertFalse(first.isCompleted)
        assertEquals(1, CaptureProvider.bound.size)
        HeldImageCapture.failNext()
        drainCaptureTasks()
        assertEquals("UNAVAILABLE", first.await().error?.code)
      } finally {
        first.cancelAndJoin()
        second.cancelAndJoin()
      }
      assertTrue(CaptureProvider.bound.isEmpty())
      assertNextSnapReachesCamera(handler)
    }

  @Test
  fun cancellationDuringClipWarmupReleasesOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val handler = handler()
      val clip = async { handler.handleClip(SILENT_CLIP) }
      drainCaptureTasks()
      assertEquals(2, CaptureProvider.bound.size)
      clip.cancelAndJoin()
      assertTrue(CaptureProvider.bound.isEmpty())
      assertEquals(0, HeldPendingRecording.started)
      assertNextSnapReachesCamera(handler)
    }

  @Test
  fun cancelledSnapshotReleasesOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val handler = handler()
      val snap = async { handler.handleSnap(null) }
      drainCaptureTasks()
      assertEquals(1, CaptureProvider.bound.size)
      snap.cancelAndJoin()
      // CameraX may deliver the cancelled capture callback after unbinding.
      HeldImageCapture.failNext()
      assertTrue(CaptureProvider.bound.isEmpty())
      assertNextSnapReachesCamera(handler)
    }

  @Test
  fun clipFinalizeFailureReleasesOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val handler = handler()
      val clip = async { handler.handleClip(SILENT_CLIP) }
      drainCaptureTasks()
      advanceTimeBy(1_500)
      drainCaptureTasks()
      assertEquals(1, HeldPendingRecording.started)
      advanceTimeBy(10_000)
      drainCaptureTasks()
      val event = Shadow.newInstanceOf(VideoRecordEvent.Finalize::class.java)
      ReflectionHelpers.setField(event, "mError", VideoRecordEvent.Finalize.ERROR_ENCODING_FAILED)
      checkNotNull(HeldPendingRecording.listener).accept(event)
      drainCaptureTasks()
      assertEquals("UNAVAILABLE", clip.await().error?.code)
      assertTrue(CaptureProvider.bound.isEmpty())
      assertNextSnapReachesCamera(handler)
    }

  @Test
  fun bindFailureUnbindsOnlyItsOwnUseCasesAndReleasesOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val unrelated = ImageCapture.Builder().build()
      CaptureProvider.bound.add(unrelated)
      CaptureProvider.failBind = true
      val handler = handler()
      val failed = async { handler.handleSnap(null) }
      drainCaptureTasks()
      assertTrue("bind failure must return", failed.isCompleted)
      assertEquals("UNAVAILABLE", failed.await().error?.code)
      assertEquals(setOf(unrelated), CaptureProvider.bound)
      CaptureProvider.failBind = false
      assertNextSnapReachesCamera(handler)
      assertEquals(setOf(unrelated), CaptureProvider.bound)
    }

  @Test
  fun activityStopSettlesSnapshotWithoutCancellingCallerAndAllowsRecovery() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val owner = Owner()
      val handler = handler(owner)
      val filesBefore = cameraTemporaryFiles()
      val snap = async { handler.handleSnap(null) }
      try {
        drainCaptureTasks()
        assertEquals(1, CaptureProvider.bound.size)
        assertEquals("capture owns one temporary file", 1, (cameraTemporaryFiles() - filesBefore).size)
        owner.registry.currentState = Lifecycle.State.CREATED
        drainCaptureTasks()
        assertTrue("Activity stop must settle the suspended snapshot", snap.isCompleted)
        assertFalse("Activity stop must not cancel the caller", snap.isCancelled)
        assertEquals("NODE_BACKGROUND_UNAVAILABLE", snap.await().error?.code)
        assertTrue(CaptureProvider.bound.isEmpty())
        assertEquals("Activity stop deletes the capture file", filesBefore, cameraTemporaryFiles())
        // Deliver CameraX's late callback for the retired capture before retrying.
        HeldImageCapture.failNext()
        owner.registry.currentState = Lifecycle.State.RESUMED
        assertNextSnapReachesCamera(handler)
      } finally {
        snap.cancelAndJoin()
      }
    }

  @Test
  fun activityStopSettlesRecordingAndAllowsTheNextCapture() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val owner = Owner()
      val handler = handler(owner)
      val filesBefore = cameraTemporaryFiles()
      val clip = async { handler.handleClip(SILENT_CLIP) }
      try {
        drainCaptureTasks()
        advanceTimeBy(1_500)
        drainCaptureTasks()
        assertEquals(1, HeldPendingRecording.started)
        assertEquals("capture owns one temporary file", 1, (cameraTemporaryFiles() - filesBefore).size)
        owner.registry.currentState = Lifecycle.State.CREATED
        drainCaptureTasks()
        assertTrue("Activity stop must settle the recording", clip.isCompleted)
        assertFalse("Activity stop must not cancel the caller", clip.isCancelled)
        assertEquals("NODE_BACKGROUND_UNAVAILABLE", clip.await().error?.code)
        assertTrue(CaptureProvider.bound.isEmpty())
        assertEquals("Activity stop deletes the capture file", filesBefore, cameraTemporaryFiles())
        assertTrue(HeldRecording.closed > 0)
        owner.registry.currentState = Lifecycle.State.RESUMED
        assertNextSnapReachesCamera(handler)
      } finally {
        clip.cancelAndJoin()
      }
    }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  @Config(shadows = [HeldPixelBitmap::class])
  fun snapshotPixelsRunOffMainWithoutChangingOrientationSizeOrCaptureOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val jpeg = twoColorJpeg()
      val handler = handler()
      for (orientation in listOf(ExifInterface.ORIENTATION_NORMAL, ExifInterface.ORIENTATION_ROTATE_90)) {
        val hold = PixelHold()
        HeldPixelBitmap.hold = hold
        val snap = async { handler.handleSnap(SMALL_SNAP) }
        try {
          drainCaptureTasks()
          HeldImageCapture.completeNext(jpeg, orientation)
          drainCaptureTasks()
          hold.awaitEntry()
          assertTrue("CameraX must be detached before pixel work", CaptureProvider.bound.isEmpty())
          assertFalse("pixel processing must not occupy Main", hold.onMain)

          var mainResponded = false
          val heartbeat = launch(Dispatchers.Main) { mainResponded = true }
          drainCaptureTasks()
          heartbeat.join()
          assertTrue("Main must respond while JPEG encoding is held", mainResponded)
          for (clip in listOf(false, true)) {
            val overlap = async { if (clip) handler.handleClip(SILENT_CLIP) else handler.handleSnap(null) }
            drainCaptureTasks()
            assertTrue("pixel processing still owns the capture lease", overlap.isCompleted)
            assertEquals("CAMERA_BUSY", overlap.await().error?.code)
            assertTrue(CaptureProvider.bound.isEmpty())
          }
          assertFalse(snap.isCompleted)
          hold.release.countDown()
          val result = snap.await()
          assertTrue(result.error?.message, result.ok)
          assertEquals(90, hold.quality)
          assertTrue("the worker must dispose its bitmap before returning", checkNotNull(hold.bitmap).isRecycled)
          assertSmallPhoto(checkNotNull(result.payloadJson), orientation)
        } finally {
          hold.release.countDown()
          snap.cancelAndJoin()
          HeldPixelBitmap.hold = null
        }
      }
      assertNextSnapReachesCamera(handler)
    }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  @Config(shadows = [HeldPixelBitmap::class])
  fun revokedSnapshotCannotPublishOrReleaseItsLeaseBeforePixelCleanup() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication()
      val jpeg = twoColorJpeg()
      for (revocation in listOf("caller", "activity", "foreground", "enabled", "permission", "owner")) {
        val owner = Owner()
        var foreground = true
        var enabled = true
        val camera =
          CameraCaptureManager(
            app,
            isForeground = {
              assertEquals(Looper.getMainLooper(), Looper.myLooper())
              foreground
            },
            cameraEnabled = {
              assertEquals(Looper.getMainLooper(), Looper.myLooper())
              enabled
            },
          ).also { it.attachLifecycleOwner(owner) }
        val captureHandler = CameraHandler(app, camera, { error("silent capture") }, ::invokeErrorFromThrowable)
        val hold = PixelHold()
        HeldPixelBitmap.hold = hold
        val snap = async { captureHandler.handleSnap(SMALL_SNAP) }
        try {
          drainCaptureTasks()
          HeldImageCapture.completeNext(jpeg, ExifInterface.ORIENTATION_NORMAL)
          drainCaptureTasks()
          hold.awaitEntry()
          assertFalse("pixel processing must not occupy Main", hold.onMain)
          when (revocation) {
            "caller" -> snap.cancel()
            "activity" -> owner.registry.currentState = Lifecycle.State.CREATED
            "foreground" -> foreground = false
            "enabled" -> enabled = false
            "permission" -> shadowOf(app).denyPermissions(Manifest.permission.CAMERA)
            "owner" -> camera.attachLifecycleOwner(Owner())
          }
          drainCaptureTasks()
          assertFalse("$revocation must wait for the worker to join", snap.isCompleted)
          // A fresh runtime must still observe the process-wide lease before checking access.
          val other = handler()
          val overlap = async { other.handleSnap(null) }
          drainCaptureTasks()
          assertTrue(overlap.isCompleted)
          assertEquals("CAMERA_BUSY", overlap.await().error?.code)
          assertTrue(CaptureProvider.bound.isEmpty())

          hold.release.countDown()
          if (revocation == "caller") {
            snap.join()
            assertTrue(snap.isCancelled)
          } else {
            val result = snap.await()
            val expected =
              when (revocation) {
                "activity", "foreground" -> "NODE_BACKGROUND_UNAVAILABLE"
                "enabled" -> "CAMERA_DISABLED"
                "permission" -> "CAMERA_PERMISSION_REQUIRED"
                else -> "UNAVAILABLE"
              }
            assertEquals(revocation, expected, result.error?.code)
            assertNull("revoked access must not publish encoded pixels", result.payloadJson)
          }
          assertTrue("$revocation must dispose the worker bitmap", checkNotNull(hold.bitmap).isRecycled)
        } finally {
          hold.release.countDown()
          snap.cancelAndJoin()
          HeldPixelBitmap.hold = null
          shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        }
        assertNextSnapReachesCamera(handler())
      }
    }

  private fun twoColorJpeg(): ByteArray {
    val bitmap = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888)
    try {
      bitmap.setPixels(IntArray(64 * 32) { if (it % 64 < 32) Color.RED else Color.BLUE }, 0, 64, 0, 0, 64, 32)
      return ByteArrayOutputStream().use { output ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, output))
        output.toByteArray()
      }
    } finally {
      bitmap.recycle()
    }
  }

  private fun assertSmallPhoto(
    payload: String,
    orientation: Int,
  ) {
    val photo = Json.parseToJsonElement(payload).jsonObject
    val rotated = orientation == ExifInterface.ORIENTATION_ROTATE_90
    val height = if (rotated) 32 else 8
    assertEquals("jpg", photo.getValue("format").jsonPrimitive.content)
    assertEquals(16, photo.getValue("width").jsonPrimitive.int)
    assertEquals(height, photo.getValue("height").jsonPrimitive.int)
    val base64 = photo.getValue("base64").jsonPrimitive.content
    assertFalse(base64.contains('\n'))
    val bytes = Base64.decode(base64, Base64.NO_WRAP)
    assertTrue(bytes.size < (5 * 1024 * 1024 / 4) * 3)
    assertEquals(0xff, bytes[0].toInt() and 0xff)
    assertEquals(0xd8, bytes[1].toInt() and 0xff)
    val bitmap = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    try {
      assertEquals(16, bitmap.width)
      assertEquals(height, bitmap.height)
      val red = bitmap.getPixel(if (rotated) 8 else 2, 4)
      val blue = bitmap.getPixel(if (rotated) 8 else 13, if (rotated) 27 else 4)
      assertTrue("red half must survive EXIF orientation and scaling", Color.red(red) > 220 && Color.blue(red) < 35)
      assertTrue("blue half must survive EXIF orientation and scaling", Color.blue(blue) > 220 && Color.red(blue) < 35)
    } finally {
      bitmap.recycle()
    }
  }

  private suspend fun kotlinx.coroutines.test.TestScope.assertNextSnapReachesCamera(handler: CameraHandler) {
    val next = async { handler.handleSnap(null) }
    try {
      drainCaptureTasks()
      assertFalse("ownership must be released for the next capture", next.isCompleted)
      assertTrue(CaptureProvider.bound.any { it is ImageCapture })
      HeldImageCapture.failNext()
      drainCaptureTasks()
      assertEquals("UNAVAILABLE", next.await().error?.code)
    } finally {
      next.cancelAndJoin()
    }
  }

  private fun kotlinx.coroutines.test.TestScope.drainCaptureTasks() {
    runCurrent()
    shadowOf(Looper.getMainLooper()).idle()
    runCurrent()
  }

  private fun cameraTemporaryFiles() =
    RuntimeEnvironment
      .getApplication()
      .cacheDir
      .listFiles()
      .orEmpty()
      .filter { it.name.startsWith("openclaw-snap-") || it.name.startsWith("openclaw-clip-") }
      .toSet()

  private class Owner : LifecycleOwner {
    val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    init {
      registry.currentState = Lifecycle.State.RESUMED
    }
  }

  private fun handler(owner: Owner = Owner()): CameraHandler {
    val app = RuntimeEnvironment.getApplication()
    val camera = CameraCaptureManager(app).also { it.attachLifecycleOwner(owner) }
    return CameraHandler(app, camera, { error("silent capture must not acquire the microphone") }, ::invokeErrorFromThrowable)
  }

  companion object {
    private const val SILENT_CLIP = """{"includeAudio":false,"durationMs":10000}"""
    private const val SMALL_SNAP = """{"maxWidth":16,"quality":0.9}"""
  }
}

@Implements(value = ProcessCameraProvider::class, isInAndroidSdk = false)
class CaptureProvider {
  @Implementation
  fun bindToLifecycle(
    @Suppress("UNUSED_PARAMETER") owner: LifecycleOwner,
    @Suppress("UNUSED_PARAMETER") selector: CameraSelector,
    vararg useCases: UseCase,
  ): Camera {
    check(Looper.myLooper() == Looper.getMainLooper()) { "CameraX binding must stay on Main" }
    bound.addAll(useCases)
    check(!failBind) { "synthetic bind failure" }
    return ReflectionHelpers.createNullProxy(Camera::class.java)
  }

  @Implementation
  fun unbind(vararg useCases: UseCase) {
    check(Looper.myLooper() == Looper.getMainLooper()) { "CameraX unbinding must stay on Main" }
    bound.removeAll(useCases.toSet())
  }

  @Implementation
  fun unbindAll() {
    bound.clear()
  }

  companion object {
    val bound = mutableSetOf<UseCase>()
    var failBind = false
  }
}

@Implements(className = "androidx.camera.lifecycle.ProcessCameraProvider\$Companion", isInAndroidSdk = false)
class CaptureProviderFactory {
  @Implementation
  fun getInstance(
    @Suppress("UNUSED_PARAMETER") context: Context,
  ): ListenableFuture<ProcessCameraProvider> =
    object : CompletableFuture<ProcessCameraProvider>(), ListenableFuture<ProcessCameraProvider> {
      init {
        complete(Shadow.newInstanceOf(ProcessCameraProvider::class.java))
      }

      override fun addListener(
        listener: Runnable,
        executor: Executor,
      ) {
        executor.execute(listener)
      }
    }
}

@Implements(value = ImageCapture::class, isInAndroidSdk = false)
class HeldImageCapture {
  @Implementation
  fun takePicture(
    options: ImageCapture.OutputFileOptions,
    @Suppress("UNUSED_PARAMETER") executor: Executor,
    callback: ImageCapture.OnImageSavedCallback,
  ) {
    callbacks.add(callback)
    outputFiles.add(ReflectionHelpers.callInstanceMethod(options, "getFile"))
  }

  companion object {
    val callbacks = ArrayDeque<ImageCapture.OnImageSavedCallback>()
    val outputFiles = ArrayDeque<File>()

    fun failNext() {
      outputFiles.removeFirst()
      callbacks.removeFirst().onError(ImageCaptureException(ImageCapture.ERROR_CAPTURE_FAILED, "synthetic capture failure", null))
    }

    fun completeNext(
      bytes: ByteArray,
      orientation: Int,
    ) {
      val file = outputFiles.removeFirst()
      file.writeBytes(bytes)
      ExifInterface(file.absolutePath).apply {
        setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
        saveAttributes()
      }
      callbacks.removeFirst().onImageSaved(Shadow.newInstanceOf(ImageCapture.OutputFileResults::class.java))
    }
  }
}

/** Hold a real native compressor, rather than replacing the manager's pixel algorithm. */
@Implements(value = Bitmap::class, isInAndroidSdk = false, callNativeMethodsByDefault = true)
class HeldPixelBitmap : ShadowNativeBitmap() {
  @Implementation
  fun compress(
    format: Bitmap.CompressFormat,
    quality: Int,
    stream: OutputStream,
  ): Boolean {
    hold?.let { gate ->
      gate.bitmap = realBitmap
      gate.quality = quality
      gate.onMain = Looper.myLooper() == Looper.getMainLooper()
      gate.entered.countDown()
      // Baseline Main-thread work must fail the dispatch assertion, not deadlock the test.
      if (!gate.onMain) check(gate.release.await(10, TimeUnit.SECONDS)) { "pixel fixture release timed out" }
    }
    return Shadow.directlyOn(
      realBitmap,
      Bitmap::class.java,
      "compress",
      ReflectionHelpers.ClassParameter.from(Bitmap.CompressFormat::class.java, format),
      ReflectionHelpers.ClassParameter.from(Integer.TYPE, quality),
      ReflectionHelpers.ClassParameter.from(OutputStream::class.java, stream),
    )
  }

  companion object {
    @Volatile var hold: PixelHold? = null
  }
}

class PixelHold {
  val entered = CountDownLatch(1)
  val release = CountDownLatch(1)
  var bitmap: Bitmap? = null
  var quality = 0
  var onMain = true

  fun awaitEntry() {
    assertTrue("JPEG compressor must be reached", entered.await(10, TimeUnit.SECONDS))
  }
}

@Implements(value = PendingRecording::class, isInAndroidSdk = false)
class HeldPendingRecording {
  @Implementation
  fun start(
    @Suppress("UNUSED_PARAMETER") executor: Executor,
    listener: Consumer<VideoRecordEvent>,
  ): Recording {
    started++
    Companion.listener = listener
    return Shadow.newInstanceOf(Recording::class.java)
  }

  companion object {
    var started = 0
    var listener: Consumer<VideoRecordEvent>? = null
  }
}

@Implements(value = Recording::class, isInAndroidSdk = false)
class HeldRecording {
  @Implementation
  fun close() {
    closed++
  }

  @Implementation
  fun finalize() = Unit

  companion object {
    var closed = 0
  }
}
