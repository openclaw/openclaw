package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.Context
import android.os.Looper
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor

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
    bound.addAll(useCases)
    check(!failBind) { "synthetic bind failure" }
    return ReflectionHelpers.createNullProxy(Camera::class.java)
  }

  @Implementation
  fun unbind(vararg useCases: UseCase) {
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
    @Suppress("UNUSED_PARAMETER") options: ImageCapture.OutputFileOptions,
    @Suppress("UNUSED_PARAMETER") executor: Executor,
    callback: ImageCapture.OnImageSavedCallback,
  ) {
    callbacks.add(callback)
  }

  companion object {
    val callbacks = ArrayDeque<ImageCapture.OnImageSavedCallback>()

    fun failNext() {
      callbacks.removeFirst().onError(ImageCaptureException(ImageCapture.ERROR_CAPTURE_FAILED, "synthetic capture failure", null))
    }
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
