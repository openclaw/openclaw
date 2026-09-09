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
