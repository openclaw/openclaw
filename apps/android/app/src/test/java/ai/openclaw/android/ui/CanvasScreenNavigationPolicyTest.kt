package ai.openclaw.android.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CanvasScreenNavigationPolicyTest {
  @Test
  fun keepsSameOriginHttpNavigationInsideCanvas() {
    assertFalse(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "https://canvas.example/page",
        targetUrl = "https://canvas.example/docs",
      ),
    )
  }

  @Test
  fun opensCrossOriginHttpNavigationInExternalBrowser() {
    assertTrue(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "https://canvas.example/page",
        targetUrl = "https://docs.example/help",
      ),
    )
  }

  @Test
  fun opensCrossOriginMixedHttpSchemeNavigationInExternalBrowser() {
    assertTrue(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "https://canvas.example/page",
        targetUrl = "http://canvas.example/page",
      ),
    )
  }

  @Test
  fun opensHttpNavigationFromFileCanvasInExternalBrowser() {
    assertTrue(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "file:///android_asset/CanvasScaffold/scaffold.html",
        targetUrl = "https://example.com",
      ),
    )
  }

  @Test
  fun keepsNonHttpTargetsInsideCanvas() {
    assertFalse(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "https://canvas.example",
        targetUrl = "javascript:void(0)",
      ),
    )
  }

  @Test
  fun keepsEquivalentDefaultHttpsPortNavigationInsideCanvas() {
    assertFalse(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = "https://canvas.example/page",
        targetUrl = "https://canvas.example:443/help",
      ),
    )
  }

  @Test
  fun keepsNavigationInsideCanvasWhenCurrentUrlIsMissing() {
    assertFalse(
      shouldOpenCanvasNavigationInExternalBrowser(
        currentUrl = null,
        targetUrl = "https://example.com",
      ),
    )
  }
}
