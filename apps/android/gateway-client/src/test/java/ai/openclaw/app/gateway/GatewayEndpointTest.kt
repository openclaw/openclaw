package ai.openclaw.app.gateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayEndpointTest {
  @Test
  fun tailscaleAdviceUsesExactHostnameAndAddressRangesWithoutChangingTrust() {
    listOf(
      "gateway.tail-example.ts.net",
      " GATEWAY.TAIL-EXAMPLE.TS.NET. ",
      "100.64.0.0",
      "100.127.255.255",
      "fd7a:115c:a1e0::1",
      "[FD7A:115C:A1E0:ffff::1]",
    ).forEach { assertTrue(it, isTailscaleGatewayHost(it)) }
    listOf(
      "ts.net",
      "not-ts.net",
      "gateway.ts.net.example",
      "100.63.255.255",
      "100.128.0.0",
      "100.64.256.1",
      "100.64.1",
      "fd7a:115c:a1e1::1",
      "fd7a:115c:a1e0.example",
      "192.168.1.1",
      "gateway.local",
    ).forEach { assertFalse(it, isTailscaleGatewayHost(it)) }
    assertFalse(isLocalCleartextGatewayHost("gateway.tail-example.ts.net", allowEmulatorBridgeAlias = false))
    assertFalse(isLocalCleartextGatewayHost("100.64.0.1", allowEmulatorBridgeAlias = false))
  }
}
