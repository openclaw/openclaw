package ai.openclaw.app.voice

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

@Serializable
private data class TalkConfigContractFixture(
  val selectionCases: List<SelectionCase>,
  val timeoutCases: List<TimeoutCase>,
) {
  @Serializable
  data class SelectionCase(
    val id: String,
    val talk: JsonObject,
  )

  @Serializable
  data class TimeoutCase(
    val id: String,
    val fallback: Long,
    val expectedTimeoutMs: Long,
    val talk: JsonObject,
  )
}

class TalkModeConfigParsingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun readsMainSessionKeyAndInterruptFlag() {
    val config =
      json
        .parseToJsonElement(
          """
          {
            "talk": {
              "interruptOnSpeech": true,
              "speechLocale": "de_DE",
              "silenceTimeoutMs": 1800
            },
            "session": {
              "mainKey": "voice-main"
            }
          }
          """.trimIndent(),
        ).jsonObject

    val parsed = TalkModeGatewayConfigParser.parse(config)

    assertEquals("voice-main", parsed.mainSessionKey)
    assertEquals("de-DE", parsed.speechLocale)
    assertEquals(true, parsed.interruptOnSpeech)
    assertEquals(1800L, parsed.silenceTimeoutMs)
  }

  @Test
  fun selectionFixtures() {
    for (fixture in loadContractFixtures().selectionCases) {
      val parsed = parseTalkConfig(fixture.talk)

      assertNull("${fixture.id}: speechLocale", parsed.speechLocale)
      assertNull("${fixture.id}: interruptOnSpeech", parsed.interruptOnSpeech)
      assertEquals(
        "${fixture.id}: silenceTimeoutMs",
        TalkDefaults.defaultSilenceTimeoutMs,
        parsed.silenceTimeoutMs,
      )
    }
  }

  @Test
  fun timeoutFixtures() {
    for (fixture in loadContractFixtures().timeoutCases) {
      val parsed = parseTalkConfig(fixture.talk)

      assertNull("${fixture.id}: speechLocale", parsed.speechLocale)
      assertNull("${fixture.id}: interruptOnSpeech", parsed.interruptOnSpeech)
      assertEquals("${fixture.id}: fallback", fixture.fallback, TalkDefaults.defaultSilenceTimeoutMs)
      assertEquals("${fixture.id}: silenceTimeoutMs", fixture.expectedTimeoutMs, parsed.silenceTimeoutMs)
    }
  }

  @Test
  fun derivesRealtimeLanguageFromConfiguredLocale() {
    assertEquals("de", realtimeTranscriptionLanguage("de-DE"))
    assertEquals(null, realtimeTranscriptionLanguage("fil-PH"))
  }

  @Test
  fun readsGatewayTransportWithoutInferringFromModelNames() {
    for (model in listOf("gpt-live-1-codex", "gpt-realtime-2.1")) {
      val config = json.parseToJsonElement("""{"talk":{"realtime":{"model":"$model","transport":"webrtc"}}}""").jsonObject
      assertEquals("webrtc", TalkModeGatewayConfigParser.parse(config).realtimeTransport)
      assertNull(TalkModeGatewayConfigParser.parse(config).realtimeMode)
    }
  }

  @Test
  fun selectsOnlySupportedTransportsFromGatewayCapabilities() {
    fun catalog(transports: String) = json.parseToJsonElement("""{"realtime":{"activeProvider":"example","providers":[{"id":"example","transports":[$transports]}]}}""").jsonObject
    assertEquals("webrtc", resolveAndroidRealtimeTransport(null, catalog("\"webrtc\",\"gateway-relay\"")))
    assertEquals("gateway-relay", resolveAndroidRealtimeTransport(null, catalog("\"provider-websocket\",\"gateway-relay\"")))
    assertEquals("gateway-relay", resolveAndroidRealtimeTransport("provider-websocket", null))
    assertEquals("gateway-relay", resolveAndroidRealtimeTransport("gateway-relay", null))
    assertEquals("webrtc", resolveAndroidRealtimeTransport("webrtc", null))
    assertEquals(true, runCatching { resolveAndroidRealtimeTransport("managed-room", null) }.isFailure)
    assertEquals(true, runCatching { resolveAndroidRealtimeTransport(null, catalog("\"provider-websocket\"")) }.isFailure)
    assertEquals(true, runCatching { resolveAndroidRealtimeTransport(null, null) }.isFailure)
  }

  @Test
  fun resolvesRealtimeLanguageFromConfigThenWatchThenPhone() {
    assertEquals(
      "de",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = "de-DE",
        requestedLanguage = "en",
        deviceLocaleTag = "fr-FR",
      ),
    )
    assertEquals(
      "en",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = null,
        requestedLanguage = "en",
        deviceLocaleTag = "fr-FR",
      ),
    )
    assertEquals(
      "fr",
      resolveRealtimeTranscriptionLanguageHint(
        configuredLocaleTag = null,
        requestedLanguage = null,
        deviceLocaleTag = "fr-FR",
      ),
    )
  }

  @Test
  fun strictAuthFlagFollowsOnlyDeliberateProviderSelections() {
    assertFalse(parseTalkConfig(buildJsonObject { put("realtime", buildJsonObject {}) }).strictAuthSelected)
    assertFalse(
      parseTalkConfig(
        buildJsonObject {
          put("realtime", buildJsonObject { put("providers", buildJsonObject { put("openai", buildJsonObject { put("model", JsonPrimitive("gpt-realtime-2.1")) }) }) })
        },
      ).strictAuthSelected,
    )
    assertTrue(
      parseTalkConfig(
        buildJsonObject {
          put("realtime", buildJsonObject { put("providers", buildJsonObject { put("openai", buildJsonObject { put("authMethod", JsonPrimitive("oauth")) }) }) })
        },
      ).strictAuthSelected,
    )
  }

  private fun parseTalkConfig(talk: JsonObject): TalkModeGatewayConfigState = TalkModeGatewayConfigParser.parse(buildJsonObject { put("talk", talk) })

  private fun loadContractFixtures(): TalkConfigContractFixture = json.decodeFromString(findContractFixture().readText())

  private fun findContractFixture(): File {
    val startDir = System.getProperty("user.dir") ?: error("user.dir unavailable")
    var current = File(startDir).absoluteFile
    while (true) {
      val candidate = File(current, "test/fixtures/talk-config-contract.json")
      if (candidate.isFile) return candidate
      current = current.parentFile ?: break
    }
    error("test/fixtures/talk-config-contract.json not found from $startDir")
  }
}
