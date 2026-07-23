package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.MascotMood
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h480dp-420dpi")
class WelcomeScreenLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Before
  fun disableMascotAnimations() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @Test
  fun largeFontKeepsContinueVisibleWhileWelcomeContentScrolls() {
    var connectClicked = false
    composeRule.setContent {
      val density = LocalDensity.current
      CompositionLocalProvider(LocalDensity provides Density(density = density.density, fontScale = 1.3f)) {
        ClawDesignTheme {
          Box(modifier = Modifier.size(width = 360.dp, height = 480.dp).clipToBounds()) {
            WelcomeScreen(mascotMood = MascotMood.Idle, onConnect = { connectClicked = true })
          }
        }
      }
    }

    composeRule.onNodeWithText("Continue").assertIsDisplayed()
    composeRule.onNode(hasScrollAction()).assertExists()
    composeRule.onNodeWithText("Security notice").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Continue").assertIsDisplayed().performClick()
    assertTrue(connectClicked)
  }
}
