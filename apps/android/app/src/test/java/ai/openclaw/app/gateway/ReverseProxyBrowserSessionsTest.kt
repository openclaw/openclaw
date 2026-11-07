package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReverseProxyBrowserSessionsTest {
  @Test
  fun localSignoutRemainsFailClosedAcrossOwnerRestartWithoutOpeningWebView() {
    val prefs = SecurePrefs(RuntimeEnvironment.getApplication())
    val target = "https://gateway.example.test:8443/".toHttpUrl()
    val endpoint = GatewayEndpoint.manual(target.host, target.port)
    val owner = ReverseProxyBrowserSessions(prefs)
    assertNull(owner.authorization(endpoint))

    owner.signOut(target)
    assertFalse(owner.hasSession(target))
    assertEquals(mapOf(target.browserSessionOrigin() to ""), prefs.loadBrowserSessionProfiles())
    val restored = ReverseProxyBrowserSessions(prefs)
    val authorization = restored.authorization(endpoint)
    assertNotNull(authorization)
    assertThrows(GatewayExternalAuthorizationException::class.java) {
      requireNotNull(authorization).authorizeHttp(Request.Builder().url(target).build())
    }
    assertNull(restored.authorization(GatewayEndpoint.manual("other.example.test", target.port)))
  }
}
