package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelCatalogRequestTest {
  @Test
  fun providerCardsRetainCredentialOwnershipAndProviderUsage() {
    val providers =
      parseGatewayModelProviders(
        Json
          .parseToJsonElement(
            """[
            {"provider":"mixed","displayName":"Mixed","status":"ok","apiKey":{"source":"config"},"profiles":[
              {"profileId":"mixed:account","type":"oauth","source":"external","logoutSupported":false},
              {"profileId":"mixed:token","type":"token","source":"saved","logoutSupported":true},
              {"profileId":"mixed:key","type":"api_key","source":"saved","logoutSupported":true}
            ],"usage":{"providerId":"canonical","plan":"Pro","summary":"Weekly quota","windows":[{"label":"Week","groupLabel":"Account","usedPercent":25,"resetAt":42}],"billing":[{"type":"balance","amount":12,"unit":"USD"},{"type":"budget","used":3,"limit":10,"unit":"USD","period":"month"}]}},
            {"provider":"environment","status":"static","apiKey":{"source":"env","envVar":"FIXTURE_API_KEY"},"profiles":[]},
            {"provider":"stored","status":"static","profiles":[{"profileId":"stored:key","type":"api_key","source":"saved","logoutSupported":true}]},
            {"provider":"inherited","status":"static","profiles":[{"profileId":"inherited:key","type":"api_key","source":"inherited","logoutSupported":false}]}
          ]""",
          ).jsonArray,
      )
    val mixed = providers.first()
    assertEquals(listOf("oauth", "token", "api_key"), mixed.profiles.map { it.type })
    assertEquals(listOf("external", "saved", "saved"), mixed.profiles.map { it.source })
    assertEquals("config", mixed.apiKeySource)
    assertEquals(listOf(true, false, true, false), providers.map { it.canRemoveApiKey })
    assertTrue(providers.all { it.hasApiKey })
    assertEquals("FIXTURE_API_KEY", providers[1].apiKeyEnvVar)
    val usage = checkNotNull(mixed.usage)
    assertEquals("canonical", usage.providerId)
    assertEquals("Pro", usage.plan)
    assertEquals("Weekly quota", usage.summary)
    assertEquals(GatewayUsageWindowSummary("Week", 25.0, 42L, "Account"), usage.windows.single())
    assertEquals(GatewayUsageBilling("balance", "USD", amount = 12.0), usage.billing.first())
    assertEquals(GatewayUsageBilling("budget", "USD", used = 3.0, limit = 10.0, period = "month"), usage.billing.last())
  }

  @Test
  fun catalogRetainsProviderAndProfileReadinessSeparatelyFromAvailableModels() {
    val catalog =
      parseGatewayModelCatalog(
        Json
          .parseToJsonElement(
            """{"models":[{"id":"listed","name":"Listed","provider":"fixture","available":true}],"providerOutcomes":[{"provider":"fixture","status":"unavailable"},{"provider":"fixture","profileId":"fixture:account","status":"ready"}],"pendingProviders":["pending"]}""",
          ).jsonObject,
      )

    assertTrue(catalog.models.single().available == true)
    assertFalse(catalog.refreshFailed)
    assertEquals(
      listOf(GatewayModelProviderOutcome("fixture", null, "unavailable"), GatewayModelProviderOutcome("fixture", "fixture:account", "ready")),
      catalog.providerOutcomes,
    )
    assertEquals(setOf("pending"), catalog.pendingProviders)
    assertTrue(parseGatewayModelCatalog(Json.parseToJsonElement("""{"models":[]}""").jsonObject).providerOutcomes.isEmpty())
  }

  @Test
  fun providerAuthProjectionOnlyReportsOwnerConfirmedRenewalFailure() {
    val payload =
      Json
        .parseToJsonElement(
          """[
        {"provider":"expired","status":"expired","profiles":[{"profileId":"expired:main","type":"oauth","status":"expired"}]},
        {"provider":"pending","status":"expired","profiles":[{"profileId":"pending:main","type":"oauth","status":"expired","reasonCode":"expired"}]},
        {"provider":"failed","status":"expired","profiles":[{"profileId":"failed:main","type":"oauth","status":"expired","renewalFailed":true}]},
        {"provider":"excluded","status":"ok","profileOrder":["excluded:active"],"profiles":[{"profileId":"excluded:inactive","type":"oauth","renewalFailed":true},{"profileId":"excluded:active","type":"api_key","status":"static"}]},
        {"provider":"healthy-sibling","status":"ok","profiles":[{"profileId":"healthy-sibling:failed","type":"oauth","renewalFailed":true},{"profileId":"healthy-sibling:active","type":"oauth","status":"ok"}]},
        {"provider":"alias","authProvider":"canonical","status":"static","apiKey":{"configured":true},"profiles":[]}
      ]""",
        ).jsonArray
    val providers = parseGatewayModelProviders(payload)

    assertEquals(listOf(false, false, true, false, false, false), providers.map { it.renewalFailed })
    assertEquals(listOf("oauth", "oauth", "oauth", "api_key", "oauth", "api_key"), providers.map { it.authType })
    assertEquals("canonical", providers.last().authProviderId)
  }

  @Test
  fun prefersEffectiveContextCapOverNativeWindow() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[{"id":"model","name":"Model","provider":"example","contextWindow":128000,"contextTokens":96000}]""",
          ).jsonArray,
      )

    assertEquals(96_000L, models.single().contextTokens)
  }

  @Test
  fun preservesKnownAvailabilityReasonsAndFailsOpenForUnknownReasons() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """
            [
              {"id":"missing","name":"Missing","provider":"synthetic","available":false,"unavailableReason":"missing-auth"},
              {"id":"failed","name":"Failed","provider":"synthetic","available":false,"unavailableReason":"auth-failed"},
              {"id":"cooling","name":"Cooling","provider":"synthetic","available":false,"unavailableReason":"cooldown"},
              {"id":"future","name":"Future","provider":"synthetic","available":false,"unavailableReason":"future-reason"}
            ]
            """.trimIndent(),
          ).jsonArray,
      )

    assertEquals(GatewayModelUnavailableReason.MissingAuth, models[0].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.AuthFailed, models[1].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.Cooldown, models[2].unavailableReason)
    assertEquals(null, models[3].unavailableReason)
  }

  @Test
  fun reportsProviderConfigUnsupportedWithoutSubstitutingConfiguredView() =
    runBlocking {
      val requests = mutableListOf<String>()
      var actual: Throwable? = null

      try {
        requestProviderModelConfig(agentId = "beta", refresh = true) { paramsJson ->
          requests += paramsJson
          throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unsupported view"))
        }
      } catch (err: Throwable) {
        actual = err
      }

      assertTrue(actual is ProviderModelConfigUnsupported)
      assertEquals(
        listOf(Json.parseToJsonElement("""{"view":"provider-config","includeDefaultModels":true,"agentId":"beta","refresh":true}""")),
        requests.map(Json::parseToJsonElement),
      )
    }

  @Test
  fun preservesNonCompatibilityGatewayFailures() =
    runBlocking {
      val expected = GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "gateway busy"))
      var actual: Throwable? = null

      try {
        requestProviderModelConfig(agentId = "beta") { throw expected }
      } catch (err: Throwable) {
        actual = err
      }

      assertSame(expected, actual)
    }
}
