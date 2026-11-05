package ai.openclaw.app

import ai.openclaw.app.ui.OpenClawTheme
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.MotionEvent
import android.webkit.WebView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-320dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BrowserSignInScreenTest {
  @get:Rule val composeRule = createComposeRule()
  private lateinit var browser: ScrollProbe

  @Test fun portraitLongRedirectKeepsBrowserViewportAndScroll() = verifyViewport("portrait", 1f, 0)

  @Test
  @Config(qualifiers = "en-rUS-w800dp-h360dp-land-320dpi")
  fun landscapeLongRedirectKeepsBrowserViewportAndScroll() = verifyViewport("landscape", 1f, 0)

  @Test fun portraitLargeFontAndKeyboardSizedWindowKeepViewport() = verifyViewport("portrait-ime", 2f, 300)

  @Test
  @Config(qualifiers = "en-rUS-w800dp-h360dp-land-320dpi")
  fun landscapeLargeFontAndKeyboardSizedWindowKeepViewport() = verifyViewport("landscape-ime", 2f, 180)

  private fun verifyViewport(
    label: String,
    fontScale: Float,
    keyboardSpace: Int,
  ) {
    val redirect = "https://login.example.test:9092/login?rd=https%3A%2F%2Fgateway.example.test%2F&state=" + "synthetic-redirect-state".repeat(500)
    composeRule.setContent {
      OpenClawTheme {
        val density = LocalDensity.current.density
        CompositionLocalProvider(LocalDensity provides Density(density, fontScale)) {
          Box(Modifier.fillMaxSize().padding(bottom = keyboardSpace.dp)) {
            val context = LocalContext.current
            browser = remember { ScrollProbe(context) }
            BrowserSignInScreen(
              currentUrl = redirect,
              error = if (keyboardSpace > 0) "Synthetic retry message ".repeat(100) else null,
              browser = browser,
              busy = false,
              canContinue = true,
              showSignOut = true,
              onCancel = {},
              onContinue = {},
              onSignOut = {},
            )
          }
        }
      }
    }
    composeRule.waitForIdle()
    saveSyntheticProof(label)
    val root = composeRule.onNodeWithTag("browser-signin-root").fetchSemanticsNode().boundsInRoot
    val viewport = composeRule.onNodeWithTag("browser-viewport").fetchSemanticsNode().boundsInRoot
    assertTrue("WebView must receive remaining viewport: root=$root view=$viewport", viewport.height >= root.height * 0.35f)
    assertTrue("WebView dimensions: width=${browser.width} height=${browser.height} measured=${browser.measuredWidth}x${browser.measuredHeight}", browser.width > 0 && browser.height > 0)
    composeRule.onNodeWithTag("browser-security-origin").assertTextEquals("https://login.example.test:9092")
    composeRule.onNodeWithTag("browser-viewport").performTouchInput { swipeUp() }
    composeRule.runOnIdle { assertTrue("Vertical touches must reach the native browser boundary", browser.scrollY > 0) }
  }

  private fun saveSyntheticProof(label: String) {
    val root = System.getenv("OPENCLAW_PHONE_UX_PROOF_DIR") ?: return
    val phase = System.getenv("OPENCLAW_PHONE_UX_PROOF_PHASE") ?: "after"
    val output = File(root, "browser-$phase-$label.png")
    output.parentFile?.mkdirs()
    output.outputStream().use { stream ->
      composeRule
        .onRoot()
        .captureToImage()
        .asAndroidBitmap()
        .compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
    }
  }

  // A real native ScrollView exercises the production AndroidView layout/touch boundary.
  // It is a synthetic page, not a browser renderer or authentication qualification.
  private class ScrollProbe(
    context: Context,
  ) : android.widget.ScrollView(context) {
    init {
      setBackgroundColor(Color.WHITE)
      addView(
        android.widget.TextView(context).apply {
          text = (0..100).joinToString("\n") { if (it == 0) "Synthetic sign-in layout fixture" else "Scroll content $it" }
          textSize = 16f
          setTextColor(Color.BLACK)
          setPadding(16, 16, 16, 16)
        },
      )
    }
  }
}
