package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@Config(sdk = [34])
class LocationForegroundTransitionTest : NodeHandlerRobolectricTest() {
  @Test
  fun whileUsingDoesNotDisclosePendingFixAfterAppBackgrounds() =
    runTest {
      val result = captureAcrossVisibilityChange(background = true, always = false)

      assertFalse(result.ok)
      assertEquals("LOCATION_BACKGROUND_UNAVAILABLE", result.error?.code)
      assertNull("A rejected response must not contain coordinates", result.payloadJson)
    }

  @Test
  fun pendingFixStillSucceedsWhenForegroundOrBackgroundAccessRemainsAllowed() =
    runTest {
      for (always in listOf(false, true)) {
        val result = captureAcrossVisibilityChange(background = always, always = always)

        assertTrue("Authorized capture failed: " + result.error, result.ok)
        val payload = Json.parseToJsonElement(requireNotNull(result.payloadJson)).jsonObject
        assertEquals(12.345678, payload.getValue("lat").jsonPrimitive.double, 0.0)
        assertEquals(45.678912, payload.getValue("lon").jsonPrimitive.double, 0.0)
      }
    }

  private suspend fun TestScope.captureAcrossVisibilityChange(
    background: Boolean,
    always: Boolean,
  ): GatewaySession.InvokeResult {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(
      Manifest.permission.ACCESS_FINE_LOCATION,
      Manifest.permission.ACCESS_COARSE_LOCATION,
      Manifest.permission.ACCESS_BACKGROUND_LOCATION,
    )
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val platform = shadowOf(manager)
    platform.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
    platform.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    platform.simulateLocation(LocationManager.GPS_PROVIDER, location(ageMs = 5_000))
    var foreground = true
    val handler =
      LocationHandler(
        appContext = context,
        location = LocationCaptureManager(context),
        isForeground = { foreground },
        locationMode = { if (always) LocationMode.Always else LocationMode.WhileUsing },
        backgroundLocationEnabled = { always },
        locationPreciseEnabled = { true },
      )
    Dispatchers.setMain(StandardTestDispatcher(testScheduler))
    val request =
      async {
        handler.handleLocationGet("""{"maxAgeMs":500,"timeoutMs":5000}""")
      }
    try {
      runCurrent()
      shadowOf(Looper.getMainLooper()).idle()
      runCurrent()
      assertFalse("Capture must wait for a fresh platform fix", request.isCompleted)
      assertTrue(platform.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty())

      foreground = !background
      platform.simulateLocation(LocationManager.GPS_PROVIDER, location())
      shadowOf(Looper.getMainLooper()).idle()
      runCurrent()

      assertTrue("The fresh fix must settle the request", request.isCompleted)
      assertTrue(platform.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
      return request.await()
    } finally {
      request.cancel()
      runCurrent()
      Dispatchers.resetMain()
    }
  }

  private fun location(ageMs: Long = 0): Location =
    Location(LocationManager.GPS_PROVIDER).apply {
      latitude = 12.345678
      longitude = 45.678912
      accuracy = 5f
      time = System.currentTimeMillis() - ageMs
      elapsedRealtimeNanos = (SystemClock.elapsedRealtime() - ageMs) * 1_000_000
    }
}
