package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayCustomHeadersTest {
  @Test
  fun credentialShapeRecognizesServiceTokenValuesTypedAsNames() {
    assertEquals(GatewayCustomHeaders.CredentialShape.CLIENT_ID, GatewayCustomHeaders.credentialShape(" 0123456789ABCDEF0123456789abcdef.access "))
    assertEquals(GatewayCustomHeaders.CredentialShape.SECRET, GatewayCustomHeaders.credentialShape("0123456789abcdef".repeat(4)))
    assertEquals(GatewayCustomHeaders.CredentialShape.SECRET, GatewayCustomHeaders.credentialShape("cfast_${"a1".repeat(24)}"))
    // Quotes, backticks, and sentence periods copied with a token are legal name characters.
    val clientId = "0123456789abcdef0123456789abcdef.access"
    for (copied in listOf("'$clientId'", "$clientId.", "`$clientId`")) {
      assertEquals(copied, GatewayCustomHeaders.CredentialShape.CLIENT_ID, GatewayCustomHeaders.credentialShape(copied))
    }
  }

  @Test
  fun credentialShapeLeavesHeaderNamesAlone() {
    for (name in listOf("CF-Access-Client-Id", "CF-Access-Client-Secret", "Authorization", "X-Api-Key", "gateway.example", "0123456789abcdef.access")) {
      assertNull(name, GatewayCustomHeaders.credentialShape(name))
    }
  }

  @Test
  fun sanitizedKeepsCredentialShapedNamesSoTheyCanBeFoundAndRemoved() {
    val saved = mapOf("0123456789abcdef0123456789abcdef.access" to "synthetic-secret")
    assertEquals(saved, GatewayCustomHeaders.sanitized(saved))
  }
}
