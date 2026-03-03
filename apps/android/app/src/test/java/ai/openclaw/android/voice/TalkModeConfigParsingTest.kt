package ai.openclaw.android.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkModeConfigParsingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun prefersNormalizedTalkProviderPayload() {
    val talk =
      json.parseToJsonElement(
          """
          {
            "provider": "elevenlabs",
            "providers": {
              "elevenlabs": {
                "voiceId": "voice-normalized"
              }
            },
            "voiceId": "voice-legacy"
          }
          """.trimIndent(),
        )
        .jsonObject

    val selection = TalkModeManager.selectTalkProviderConfig(talk)
    assertNotNull(selection)
    assertEquals("elevenlabs", selection?.provider)
    assertTrue(selection?.normalizedPayload == true)
    assertEquals("voice-normalized", selection?.config?.get("voiceId")?.jsonPrimitive?.content)
  }

  @Test
  fun fallsBackToLegacyTalkFieldsWhenNormalizedPayloadMissing() {
    val talk =
      json.parseToJsonElement(
          """
          {
            "voiceId": "voice-legacy",
            "apiKey": "legacy-key"
          }
          """.trimIndent(),
        )
        .jsonObject

    val selection = TalkModeManager.selectTalkProviderConfig(talk)
    assertNotNull(selection)
    assertEquals("elevenlabs", selection?.provider)
    assertTrue(selection?.normalizedPayload == false)
    assertEquals("voice-legacy", selection?.config?.get("voiceId")?.jsonPrimitive?.content)
    assertEquals("legacy-key", selection?.config?.get("apiKey")?.jsonPrimitive?.content)
  }
}
