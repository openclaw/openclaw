package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuddyCameraSnapPlanTest {
  @Test
  fun triesFrontCameraBeforeBackCamera() {
    assertEquals(
      listOf(
        """{"facing":"front","format":"jpg","maxWidth":1280,"quality":0.82}""",
        """{"facing":"back","format":"jpg","maxWidth":1280,"quality":0.82}""",
      ),
      BuddyCameraSnapPlan.paramsJsonSequence(),
    )
  }

  @Test
  fun retriesOnlyWhenRequestedCameraIsUnavailable() {
    assertTrue(BuddyCameraSnapPlan.shouldTryNext("No available camera can be found."))
    assertTrue(BuddyCameraSnapPlan.shouldTryNext("UNAVAILABLE: no camera found"))
    assertFalse(BuddyCameraSnapPlan.shouldTryNext("CAMERA_PERMISSION_REQUIRED: grant Camera permission"))
    assertFalse(BuddyCameraSnapPlan.shouldTryNext("UNAVAILABLE: failed to encode JPEG"))
  }
}
