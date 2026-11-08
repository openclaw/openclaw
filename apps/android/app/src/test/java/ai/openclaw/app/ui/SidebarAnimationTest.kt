package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.roundToInt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w400dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarAnimationTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun ltrOpeningKeepsContentRigidAndStopsAtWindowEdge() = verifyOpening(LayoutDirection.Ltr)

  @Test
  fun rtlOpeningKeepsContentRigidAndStopsAtWindowEdge() = verifyOpening(LayoutDirection.Rtl)

  private fun verifyOpening(direction: LayoutDirection) {
    lateinit var state: DrawerState
    lateinit var scope: CoroutineScope
    var background = Color.Unspecified
    var contentWidth = 0
    var expectedWidth = 0
    var rootWidth = 0
    var contentX = 0f
    composeRule.setContent {
      CompositionLocalProvider(LocalLayoutDirection provides direction) {
        ClawDesignTheme {
          val drawer = rememberDrawerState(DrawerValue.Closed)
          val coroutineScope = rememberCoroutineScope()
          background = ClawTheme.colors.canvas
          expectedWidth = with(LocalDensity.current) { 360.dp.roundToPx() }
          rootWidth = with(LocalDensity.current) { 400.dp.roundToPx() }
          SideEffect {
            state = drawer
            scope = coroutineScope
          }
          SidebarNavigationShell(
            drawerState = drawer,
            drawerContent = {
              Box(
                Modifier.fillMaxSize().onGloballyPositioned {
                  contentWidth = it.size.width
                  contentX = it.positionInRoot().x
                },
              )
            },
            content = { Box(Modifier.fillMaxSize().background(Color.Magenta)) },
          )
        }
      }
    }
    composeRule.waitForIdle()
    composeRule.mainClock.autoAdvance = false
    composeRule.runOnIdle { scope.launch { state.open() } }
    var sawOvershoot = false
    repeat(45) {
      composeRule.mainClock.advanceTimeByFrame()
      composeRule.waitForIdle()
      if (state.currentOffset < 0f && state.currentOffset > -expectedWidth) {
        assertEquals("Drawer content must not reflow while sliding at offset ${state.currentOffset}", expectedWidth, contentWidth)
      }
      val visibleOffset = state.currentOffset.roundToInt().coerceAtMost(0)
      val expectedX = if (direction == LayoutDirection.Ltr) visibleOffset else rootWidth - expectedWidth - visibleOffset
      assertEquals("Content must translate rigidly and never pass its open anchor", expectedX.toFloat(), contentX, 1f)
      if (state.currentOffset > 0f) {
        sawOvershoot = true
        val bitmap = composeRule.onRoot().captureToImage().asAndroidBitmap()
        assertEquals("Window edge must retain sidebar background at offset ${state.currentOffset}", background.toArgb(), bitmap.getPixel(if (direction == LayoutDirection.Ltr) 0 else bitmap.width - 1, bitmap.height / 2))
      }
    }
    assertTrue("Exercise the real opening spring overshoot", sawOvershoot)
  }
}
