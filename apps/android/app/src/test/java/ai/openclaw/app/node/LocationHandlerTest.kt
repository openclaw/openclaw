package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import android.content.Context
import android.location.Location
import android.location.LocationManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocationHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleLocationGet_requiresLocationPermissionWhenNeitherFineNorCoarse() =
    runTest {
      val handler =
        createLocationHandler(
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
        createLocationHandler(
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
  fun handleLocationGet_allowsBackgroundWhenThirdPartyAlwaysGrantIsEffective() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = false,
          coarseGranted = true,
          backgroundGranted = true,
        )
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource = source,
          isForeground = { false },
          locationMode = { LocationMode.Always },
          backgroundLocationEnabled = { true },
        )

      val result = handler.handleLocationGet(null)

      assertTrue(result.ok)
    }

  @Test
  fun handleLocationGet_deniesBackgroundWhenFlavorDisablesAlwaysMode() =
    runTest {
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              backgroundGranted = true,
            ),
          isForeground = { false },
          locationMode = { LocationMode.Always },
          backgroundLocationEnabled = { false },
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_BACKGROUND_UNAVAILABLE", result.error?.code)
    }

  @Test
  fun handleLocationGet_usesPreciseGpsFirstWhenFinePermissionAndPreciseEnabled() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = true,
          coarseGranted = true,
        )
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource = source,
          locationPreciseEnabled = { true },
        )

      val result = handler.handleLocationGet("""{"desiredAccuracy":"precise","maxAgeMs":1234,"timeoutMs":2000}""")

      assertTrue(result.ok)
      assertEquals(listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER), source.lastDesiredProviders)
      assertEquals(1234L, source.lastMaxAgeMs)
      assertEquals(2000L, source.lastTimeoutMs)
    }

  @Test
  fun handleLocationGet_fallsBackToBalancedWhenPreciseUnavailable() =
    runTest {
      val source =
        FakeLocationDataSource(
          fineGranted = false,
          coarseGranted = true,
        )
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource = source,
          locationPreciseEnabled = { true },
        )

      val result = handler.handleLocationGet("""{"desiredAccuracy":"precise"}""")

      assertTrue(result.ok)
      assertEquals(listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER), source.lastDesiredProviders)
    }

  @Test
  fun handleLocationGet_mapsTimeoutToLocationTimeout() =
    runTest {
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              timeout = true,
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_TIMEOUT", result.error?.code)
      assertEquals("LOCATION_TIMEOUT: no fix in time", result.error?.message)
    }

  @Test
  fun handleLocationGet_mapsOtherFailuresToLocationUnavailable() =
    runTest {
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              failure = IllegalStateException("gps offline"),
            ),
        )

      val result = handler.handleLocationGet(null)

      assertFalse(result.ok)
      assertEquals("LOCATION_UNAVAILABLE", result.error?.code)
      assertEquals("gps offline", result.error?.message)
    }

  @Test
  fun handleLocationGet_propagatesParentCancellation() =
    runTest {
      val handler =
        createLocationHandler(
          appContext = appContext(),
          dataSource =
            FakeLocationDataSource(
              fineGranted = true,
              coarseGranted = true,
              failure = CancellationException("request retired"),
            ),
        )

      try {
        handler.handleLocationGet(null)
        fail("expected cancellation to propagate")
      } catch (err: CancellationException) {
        assertEquals("request retired", err.message)
      }
    }
}

private fun createLocationHandler(
  appContext: Context,
  dataSource: FakeLocationDataSource,
  isForeground: () -> Boolean = { true },
  locationMode: () -> LocationMode = { LocationMode.WhileUsing },
  backgroundLocationEnabled: () -> Boolean = { false },
  locationPreciseEnabled: () -> Boolean = { true },
): LocationHandler =
  LocationHandler(
    appContext = appContext,
    capture = dataSource::fetchLocation,
    hasFinePermission = { dataSource.fineGranted },
    hasCoarsePermission = { dataSource.coarseGranted },
    hasBackgroundPermission = { dataSource.backgroundGranted },
    isForeground = isForeground,
    locationMode = locationMode,
    backgroundLocationEnabled = backgroundLocationEnabled,
    locationPreciseEnabled = locationPreciseEnabled,
  )

private class FakeLocationDataSource(
  val fineGranted: Boolean,
  val coarseGranted: Boolean,
  val backgroundGranted: Boolean = false,
  private val failure: Throwable? = null,
  private val timeout: Boolean = false,
) {
  var lastDesiredProviders: List<String> = emptyList()
  var lastMaxAgeMs: Long? = null
  var lastTimeoutMs: Long? = null

  suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
  ): Location {
    lastDesiredProviders = desiredProviders
    lastMaxAgeMs = maxAgeMs
    lastTimeoutMs = timeoutMs
    if (timeout) {
      kotlinx.coroutines.withTimeout(1) {
        kotlinx.coroutines.delay(5)
      }
    }
    failure?.let { throw it }
    return Location(LocationManager.GPS_PROVIDER).apply {
      latitude = 12.345678
      longitude = 45.678912
      accuracy = 5f
    }
  }
}
