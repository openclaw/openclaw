package ai.openclaw.app.ui

import android.net.Uri
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CanvasScreenInterceptorTest {
  @Test
  fun testOriginCheckLogic() {
    val remoteAddress = "10.0.2.2:18789"
    
    // Simulate matching request
    assertTrue(isSameOrigin("http://10.0.2.2:18789/canvas", remoteAddress))
    assertTrue(isSameOrigin("https://10.0.2.2:18789/canvas", remoteAddress))
    
    // Simulate cross-origin request
    assertFalse(isSameOrigin("http://example.com/image.png", remoteAddress))
    assertFalse(isSameOrigin("https://10.0.2.2:80/canvas", remoteAddress))
    assertFalse(isSameOrigin("http://10.0.2.3:18789/canvas", remoteAddress))

    // Implicit ports
    assertTrue(isSameOrigin("http://example.com", "example.com:80"))
    assertTrue(isSameOrigin("https://example.com", "example.com:443"))
    assertTrue(isSameOrigin("https://example.com/", "example.com:443"))

    // IPv6
    assertTrue(isSameOrigin("http://[::1]:18789/canvas", "[::1]:18789"))
  }

  // Extracted logic from shouldInterceptRequest for testing
  private fun isSameOrigin(requestUrl: String, remoteAddress: String?): Boolean {
    if (remoteAddress == null) return false
    val uri = Uri.parse(requestUrl)
    val host = uri.host ?: return false
    val port = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80
    val normalizedHost = host.trim().trim('[', ']')
    val requestAuthority = if (normalizedHost.contains(":")) "[$normalizedHost]:$port" else "$normalizedHost:$port"
    return requestAuthority == remoteAddress
  }
}
