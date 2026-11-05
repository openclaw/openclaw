package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BrowserSecurityOriginTest {
  @Test fun currentProviderPortIsShownWithoutRedirectOrCredentials() {
    assertEquals("https://login.example.test:9092", browserSecurityOrigin("https://user:secret@login.example.test:9092/login?rd=https%3A%2F%2Fgateway.example.test&state=" + "synthetic".repeat(1000) + "#fragment"))
  }

  @Test fun standardPortsAndIpv6AreCanonical() {
    assertEquals("https://gateway.example.test", browserSecurityOrigin("https://gateway.example.test:443/a"))
    assertEquals("https://[fd00::1]:9443", browserSecurityOrigin("https://[fd00::1]:9443/a?q=synthetic"))
  }

  @Test fun invalidOrInsecureNavigationIsNotMisrepresentedAsTheGateway() {
    assertNull(browserSecurityOrigin("about:blank"))
    assertNull(browserSecurityOrigin("http://login.example.test/"))
    assertNull(browserSecurityOrigin("not a URL"))
  }
}
