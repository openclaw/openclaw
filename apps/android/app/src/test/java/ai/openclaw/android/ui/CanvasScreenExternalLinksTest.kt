package ai.openclaw.android.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CanvasScreenExternalLinksTest {
  @Test
  fun opensNormalHttpLinksInExternalBrowser() {
    assertTrue(shouldOpenCanvasLinkInExternalBrowser("https://docs.openclaw.ai/channels/telegram", true))
  }

  @Test
  fun keepsCanvasA2uiLinksInsideWebView() {
    assertFalse(
      shouldOpenCanvasLinkInExternalBrowser(
        "http://127.0.0.1:18789/__openclaw__/cap/token-1/__openclaw__/a2ui/?platform=android",
        true,
      ),
    )
  }

  @Test
  fun keepsCanvasHostLinksInsideWebView() {
    assertFalse(
      shouldOpenCanvasLinkInExternalBrowser(
        "http://127.0.0.1:18789/__openclaw__/canvas/index.html",
        true,
      ),
    )
  }

  @Test
  fun ignoresSpecialInlineSchemes() {
    assertFalse(shouldOpenCanvasLinkInExternalBrowser("javascript:void(0)", true))
    assertFalse(shouldOpenCanvasLinkInExternalBrowser("about:blank", true))
    assertFalse(shouldOpenCanvasLinkInExternalBrowser("file:///android_asset/CanvasScaffold/scaffold.html", true))
  }

  @Test
  fun opensCustomSchemesInExternalBrowser() {
    assertTrue(shouldOpenCanvasLinkInExternalBrowser("mailto:support@example.com", true))
  }

  @Test
  fun ignoresSubframeRequests() {
    assertFalse(shouldOpenCanvasLinkInExternalBrowser("https://example.com", false))
  }
}
