package ai.openclaw.app.node

import android.content.Context
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleLocationGet_requiresLocationPermissionWhenNeitherFineNorCoarse() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = false,
              coarseGranted = false,
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_PERMISSION_REQUIRED", result.error?.code)
    }

  @Test
  fun handleLocationGet_requiresForegroundBeforeLocationPermission() =
    runTest {
      val handler =
        LocationHandler.forTesting(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
            ),
          isForeground = { false },
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_BACKGROUND_UNAVAILABLE", result.error?.code)
    }

  @Test
  fun hasFineLocationPermission_reflectsDataSource() {
    val denied =
      LocationHandler.forTesting(
        appContext = appContext(),
        dataSource = FakeLocationDataSource(fineGranted = false, coarseGranted = true),
      )
    assertFalse(denied.hasFineLocationPermission())
    assertTrue(denied.hasCoarseLocationPermission())

    val granted =
      LocationHandler.forTesting(
        appContext = appContext(),
        dataSource = FakeLocationDataSource(fineGranted = true, coarseGranted = false),
      )
    assertTrue(granted.hasFineLocationPermission())
    assertFalse(granted.hasCoarseLocationPermission())
  }
}

private class FakeLocationDataSource(
  private val fineGranted: Boolean,
  private val coarseGranted: Boolean,
) : LocationDataSource {
  override fun hasFinePermission(context: Context): Boolean = fineGranted

  override fun hasCoarsePermission(context: Context): Boolean = coarseGranted

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload {
    throw IllegalStateException(
      "LocationHandlerTest: fetchLocation must not run in this scenario",
    )
  }
}
