package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayCanvasRouteTest {
  @Test
  fun canvasRoutePinsOnlyTheConnectedTlsEndpoint() {
    val fingerprint = "ab".repeat(32)

    data class RouteCase(
      val host: String,
      val surfaceOrigin: String,
      val matches: Boolean,
      val port: Int = 7443,
      val tls: Boolean = true,
      val pin: String? = fingerprint,
    )
    val cases =
      listOf(
        RouteCase("gateway.example", "https://gateway.example:7443", true),
        RouteCase("GATEWAY.example.", "https://gateway.EXAMPLE:7443", true),
        RouteCase(" gateway.example. ", "https://gateway.example.:7443", true),
        RouteCase("gateway.example", "https://gateway.example", true, port = 443),
        RouteCase("192.0.2.10", "https://192.0.2.10:7443", true),
        RouteCase("[2001:db8::10]", "https://[2001:db8::10]:7443", true),
        RouteCase("gateway.example", "https://canvas.example:7443", false),
        RouteCase("gateway.example", "https://gateway.example:9443", false),
        RouteCase("gateway.example", "http://gateway.example:7443", false),
        RouteCase("localhost", "https://127.0.0.1:7443", false),
        RouteCase("bücher.example", "https://xn--bcher-kva.example:7443", false),
        RouteCase("192.0.2.10", "https://192.0.2.11:7443", false),
        RouteCase("2001:db8::10", "https://[2001:db8::11]:7443", false),
        RouteCase("::ffff:192.0.2.10", "https://192.0.2.11:7443", false),
        RouteCase("gateway.example", "https://gateway.example:7443", false, tls = false),
        RouteCase("gateway.example", "https://gateway.example:7443", false, pin = null),
        RouteCase("::ffff:192.0.2.10", "https://192.0.2.10:7443", true),
        RouteCase("192.0.2.10", "https://[::ffff:192.0.2.10]:7443", true),
        RouteCase("2001:db8::10", "https://[2001:db8::10]:7443", true),
        RouteCase("2001:0db8:0:0:0:0:0:10", "https://[2001:db8::10]:7443", true),
      )
    for (case in cases) {
      assertEquals(
        "Gateway ${case.host}:${case.port}, surface ${case.surfaceOrigin}",
        fingerprint.takeIf { case.matches },
        gatewayTlsFingerprintForCanvasSurface(
          fingerprint = case.pin,
          surfaceUrl = "${case.surfaceOrigin}/__openclaw__/cap/token",
          endpoint = GatewayEndpoint.manual(host = case.host, port = case.port),
          isTlsConnection = case.tls,
        ),
      )
    }
  }
}
