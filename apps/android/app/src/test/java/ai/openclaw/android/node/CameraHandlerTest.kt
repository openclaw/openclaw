package ai.openclaw.android.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
