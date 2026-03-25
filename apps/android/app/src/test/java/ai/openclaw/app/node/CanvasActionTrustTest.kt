package ai.openclaw.app.node

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CanvasActionTrustTest {
  @Test
  fun acceptsBundledScaffoldAsset() {
    assertTrue(CanvasActionTrust.isTrustedCanvasActionUrl(CanvasActionTrust.scaffoldAssetUrl, emptyList()))
  }

  @Test
  fun acceptsTrustedA2uiPageOnAdvertisedCanvasHost() {
    assertTrue(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "https://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android",
        trustedA2uiUrls = listOf("https://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android"),
      ),
    )
  }

  @Test
  fun rejectsDifferentOriginEvenIfPathMatches() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "https://evil.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android",
        trustedA2uiUrls = listOf("https://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android"),
      ),
    )
  }

  @Test
  fun rejectsUntrustedCanvasPagePathOnTrustedOrigin() {
    assertFalse(
      CanvasActionTrust.isTrustedCanvasActionUrl(
        rawUrl = "https://canvas.example.com:9443/untrusted/index.html",
        trustedA2uiUrls = listOf("https://canvas.example.com:9443/__openclaw__/cap/token/__openclaw__/a2ui/?platform=android"),
      ),
    )
  }
}
