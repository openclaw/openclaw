package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayCustomHeadersInputTest {
  private val first = "manual|gateway.example|18789"

  @Test
  fun rotatingOneHeaderKeepsTheOthersSaved() {
    val input = GatewayCustomHeadersInput()
    input.name = "CF-Access-Client-Id"
    input.value = "synthetic-client-id"
    input.add()
    input.name = "CF-Access-Client-Secret"
    input.value = "synthetic-client-secret"
    input.markSaved(first, input.forConnect(first))

    input.name = "CF-Access-Client-Secret"
    input.value = "rotated-client-secret"
    val rotated = input.forConnect(first)
    assertEquals(mapOf("CF-Access-Client-Secret" to "rotated-client-secret"), rotated)
    input.markSaved(first, rotated)
    // The Client ID saved by the first connect stays saved, not pending again.
    assertEquals(emptyMap<String, String>(), input.rowsFor(first))
  }

  @Test
  fun addingASavedValueAgainSendsIt() {
    val input = GatewayCustomHeadersInput()
    input.name = "CF-Access-Client-Secret"
    input.value = "synthetic-client-secret"
    input.markSaved(first, input.forConnect(first))

    // The saved header was removed from the list; re-entering the same value must reach the next connect.
    input.name = "CF-Access-Client-Secret"
    input.value = "synthetic-client-secret"
    assertEquals(mapOf("CF-Access-Client-Secret" to "synthetic-client-secret"), input.forConnect(first))
  }
}
