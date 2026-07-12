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
  fun cameraClipSession_closesRecordingUnbindsAndDeletesOwnedFile() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    val cleanup = mutableListOf<String>()
    val session =
      CameraClipSession(
        unbind = { cleanup += "unbind" },
        deleteTemporaryFile = { file ->
          cleanup += "file"
          assertSame(tempFile, file)
          file.delete()
        },
      )
    session.ownRecording(AutoCloseable { cleanup += "recording" })
    session.ownFile(tempFile)

    session.close()
    session.close()

    assertEquals(listOf("recording", "unbind", "file"), cleanup)
    assertFalse(tempFile.exists())
  }

  @Test
  fun cameraClipSession_unbindsBeforeRecordingStarts() {
    val cleanup = mutableListOf<String>()

    CameraClipSession(
      unbind = { cleanup += "unbind" },
      deleteTemporaryFile = { cleanup += "file" },
    ).close()

    assertEquals(listOf("unbind"), cleanup)
  }

  @Test
  fun cameraClipSession_keepsFileTransferredToCaller() {
    val tempFile = File.createTempFile("openclaw-clip-test-", ".mp4")
    try {
      val cleanup = mutableListOf<String>()
      val session =
        CameraClipSession(
          unbind = { cleanup += "unbind" },
          deleteTemporaryFile = { cleanup += "file" },
        )
      session.ownRecording(AutoCloseable { cleanup += "recording" })
      session.ownFile(tempFile)

      assertSame(tempFile, session.transferFile())
      session.close()

      assertEquals(listOf("recording", "unbind"), cleanup)
      assertTrue(tempFile.exists())
    } finally {
      tempFile.delete()
    }
  }
}
