package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

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
  fun parseGatewayEndpointRejectsNonLoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.example")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsTailnetCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://100.64.0.9:18789")

    assertNull(parsed)
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
  fun parseGatewayEndpointAllowsLoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://127.0.0.1")

    assertEquals(
      GatewayEndpointConfig(
        host = "127.0.0.1",
        port = 18789,
        tls = false,
        displayUrl = "http://127.0.0.1:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsLocalhostCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://localhost:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "localhost",
        port = 18789,
        tls = false,
        displayUrl = "http://localhost:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsAndroidEmulatorCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://10.0.2.2:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "10.0.2.2",
        port = 18789,
        tls = false,
        displayUrl = "http://10.0.2.2:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsPrivateLanCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://192.168.1.20:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "192.168.1.20",
        port = 18789,
        tls = false,
        displayUrl = "http://192.168.1.20:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsMdnsCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://gateway.local:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.local",
        port = 18789,
        tls = false,
        displayUrl = "http://gateway.local:18789",
      ),
      parsed,
    )
  }

  @Test
  fun parseGatewayEndpointAllowsNormalizedMdnsCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://GATEWAY.LOCAL.:18789")

    assertEquals("GATEWAY.LOCAL.", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
  }

  @Test
  fun parseGatewayEndpointRejectsMdnsSuffixAndLabelBypasses() {
    val rejected =
      listOf(
        "ws://gateway.local.evil.com:18789",
        "ws://gatewaylocal:18789",
        "ws://local:18789",
        "ws://.local:18789",
        "ws://gateway..local:18789",
        "ws://gateway.local%25wlan0:18789",
      )

    for (url in rejected) {
      assertNull(url, parseGatewayEndpoint(url))
    }
  }

  @Test
  fun parseGatewayEndpointAllowsIpv6LoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::1]")

    assertEquals("::1", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
    assertEquals("http://[::1]:18789", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointAllowsIpv4MappedIpv6LoopbackCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::ffff:127.0.0.1]")

    assertEquals("::ffff:127.0.0.1", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
    assertEquals("http://[::ffff:127.0.0.1]:18789", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointRejectsCleartextLoopbackPrefixBypassHost() {
    val parsed = parseGatewayEndpoint("http://127.attacker.example:80")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsNonLoopbackIpv6CleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[2001:db8::1]")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointAllowsLinkLocalIpv6ZoneCleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[fe80::1%25eth0]")

    assertEquals("fe80::1%25eth0", parsed?.host)
    assertEquals(18789, parsed?.port)
    assertEquals(false, parsed?.tls)
    assertEquals("http://[fe80::1%25eth0]:18789", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointAllowsSecureIpv6ZoneUrls() {
    val parsed = parseGatewayEndpoint("wss://[fe80::1%25wlan0]:443")

    assertEquals("fe80::1%25wlan0", parsed?.host)
    assertEquals(443, parsed?.port)
    assertEquals(true, parsed?.tls)
    assertEquals("https://[fe80::1%25wlan0]", parsed?.displayUrl)
  }

  @Test
  fun parseGatewayEndpointRejectsUnspecifiedIpv4CleartextHttpUrls() {
    val parsed = parseGatewayEndpoint("http://0.0.0.0:80")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointRejectsUnspecifiedIpv6CleartextWsUrls() {
    val parsed = parseGatewayEndpoint("ws://[::]")

    assertNull(parsed)
  }

  @Test
  fun parseGatewayEndpointAllowsLoopbackCleartextHttpUrls() {
    val parsed = parseGatewayEndpoint("http://localhost:80")

    assertEquals(
      GatewayEndpointConfig(
        host = "localhost",
        port = 80,
        tls = false,
        displayUrl = "http://localhost:80",
      ),
      parsed,
    )
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsRawSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsQrJsonPayload() {
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

    val resolved = resolveScannedSetupCodeResult(qrJson)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsInvalidInput() {
    val resolved = resolveScannedSetupCodeResult("not-a-valid-setup-code")
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithInvalidSetupCode() {
    val qrJson = """{"setupCode":"invalid"}"""
    val resolved = resolveScannedSetupCodeResult(qrJson)
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsJsonWithNonStringSetupCode() {
    val qrJson = """{"setupCode":{"nested":"value"}}"""
    val resolved = resolveScannedSetupCodeResult(qrJson)
    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultRejectsNonLoopbackCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://attacker.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsPrivateLanCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://192.168.31.100:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultAcceptsMdnsCleartextGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://gateway.local:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertEquals(setupCode, resolved.setupCode)
    assertNull(resolved.error)
  }

  @Test
  fun resolveScannedSetupCodeResultFlagsInsecureRemoteGateway() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://attacker.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved = resolveScannedSetupCodeResult(setupCode)

    assertNull(resolved.setupCode)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, resolved.error)
  }

  @Test
  fun parseGatewayEndpointResultFlagsInsecureRemoteGateway() {
    val parsed = parseGatewayEndpointResult("ws://gateway.example:18789")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultRejectsUnsupportedSchemes() {
    val parsed = parseGatewayEndpointResult("ftp://gateway.example:21")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultRejectsInvalidExplicitPort() {
    val parsed = parseGatewayEndpointResult("wss://gateway.example:70000")

    assertNull(parsed.config)
    assertEquals(GatewayEndpointValidationError.INVALID_URL, parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultAllowsPrivateLanCleartextGateway() {
    val parsed = parseGatewayEndpointResult("ws://192.168.1.20:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "192.168.1.20",
        port = 18789,
        tls = false,
        displayUrl = "http://192.168.1.20:18789",
      ),
      parsed.config,
    )
    assertNull(parsed.error)
  }

  @Test
  fun parseGatewayEndpointResultAllowsMdnsCleartextGateway() {
    val parsed = parseGatewayEndpointResult("ws://gateway.local:18789")

    assertEquals(
      GatewayEndpointConfig(
        host = "gateway.local",
        port = 18789,
        tls = false,
        displayUrl = "http://gateway.local:18789",
      ),
      parsed.config,
    )
    assertNull(parsed.error)
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
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
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
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
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

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsCleartextSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://gateway.local:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = true,
        setupCode = setupCode,
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "",
        manualPortInput = "",
        manualTlsInput = false,
        fallbackBootstrapToken = "",
        fallbackToken = "shared-token",
        fallbackPassword = "shared-password",
      )

    assertEquals("gateway.local", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertNull(resolved?.token?.takeIf { it.isNotEmpty() })
    assertNull(resolved?.password?.takeIf { it.isNotEmpty() })
  }

  @Test
  fun resolveGatewayConnectConfigManualPreservesBootstrapTokenWhenNoReplacementAuthExists() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("127.0.0.1", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigManualDropsBootstrapTokenWhenReplacementPasswordExists() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.1",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "password-1",
      )

    assertEquals("", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("password-1", resolved?.password)
  }

  @Test
  fun resolveGatewayConnectConfigManualDropsBootstrapTokenWhenEndpointChanges() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHostInput = "127.0.0.2",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("", resolved?.bootstrapToken)
    assertEquals("127.0.0.2", resolved?.host)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsPrivateLanManualCleartextEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "192.168.31.100",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("192.168.31.100", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun resolveGatewayConnectConfigAllowsMdnsManualCleartextEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "gateway.local",
        manualPortInput = "18789",
        manualTlsInput = false,
        fallbackBootstrapToken = "bootstrap-1",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("gateway.local", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun composeGatewayManualUrlRejectsBareScheme() {
    assertNull(composeGatewayManualUrl("ws://", "18789", tls = false))
  }

  @Test
  fun composeGatewayManualUrlPreservesCompleteEndpoint() {
    val cleartextUrl = composeGatewayManualUrl("ws://192.168.178.57:18790", "18789", tls = true)
    val tlsUrl = composeGatewayManualUrl("wss://gateway.example:443", "18789", tls = false)

    assertEquals("ws://192.168.178.57:18790", cleartextUrl)
    assertEquals("wss://gateway.example:443", tlsUrl)
    assertEquals("http://192.168.178.57:18790", parseGatewayEndpoint(cleartextUrl!!)?.displayUrl)
    assertEquals("https://gateway.example", parseGatewayEndpoint(tlsUrl!!)?.displayUrl)
  }

  @Test
  fun composeGatewayManualUrlPreservesCompleteEndpointValidationError() {
    val url = composeGatewayManualUrl("ws://gateway.example:18789", "18789", tls = false)

    assertEquals(GatewayEndpointValidationError.INSECURE_REMOTE_URL, parseGatewayEndpointResult(url!!).error)
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsCompleteLanEndpoint() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = false,
        manualHostInput = "ws://192.168.178.57:18790",
        manualPortInput = "18789",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("192.168.178.57", resolved?.host)
    assertEquals(18790, resolved?.port)
    assertEquals(false, resolved?.tls)
  }

  @Test
  fun composeGatewayManualUrlPreservesIpv6Hosts() {
    for (hostInput in listOf("::1", "[::1]")) {
      assertEquals("http://[::1]:18789", composeGatewayManualUrl(hostInput, "18789", tls = false))
    }
  }

  @Test
  fun composeGatewayManualUrlTrimsTrailingSlashFromBareHost() {
    assertEquals(
      "http://192.168.1.20:20000",
      composeGatewayManualUrl("192.168.1.20/", "20000", tls = false),
    )
  }

  @Test
  fun composeGatewayManualUrlDefaultsPortTo443WhenTlsAndPortBlank() {
    val url = composeGatewayManualUrl("mydevice.tail1234.ts.net", "", tls = true)

    assertEquals("https://mydevice.tail1234.ts.net:443", url)
  }

  @Test
  fun composeGatewayManualUrlRejectsBlankPortWhenTlsIsOff() {
    val url = composeGatewayManualUrl("127.0.0.1", "", tls = false)

    assertNull(url)
  }

  @Test
  fun composeGatewayManualUrl_bracketsIpv6ForEndpointParsing() {
    for (hostInput in listOf("::1", "[::1]")) {
      val url = composeGatewayManualUrl(hostInput, "18789", tls = false)

      assertEquals("http://[::1]:18789", url)
      assertEquals(
        GatewayEndpointConfig(
          host = "::1",
          port = 18789,
          tls = false,
          displayUrl = "http://[::1]:18789",
        ),
        parseGatewayEndpoint(url!!),
      )
    }
  }

  @Test
  fun resolveGatewayConnectConfigManualAcceptsTailscaleHostWithoutPort() {
    val resolved =
      resolveGatewayConnectConfig(
        useSetupCode = false,
        setupCode = "",
        savedManualHost = "",
        savedManualPort = "",
        savedManualTls = true,
        manualHostInput = "mydevice.tail1234.ts.net",
        manualPortInput = "",
        manualTlsInput = true,
        fallbackBootstrapToken = "",
        fallbackToken = "",
        fallbackPassword = "",
      )

    assertEquals("mydevice.tail1234.ts.net", resolved?.host)
    assertEquals(443, resolved?.port)
    assertEquals(true, resolved?.tls)
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
