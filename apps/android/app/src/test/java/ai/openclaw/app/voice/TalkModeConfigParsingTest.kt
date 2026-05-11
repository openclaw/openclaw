package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

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
              "silenceTimeoutMs": 1800,
              "conversationEngine": "local-thomas"
            },
            "session": {
              "mainKey": "voice-main"
            }
          }
          """.trimIndent(),
        ).jsonObject

    val parsed = TalkModeGatewayConfigParser.parse(config)

    assertEquals("voice-main", parsed.mainSessionKey)
    assertEquals(true, parsed.interruptOnSpeech)
    assertEquals(1800L, parsed.silenceTimeoutMs)
    assertEquals("local-thomas", parsed.conversationEngine)
  }

  @Test
  fun defaultsConversationEngineToDeluxeThomas() {
    assertEquals(
      "deluxe-thomas",
      TalkModeGatewayConfigParser.resolvedConversationEngine(null),
    )
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenMissing() {
    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(null),
    )
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenInvalid() {
    val talk = buildJsonObject { put("silenceTimeoutMs", 0) }

    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(talk),
    )
  }

  @Test
  fun defaultsSilenceTimeoutMsWhenString() {
    val talk = buildJsonObject { put("silenceTimeoutMs", "1500") }

    assertEquals(
      TalkDefaults.defaultSilenceTimeoutMs,
      TalkModeGatewayConfigParser.resolvedSilenceTimeoutMs(talk),
    )
  }
}
