package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceWakeCommandExtractorTest {
  @Test
  fun extractsCommandAfterTriggerWord() {
    val res = VoiceWakeCommandExtractor.extractCommand("Claude take a photo", listOf("openclaw", "claude"))
    assertEquals("take a photo", res)
  }

  @Test
  fun extractsCommandWhenRepeatedWakeWordIsSeparatedBySpeechRecognizer() {
    val res = VoiceWakeCommandExtractor.extractCommand("Nemo Nemo take a photo", listOf("NemoNemo"))
    assertEquals("take a photo", res)
  }

  @Test
  fun extractsCommandWhenNemoWakeWordIsMisheardSlightly() {
    assertEquals(
      "say hello",
      VoiceWakeCommandExtractor.extractCommand("Memo memo say hello", listOf("NemoNemo")),
    )
    assertEquals(
      "say hello",
      VoiceWakeCommandExtractor.extractCommand("Neemo Neemo say hello", listOf("NemoNemo")),
    )
  }

  @Test
  fun extractsCommandWithPunctuation() {
    val res = VoiceWakeCommandExtractor.extractCommand("hey openclaw, what's the weather?", listOf("openclaw"))
    assertEquals("what's the weather?", res)
  }

  @Test
  fun returnsNullWhenNoCommandProvided() {
    assertNull(VoiceWakeCommandExtractor.extractCommand("claude", listOf("claude")))
    assertNull(VoiceWakeCommandExtractor.extractCommand("hey claude!", listOf("claude")))
  }
}
