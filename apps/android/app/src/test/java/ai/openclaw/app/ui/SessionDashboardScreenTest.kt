package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionDashboardScreenTest {
  @Test
  fun dashboardUrlReplacesExistingRouteAndEncodesSessionKey() {
    val url =
      sessionDashboardUrl(
        baseUrl = "https://gateway.example.com:8443/old?ignored=true#fragment",
        sessionKey = "agent:main/phone & qa?x=1",
      )

    assertEquals(
      "https://gateway.example.com:8443/chat?session=agent%3Amain%2Fphone%20%26%20qa%3Fx%3D1&face=dashboard",
      url,
    )
  }
}
