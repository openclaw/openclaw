package ai.openclaw.android.ui

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayConfigResolverTest {
  @Test
  fun resolveScannedSetupCodeAcceptsRawSetupCode() {
    val setupCode = encodeSetupCode("""{"url":"wss://gateway.example:18789","token":"token-1"}""")

    val resolved = resolveScannedSetupCode(setupCode)

    assertEquals(setupCode, resolved)
  }

  @Test
  fun decodeGatewaySetupCodeAcceptsCurrentBootstrapTokenPayload() {
    val setupCode = encodeSetupCode("""{"url":"ws://192.168.0.202:18789","bootstrapToken":"boot-123"}""")

    val decoded = decodeGatewaySetupCode(setupCode)

    assertEquals("ws://192.168.0.202:18789", decoded?.url)
    assertEquals("boot-123", decoded?.bootstrapToken)
    assertNull(decoded?.token)
  }

  @Test
  fun resolveScannedSetupCodeAcceptsQrJsonPayload() {
    val setupCode = encodeSetupCode("""{"url":"wss://gateway.example:18789","password":"pw-1"}""")
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

  private fun encodeSetupCode(payloadJson: String): String {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
  }
}
