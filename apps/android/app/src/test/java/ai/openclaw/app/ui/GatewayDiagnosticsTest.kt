package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayDiagnosticsTest {
  @Test
  fun endpointPrefersLiveRemoteAddress() {
    assertEquals(
      "wss://gateway.example.test",
      gatewayDiagnosticsEndpoint(
        remoteAddress = " wss://gateway.example.test ",
        manualHost = "10.0.2.2",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun endpointFallsBackToManualConfig() {
    assertEquals(
      "http://10.0.2.2:18789",
      gatewayDiagnosticsEndpoint(
        remoteAddress = null,
        manualHost = "10.0.2.2",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun endpointReportsMissingConfig() {
    assertEquals(
      "Not set",
      gatewayDiagnosticsEndpoint(
        remoteAddress = null,
        manualHost = "",
        manualPort = 18789,
        manualTls = false,
      ),
    )
  }

  @Test
  fun diagnosticsReportIncludesSupportContext() {
    val report =
      buildGatewayDiagnosticsReport(
        screen = "chat composer",
        gatewayAddress = "http://10.0.2.2:18789",
        statusText = "connection refused",
      )

    assertTrue(report.contains("- screen: chat composer"))
    assertTrue(report.contains("- gateway address: http://10.0.2.2:18789"))
    assertTrue(report.contains("- status/error: connection refused"))
  }
}
