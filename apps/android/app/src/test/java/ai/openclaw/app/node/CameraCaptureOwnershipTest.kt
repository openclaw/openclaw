package ai.openclaw.app.node

import android.Manifest
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
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

/** Shared capture admission/cleanup only; does not claim a physical camera or CameraX bind. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class CameraCaptureOwnershipTest {
  private class Owner : LifecycleOwner {
    val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    init {
      registry.currentState = Lifecycle.State.RESUMED
    }
  }

  @Before
  fun setUp() {
    Dispatchers.setMain(Dispatchers.Unconfined)
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.CAMERA)
  }

  @After
  fun tearDown() {
    Dispatchers.resetMain()
  }

  @Test
  fun snapAndClipFailFastAgainstTheSameProcessCaptureOwner() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val camera = CameraCaptureManager(app).apply { attachLifecycleOwner(Owner()) }
      val otherRuntimeCamera = CameraCaptureManager(app).apply { attachLifecycleOwner(Owner()) }
      val entered = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      val active =
        async {
          camera.withCapture { _, _ ->
            entered.complete(Unit)
            release.await()
          }
        }
      try {
        entered.await()
        val handler = CameraHandler(app, camera, { true }, ::invokeErrorFromThrowable)
        assertEquals("CAMERA_BUSY", handler.handleSnap(null).error?.code)
        assertEquals("CAMERA_BUSY", handler.handleClip("""{"includeAudio":false}""").error?.code)
        val replacement = runCatching { otherRuntimeCamera.snap(null) }.exceptionOrNull()
        assertEquals("CAMERA_BUSY: another camera capture is active", replacement?.message)
        assertFalse(active.isCompleted)
      } finally {
        release.complete(Unit)
        active.await()
      }
      assertEquals(
        "released",
        otherRuntimeCamera.withCapture { _, validate ->
          validate()
          "released"
        },
      )
    }

  @Test
  fun accessIsRecheckedAfterAnAsyncBoundaryBeforeCameraUse() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      var foreground = true
      var enabled = true
      val owner = Owner()
      val camera = CameraCaptureManager(app, isForeground = { foreground }, cameraEnabled = { enabled })
      val changes =
        listOf<Pair<String, () -> Unit>>(
          "CAMERA_DISABLED: enable Camera in Settings" to { enabled = false },
          "NODE_BACKGROUND_UNAVAILABLE: command requires foreground" to { foreground = false },
          "CAMERA_PERMISSION_REQUIRED: grant Camera permission" to { shadowOf(app).denyPermissions(Manifest.permission.CAMERA) },
          "UNAVAILABLE: camera Activity changed" to { camera.attachLifecycleOwner(Owner()) },
        )
      for ((expected, revoke) in changes) {
        foreground = true
        enabled = true
        shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        camera.attachLifecycleOwner(owner)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var used = false
        val capture =
          async {
            runCatching {
              camera.withCapture { _, validate ->
                entered.complete(Unit)
                release.await()
                validate()
                used = true
              }
            }
          }
        entered.await()
        revoke()
        release.complete(Unit)
        assertEquals(expected, capture.await().exceptionOrNull()?.message)
        assertFalse(used)
      }
      camera.attachLifecycleOwner(owner)
      assertTrue(
        camera.withCapture { _, validate ->
          validate()
          true
        },
      )
    }

  @Test
  fun activityStopReportsForegroundFailureAndReleasesOwnershipBeforeNextCapture() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val owner = Owner()
      val camera = CameraCaptureManager(app).apply { attachLifecycleOwner(owner) }
      val entered = CompletableDeferred<Unit>()
      var cleanupCount = 0
      val capture =
        async {
          runCatching {
            camera.withCapture { _, _ ->
              try {
                entered.complete(Unit)
                awaitCancellation()
              } finally {
                cleanupCount++
              }
            }
          }
        }
      entered.await()
      owner.registry.currentState = Lifecycle.State.CREATED
      val failure = checkNotNull(capture.await().exceptionOrNull())
      assertFalse(capture.isCancelled)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE: camera Activity left the foreground", failure.message)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE", invokeErrorFromThrowable(failure).first)
      assertEquals(1, cleanupCount)
      owner.registry.currentState = Lifecycle.State.RESUMED
      assertTrue(
        camera.withCapture { _, validate ->
          validate()
          true
        },
      )
    }

  @Test
  fun callerCancellationStaysCancellationAndReleasesOwnership() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val camera = CameraCaptureManager(app).apply { attachLifecycleOwner(Owner()) }
      val entered = CompletableDeferred<Unit>()
      var cleanupCount = 0
      val capture =
        async {
          camera.withCapture { _, _ ->
            try {
              entered.complete(Unit)
              awaitCancellation()
            } finally {
              cleanupCount++
            }
          }
        }
      entered.await()
      capture.cancel()
      capture.join()
      assertTrue(capture.isCancelled)
      assertEquals(1, cleanupCount)
      assertTrue(
        camera.withCapture { _, validate ->
          validate()
          true
        },
      )
    }

  @Test
  fun clipCleanupFailureStillReleasesTheSharedCaptureLease() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val camera = CameraCaptureManager(app).apply { attachLifecycleOwner(Owner()) }
      val file = java.io.File.createTempFile("camera-owner-test-", ".mp4", app.cacheDir)
      val cleanup = mutableListOf<String>()
      try {
        val result =
          runCatching {
            camera.withCapture { _, _ ->
              CameraClipSession(
                unbind = {
                  cleanup += "unbind"
                  error("unbind failure")
                },
                deleteTemporaryFile = { owned ->
                  cleanup += "file"
                  owned.delete()
                },
              ).use { session ->
                session.ownFile(file)
                session.ownRecording(AutoCloseable { cleanup += "recording" })
                error("capture failure")
              }
            }
          }
        assertEquals("capture failure", result.exceptionOrNull()?.message)
        assertEquals(listOf("recording", "unbind", "file"), cleanup)
        assertFalse(file.exists())
        assertTrue(
          camera.withCapture { _, validate ->
            validate()
            true
          },
        )
      } finally {
        file.delete()
      }
    }
}
