package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayModelCatalogTest {
  @Test
  fun latestStableCatalogWithoutAcquisitionDiagnosticsRemainsUsable() {
    // Captured from 2026.11.1 (4ffdd20) models.list with a task-owned Ollama fixture.
    val payload =
      requireNotNull(javaClass.getResourceAsStream("/model-catalog-2026.11.1.json"))
        .bufferedReader()
        .use { it.readText() }
    val catalog = parseGatewayModelCatalog(Json.parseToJsonElement(payload).jsonObject)
    assertEquals(listOf("fixture:latest"), catalog.models.map { it.id })
    assertTrue(catalog.models.single().available == true)
    assertFalse(catalog.refreshFailed)
    assertFalse(catalog.hasPendingProviders)
    assertFalse(catalog.nativeRefreshFailed)
    assertTrue(catalog.failedProviders.isEmpty())
  }

  @Test
  fun retainedCatalogWithoutDiagnosticsKeepsFailureAndEveryModel() {
    val models = (1..149).joinToString(",") { """{"id":"fixture-$it","name":"Fixture $it","provider":"fixture","available":true}""" }
    val catalog = parseGatewayModelCatalog(Json.parseToJsonElement("""{"models":[$models],"refreshFailed":true}""").jsonObject)
    assertEquals(149, catalog.models.size)
    assertTrue(catalog.models.all { it.available == true })
    assertTrue(catalog.refreshFailed)
    assertTrue(catalog.failedProviders.isEmpty())
  }

  @Test
  fun diagnosticsReadOnlySafeProviderIdsAndNativeScope() {
    val catalog =
      parseGatewayModelCatalog(
        Json
          .parseToJsonElement(
            """
            {
              "models":[],
              "refreshFailed":true,
              "refreshFailures":[
                {"acquisition":"provider","provider":"fixture","error":"private error"},
                {"acquisition":"native"},
                {"acquisition":"provider","provider":"https://private.invalid"},
                null
              ],
              "providerOutcomes":[
                {"provider":"fixture","status":"unavailable","profileId":"private-account"},
                {"provider":"sibling","status":"unavailable"},
                {"provider":"rejected","status":"auth-rejected"},
                {"provider":"ready","status":"ready"}
              ]
            }
            """.trimIndent(),
          ).jsonObject,
      )
    assertEquals(listOf("fixture"), catalog.failedProviders)
    assertTrue(catalog.nativeRefreshFailed)
    assertTrue(catalog.refreshFailed)
  }

  @Test
  fun legacyOutcomesCannotNameProvidersOutsideTheReturnedCatalog() {
    val catalog =
      parseGatewayModelCatalog(
        Json
          .parseToJsonElement(
            """
            {
              "models":[{"id":"fixture-model","name":"Fixture","provider":"fixture"}],
              "refreshFailed":true,
              "providerOutcomes":[
                {"provider":"fixture","status":"unavailable"},
                {"provider":"hidden","status":"unavailable"}
              ]
            }
            """.trimIndent(),
          ).jsonObject,
      )
    assertEquals(listOf("fixture"), catalog.failedProviders)
  }
}
