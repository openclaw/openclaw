package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import android.Manifest
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LocationAttachmentTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun cachedAttachmentHonorsDisabledPrecisionWithRetainedFineGrant() {
    val app = RuntimeEnvironment.getApplication()
    (app as ai.openclaw.app.NodeApp).prefs.setLocationPreciseEnabled(false)
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
    val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    shadowOf(manager).setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    val fix =
      Location(LocationManager.GPS_PROVIDER).apply {
        latitude = 12.345678
        longitude = 45.678912
        accuracy = 5f
        time = System.currentTimeMillis()
      }
    shadowOf(manager).simulateLocation(LocationManager.GPS_PROVIDER, fix)
    val links = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme { LocationAttachment(admit = { true }, onLocation = links::add) }
    }
    composeRule.onNodeWithText("Use current location").performClick()
    composeRule.runOnIdle {
      assertEquals(1, links.size)
      org.junit.Assert.assertNotEquals("https://www.google.com/maps?q=12.345678,45.678912", links.single())
    }
    composeRule.onNodeWithText("Use current location").performClick()
    composeRule.runOnIdle { assertEquals(links.first(), links.last()) }
  }

  @Test
  fun pendingAttachmentRechecksPrecisionAndNeverUpgradesApproximateCapture() {
    val app = RuntimeEnvironment.getApplication() as ai.openclaw.app.NodeApp
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
    val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val provider = shadowOf(manager)
    provider.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
    provider.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    val links = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme { LocationAttachment(admit = { true }, onLocation = { links.add(it) }) }
    }
    for ((initial, final) in listOf(true to false, false to true)) {
      val fix =
        Location(LocationManager.GPS_PROVIDER).apply {
          latitude = 12.345678
          longitude = 45.678912
          accuracy = 5f
          time = System.currentTimeMillis() - 120_000
        }
      composeRule.runOnIdle {
        app.prefs.setLocationPreciseEnabled(initial)
        provider.simulateLocation(LocationManager.GPS_PROVIDER, fix)
      }
      composeRule.onNodeWithText("Use current location").performClick()
      composeRule.runOnIdle {
        assertTrue(provider.getLocationRequests(LocationManager.GPS_PROVIDER).isNotEmpty())
        app.prefs.setLocationPreciseEnabled(final)
        fix.time = System.currentTimeMillis()
        provider.simulateLocation(LocationManager.GPS_PROVIDER, fix)
      }
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        assertTrue(links.isNotEmpty())
        org.junit.Assert.assertNotEquals("https://www.google.com/maps?q=12.345678,45.678912", links.last())
        assertTrue(provider.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
      }
    }
    composeRule.runOnIdle { assertEquals(2, links.size) }
  }

  @Test
  fun locationTimeoutShowsRecoveryMessageAndAllowsRetry() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
    val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    shadowOf(manager).setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
    composeRule.setContent {
      ClawDesignTheme {
        LocationAttachment(admit = { true }, onLocation = { error("No location was supplied") })
      }
    }
    composeRule.onNodeWithText("Use current location").performClick()
    composeRule.onNodeWithText("Getting location…").assertIsDisplayed()
    composeRule.mainClock.advanceTimeBy(16_000)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(16))
    composeRule.onNodeWithText("Could not get your location. Check device location settings and try again.").assertIsDisplayed()
    composeRule.onNodeWithText("Use current location").assertIsEnabled()
    composeRule.onNodeWithText("Use current location").performClick()
    composeRule.onNodeWithText("Getting location…").assertIsDisplayed()
  }

  @Test
  fun closingLocationPanelCancelsProviderRequestAndIgnoresLateFix() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
    val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val provider = shadowOf(manager)
    provider.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
    val visible = mutableStateOf(true)
    var insertions = 0
    composeRule.setContent {
      ClawDesignTheme {
        if (visible.value) LocationAttachment(admit = { true }, onLocation = { insertions++ })
      }
    }
    composeRule.onNodeWithText("Use current location").performClick()
    composeRule.runOnIdle {
      assertTrue(provider.getLocationRequests(LocationManager.NETWORK_PROVIDER).isNotEmpty())
      visible.value = false
    }
    composeRule.waitForIdle()
    composeRule.runOnIdle {
      assertTrue(provider.getLocationRequests(LocationManager.NETWORK_PROVIDER).isEmpty())
      provider.simulateLocation(Location(LocationManager.NETWORK_PROVIDER))
    }
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(16))
    composeRule.runOnIdle { assertEquals(0, insertions) }
  }
}
