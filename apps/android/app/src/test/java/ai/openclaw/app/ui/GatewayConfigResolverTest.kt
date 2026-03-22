package ai.openclaw.app.ui

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class GatewayConfigResolverTest {
  @Test
  fun parseGatewayEndpointUsesDefaultTlsPortForBareWssUrls() {
    val parsed = parseGatewayEndpoint("wss://gateway.example")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 443,
        tls = true,
        displayUrl = "https://gateway.example",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointUsesDefaultCleartextPortForBareWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.example")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 80,
        tls = false,
        displayUrl = "http://gateway.example",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointOmitsExplicitDefaultTlsPortFromDisplayUrl() {
    val parsed = parseGatewayEndpoint("https://gateway.example:443")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 443,
        tls = true,
        displayUrl = "https://gateway.example",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointKeepsExplicitNonDefaultPortInDisplayUrl() {
    val parsed = parseGatewayEndpoint("http://gateway.example:8080")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.example",
        port = 8080,
        tls = false,
        displayUrl = "http://gateway.example:8080",
      ),
      parsed,
    )
  }

  @Test
  fun resolveScannedSetupCodeAcceptsRawSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCode(setupCode)

    assertEquals(setupCode, resolved)
  }

  @Test
  fun resolveScannedSetupCodeAcceptsQrJsonPayload() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")
    val qrJson =
      """
      {
        "setupCode": "$setupCode",
        "gatewayUrl": "wss://gateway.example:18789",
        "auth": "password",
        "urlSource": "gateway.remote.url"
      }
      """.trimIndent()

    val resolved = resolveScannedSetupCode(qrJson)

    assertEquals(setupCode, resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsInvalidInput() {
    val resolved = resolveScannedSetupCode("not-a-valid-setup-code")
    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsJsonWithInvalidSetupCode() {
    val qrJson = """{"setupCode":"invalid"}"""
    val resolved = resolveScannedSetupCode(qrJson)
    assertNull(resolved)
  }

  @Test
  fun resolveScannedSetupCodeRejectsJsonWithNonStringSetupCode() {
    val qrJson = """{"setupCode":{"nested":"value"}}"""
    val resolved = resolveScannedSetupCode(qrJson)
    assertNull(resolved)
  }

  @Test
  fun decodeGatewaySetupCodeParsesBootstrapToken() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val decoded = decodeGatewaySetupCode(setupCode)

    assertEquals("wss://gateway.example:18789", decoded?.url)
    assertEquals("bootstrap-1", decoded?.bootstrapToken)
    assertNull(decoded?.token)
    assertNull(decoded?.password)
  }

  @Test
  fun resolveGatewayConnectConfigPrefersBootstrapTokenFromSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        manualHost = "",
        manualPort = "",
        manualTls = true,
        fallbackToken = "shared-token",
        fallbackPassword = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertNull(resolved?.token?.takeIf { it.isNotEmpty() })
    assertNull(resolved?.password?.takeIf { it.isNotEmpty() })
  }

  @Test
  fun resolveGatewayConnectConfigDefaultsPortlessWssSetupCodeTo443() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        manualHost = "",
        manualPort = "",
        manualTls = true,
        fallbackToken = "shared-token",
        fallbackPassword = "shared-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertNull(resolved?.token?.takeIf { it.isNotEmpty() })
    assertNull(resolved?.password?.takeIf { it.isNotEmpty() })
  }

  private fun encodeSetupCode(payloadJson: String): String {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
  }
}
