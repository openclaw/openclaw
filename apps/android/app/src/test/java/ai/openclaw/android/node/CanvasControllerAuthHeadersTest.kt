package ai.openclaw.android.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CanvasControllerAuthHeadersTest {
  @Test
  fun resolveCanvasOriginNormalizesSchemeHostAndPort() {
    assertEquals(
      "https://gateway.example.com:443",
      resolveCanvasOrigin("https://Gateway.Example.com/__openclaw__/cap/abc"),
    )
    assertEquals(
      "http://127.0.0.1:18789",
      resolveCanvasOrigin("http://127.0.0.1:18789/__openclaw__/canvas/"),
    )
  }

  @Test
  fun resolveCanvasOriginRejectsInvalidUrls() {
    assertNull(resolveCanvasOrigin(""))
    assertNull(resolveCanvasOrigin("file:///android_asset/CanvasScaffold/scaffold.html"))
    assertNull(resolveCanvasOrigin("not-a-url"))
  }

  @Test
  fun buildCanvasGatewayAuthHeadersAddsBearerForTrustedOpenclawPath() {
    val headers =
      buildCanvasGatewayAuthHeaders(
        targetUrl = "https://gateway.example.com/__openclaw__/cap/abc/__openclaw__/a2ui/",
        bearerToken = "token-123",
        trustedCanvasOrigins = setOf("https://gateway.example.com:443"),
      )

    assertEquals("Bearer token-123", headers["Authorization"])
  }

  @Test
  fun buildCanvasGatewayAuthHeadersSkipsUntrustedOrNonOpenclawTargets() {
    val trusted = setOf("https://gateway.example.com:443")

    assertEquals(
      emptyMap<String, String>(),
      buildCanvasGatewayAuthHeaders(
        targetUrl = "https://evil.example.com/__openclaw__/canvas/",
        bearerToken = "token-123",
        trustedCanvasOrigins = trusted,
      ),
    )

    assertEquals(
      emptyMap<String, String>(),
      buildCanvasGatewayAuthHeaders(
        targetUrl = "https://gateway.example.com/path",
        bearerToken = "token-123",
        trustedCanvasOrigins = trusted,
      ),
    )
  }
}
