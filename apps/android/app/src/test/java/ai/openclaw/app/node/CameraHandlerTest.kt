package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CameraHandlerTest {
  @Test
  fun isCameraClipWithinPayloadLimit_allowsZeroAndLimit() {
    assertTrue(isCameraClipWithinPayloadLimit(0L))
    assertTrue(isCameraClipWithinPayloadLimit(CAMERA_CLIP_MAX_RAW_BYTES))
  }

  @Test
  fun isCameraClipWithinPayloadLimit_rejectsNegativeAndTooLarge() {
    assertFalse(isCameraClipWithinPayloadLimit(-1L))
    assertFalse(isCameraClipWithinPayloadLimit(CAMERA_CLIP_MAX_RAW_BYTES + 1L))
  }

  @Test
  fun cameraClipMaxRawBytes_matchesExpectedBudget() {
    assertEquals(18L * 1024L * 1024L, CAMERA_CLIP_MAX_RAW_BYTES)
  }

  @Test
  fun cleanupCameraClipSession_stopsRecordingUnbindsCameraAndDeletesOwnedFile() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    var stopped = false
    var unbound = false
    var deletedFile: File? = null

    cleanupCameraClipSession(
      recordingStopNeeded = true,
      stopRecording = { stopped = true },
      cameraBound = true,
      unbindCamera = { unbound = true },
      temporaryFile = tempFile,
      callerOwnsFile = false,
      deleteTemporaryFile = {
        deletedFile = it
        it.delete()
      },
    )

    assertTrue(stopped)
    assertTrue(unbound)
    assertSame(tempFile, deletedFile)
    assertFalse(tempFile.exists())
  }

  @Test
  fun cleanupCameraClipSession_keepsFileReturnedToCallerAndSkipsAlreadyStoppedRecording() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    try {
      var stopped = false
      var unbound = false

      cleanupCameraClipSession(
        recordingStopNeeded = false,
        stopRecording = { stopped = true },
        cameraBound = true,
        unbindCamera = { unbound = true },
        temporaryFile = tempFile,
        callerOwnsFile = true,
        deleteTemporaryFile = { it.delete() },
      )

      assertFalse(stopped)
      assertTrue(unbound)
      assertTrue(tempFile.exists())
    } finally {
      tempFile.delete()
    }
  }
}
