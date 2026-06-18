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
  fun offlineDiagnosisClassifiesCommonConnectionFailures() {
    assertEquals("Endpoint not configured", gatewayOfflineDiagnosis(statusText = "Offline", gatewayAddress = "Not set"))
    assertEquals("Pairing needs approval", gatewayOfflineDiagnosis(statusText = "Pairing request pending approval", gatewayAddress = "ws://10.0.2.2:18789"))
    assertEquals("Authentication needs attention", gatewayOfflineDiagnosis(statusText = "Auth token rejected", gatewayAddress = "ws://10.0.2.2:18789"))
    assertEquals("TLS trust needs review", gatewayOfflineDiagnosis(statusText = "TLS fingerprint changed", gatewayAddress = "wss://gateway.example.test"))
    assertEquals("Gateway is unreachable", gatewayOfflineDiagnosis(statusText = "connection refused", gatewayAddress = "ws://10.0.2.2:18789"))
  }

  @Test
  fun diagnosticsReportIncludesDiagnosisAndSupportContext() {
    val report =
      buildGatewayDiagnosticsReport(
        screen = "chat composer",
        gatewayAddress = "http://10.0.2.2:18789",
        statusText = "connection refused",
      )

    assertTrue(report.contains("- screen: chat composer"))
    assertTrue(report.contains("- gateway address: http://10.0.2.2:18789"))
    assertTrue(report.contains("- diagnosis: Gateway is unreachable"))
    assertTrue(report.contains("- status/error: connection refused"))
  }
}
