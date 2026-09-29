package ai.openclaw.app.ui.chat

import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.inspector.WindowInspector
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipe
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowViewRootImpl
import org.robolectric.util.ReflectionHelpers
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatImagePreviewTest {
  @get:Rule val composeRule = createComposeRule()
  private var previousFontScale = 1f

  @Before fun saveFontScale() {
    previousFontScale = RuntimeEnvironment.getFontScale()
  }

  @After fun restoreFontScale() {
    RuntimeEnvironment.setFontScale(previousFontScale)
  }

  @Test
  fun imageTapKeepsManagedPreviewOpen() {
    openManagedImage()
    capture("initial")
    composeRule.onNodeWithContentDescription("Image preview").performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNodeWithText("100%").assertIsDisplayed()
  }

  @Test
  fun zoomPercentageRemainsReadableWithLargeSystemAndAppText() {
    openManagedImage(fontScale = 2.8f)
    for (label in listOf("100%", "400%")) {
      if (label == "400%") repeat(4) { composeRule.onNodeWithContentDescription("Zoom in").performClick() }
      val layouts = mutableListOf<TextLayoutResult>()
      composeRule
        .onNodeWithText(label, useUnmergedTree = true)
        .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      capture("large-text-$label")
      val layout = layouts.single()
      assertEquals("Dialog must use the effective Android text scale", 2.8f, layout.layoutInput.density.fontScale, 0.001f)
      val bounds = composeRule.onNodeWithContentDescription("Reset zoom").getUnclippedBoundsInRoot()
      assertEquals("Zoom percentage must stay on one complete line", 1, layout.lineCount)
      assertTrue("Zoom percentage must fit the control width", layout.getLineRight(0) <= (bounds.right - bounds.left).value * layout.layoutInput.density.density)
      assertTrue("Zoom percentage must fit the control height", layout.getLineBottom(0) <= (bounds.bottom - bounds.top).value * layout.layoutInput.density.density)
    }
    capture("large-text")
  }

  @Test
  fun appTextDensitySurvivesTheNativeImageWindow() {
    openManagedImage(appFontScale = 1.4f)
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("100%", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  @Test
  fun controlsClampAndResetAndDoubleTapToggles() {
    openManagedImage()
    composeRule.onNodeWithContentDescription("Zoom out").assertIsNotEnabled()
    composeRule.onNodeWithContentDescription("Reset zoom").assertIsNotEnabled()
    composeRule.onNodeWithContentDescription("Zoom out").performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Reset zoom").performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    repeat(4) { composeRule.onNodeWithContentDescription("Zoom in").performClick() }
    composeRule.onNodeWithText("400%").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Zoom in").assertIsNotEnabled()
    composeRule.onNodeWithContentDescription("Zoom in").performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Zoom out").performClick()
    composeRule.onNodeWithText("267%").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Reset zoom").performClick()
    composeRule.onNodeWithText("100%").assertIsDisplayed()
    composeRule.onNode(isDialog()).performTouchInput { doubleClick(center) }
    composeRule.onNodeWithText("250%").assertIsDisplayed()
    capture("zoomed")
    composeRule.onNode(isDialog()).performTouchInput {
      advanceEventTime(400)
      doubleClick(center)
    }
    composeRule.onNodeWithText("100%").assertIsDisplayed()
  }

  @Test
  fun backgroundTapClosesButImageDragAndReturningBackgroundDragDoNot() {
    openManagedImage()
    composeRule.onNode(isDialog()).performTouchInput {
      swipe(center, center + Offset(70f, 0f))
    }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNode(isDialog()).performTouchInput {
      down(Offset(80f, 150f))
      moveTo(Offset(150f, 150f))
      moveTo(Offset(80f, 150f))
      up()
    }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNode(isDialog()).performTouchInput { click(Offset(4f, 30f)) }
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Sample image", useUnmergedTree = true).performTouchInput { click(center) }
    repeat(4) { composeRule.onNodeWithContentDescription("Zoom in").performClick() }
    composeRule.onNode(isDialog()).performTouchInput { click(Offset(180f, 30f)) }
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Sample image", useUnmergedTree = true).performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").performClick()
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  @Test
  fun pinchAndStationaryTwoFingerContactNeverDismiss() {
    openManagedImage()
    composeRule.onNode(isDialog()).performTouchInput {
      down(0, Offset(70f, 150f))
      down(1, Offset(140f, 150f))
      up(0)
      up(1)
    }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNode(isDialog()).performTouchInput {
      pinch(center - Offset(40f, 0f), center - Offset(100f, 0f), center + Offset(40f, 0f), center + Offset(100f, 0f))
    }
    composeRule.onNodeWithText("250%").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Reset zoom").performClick()
    composeRule.onNodeWithText("100%").assertIsDisplayed()
  }

  @Test
  fun androidBackClosesWithoutDiscardingTheLoadedImage() {
    openManagedImage()
    composeRule.runOnIdle {
      val owner = WindowInspector.getGlobalWindowViews().asReversed().firstNotNullOfOrNull { it.findViewTreeOnBackPressedDispatcherOwner() }
      checkNotNull(owner).onBackPressedDispatcher.onBackPressed()
    }
    composeRule.onNode(isDialog()).assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Sample image", useUnmergedTree = true).performTouchInput { click(center) }
    composeRule.onNodeWithText("100%").assertIsDisplayed()
  }

  @Test
  fun viewportRotationRefitsWhileKeepingTheOpening() {
    openManagedImage()
    composeRule.onNodeWithContentDescription("Zoom in").performClick()
    composeRule.runOnIdle {
      RuntimeEnvironment.setQualifiers("en-rUS-w800dp-h360dp-land-mdpi")
      WindowInspector.getGlobalWindowViews().forEach { view ->
        val root = ReflectionHelpers.callInstanceMethod<Any>(view, "getViewRootImpl")
        Shadow.extract<ShadowViewRootImpl>(root).callDispatchResized()
      }
    }
    composeRule.waitForIdle()
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
    composeRule.onNodeWithText("100%").assertIsDisplayed()
    capture("landscape")
  }

  @Test
  fun savedOpeningRestoresFittedWithoutStaleGestureOffsets() {
    val restoration = StateRestorationTester(composeRule)
    openManagedImage(restoration)
    composeRule.onNodeWithContentDescription("Zoom in").performClick()
    composeRule.onNodeWithText("150%").assertIsDisplayed()
    restoration.emulateSavedInstanceStateRestore()
    composeRule.waitUntil { composeRule.onAllNodesWithContentDescription("Close image preview").fetchSemanticsNodes().isNotEmpty() }
    composeRule.onNodeWithText("100%").assertIsDisplayed()
  }

  private fun openManagedImage(
    restoration: StateRestorationTester? = null,
    fontScale: Float = 1f,
    appFontScale: Float = fontScale,
  ) {
    RuntimeEnvironment.setFontScale(fontScale)
    val bitmap = Bitmap.createBitmap(480, 320, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).apply {
      drawColor(Color.rgb(24, 48, 64))
      val paint = Paint().apply { color = Color.rgb(244, 160, 60) }
      drawRect(24f, 24f, 456f, 296f, paint)
      paint.color = Color.rgb(32, 100, 125)
      drawCircle(240f, 160f, 90f, paint)
      paint.color = Color.WHITE
      paint.textSize = 28f
      drawText("IMAGE FIXTURE", 136f, 170f, paint)
    }
    val bytes =
      ByteArrayOutputStream().use { output ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
      }
    bitmap.recycle()
    val content: @androidx.compose.runtime.Composable () -> Unit = {
      val context = LocalContext.current
      SideEffect {
        // Match MainActivity: production handles viewport configuration changes in place.
        val manager = context.packageManager
        val info = manager.getActivityInfo(ComponentName(context, context.javaClass), 0)
        info.configChanges = ActivityInfo.CONFIG_ORIENTATION or ActivityInfo.CONFIG_SCREEN_SIZE or ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE or ActivityInfo.CONFIG_SCREEN_LAYOUT
        shadowOf(manager).addOrUpdateActivity(info)
      }
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, appFontScale)) {
        ClawDesignTheme {
          Box(Modifier.fillMaxSize()) {
            ChatManagedImage("fixture-image", "Sample image", true) { GatewayLoadedImage(bytes, "image/png") }
          }
        }
      }
    }
    if (restoration == null) composeRule.setContent(content) else restoration.setContent(content)
    composeRule.waitUntil { composeRule.onAllNodesWithContentDescription("Sample image").fetchSemanticsNodes().isNotEmpty() }
    composeRule.onNodeWithContentDescription("Sample image", useUnmergedTree = true).performTouchInput { click(center) }
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed()
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_IMAGE_PROOF_DIR") ?: return
    val file = File(directory, "$name.png")
    checkNotNull(file.parentFile).mkdirs()
    file.outputStream().use {
      assertTrue(
        composeRule
          .onNode(isDialog())
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }
}
