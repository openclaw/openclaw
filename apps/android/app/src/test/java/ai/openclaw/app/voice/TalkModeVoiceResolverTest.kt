package ai.openclaw.app.voice

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TalkModeVoiceResolverTest {
  @Test
  fun resolvesVoiceAliasCaseInsensitively() {
    val resolved =
      TalkModeVoiceResolver.resolveVoiceAlias(
        " Clawd ",
        mapOf("clawd" to "voice-123"),
      )

    assertEquals("voice-123", resolved)
  }

  @Test
  fun acceptsDirectVoiceIds() {
    val resolved = TalkModeVoiceResolver.resolveVoiceAlias("21m00Tcm4TlvDq8ikWAM", emptyMap())

    assertEquals("21m00Tcm4TlvDq8ikWAM", resolved)
  }

  @Test
  fun rejectsUnknownAliases() {
    val resolved = TalkModeVoiceResolver.resolveVoiceAlias("nickname", emptyMap())

    assertNull(resolved)
  }

  @Test
  fun reusesCachedFallbackVoiceBeforeFetchingCatalog() =
    runBlocking {
      var fetchCount = 0

      val resolved =
        TalkModeVoiceResolver.resolveVoiceId(
          preferred = null,
          fallbackVoiceId = "cached-voice",
          defaultVoiceId = null,
          currentVoiceId = null,
          voiceOverrideActive = false,
          listVoices = {
            fetchCount += 1
            emptyList()
          },
        )

      assertEquals("cached-voice", resolved.voiceId)
      assertEquals(0, fetchCount)
    }

  @Test
  fun seedsDefaultVoiceFromCatalogWhenNeeded() =
    runBlocking {
      val resolved =
        TalkModeVoiceResolver.resolveVoiceId(
          preferred = null,
          fallbackVoiceId = null,
          defaultVoiceId = null,
          currentVoiceId = null,
          voiceOverrideActive = false,
          listVoices = { listOf(ElevenLabsVoice("voice-1", "First")) },
        )

      assertEquals("voice-1", resolved.voiceId)
      assertEquals("voice-1", resolved.fallbackVoiceId)
      assertEquals("voice-1", resolved.defaultVoiceId)
      assertEquals("voice-1", resolved.currentVoiceId)
      assertEquals("First", resolved.selectedVoiceName)
    }

  @Test
  fun preservesCurrentVoiceWhenOverrideIsActive() =
    runBlocking {
      val resolved =
        TalkModeVoiceResolver.resolveVoiceId(
          preferred = null,
          fallbackVoiceId = null,
          defaultVoiceId = null,
          currentVoiceId = null,
          voiceOverrideActive = true,
          listVoices = { listOf(ElevenLabsVoice("voice-1", "First")) },
        )

      assertEquals("voice-1", resolved.voiceId)
      assertNull(resolved.currentVoiceId)
    }
}
