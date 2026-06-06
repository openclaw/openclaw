package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class TalkPromptBuilderTest {
  @Test
  fun buildsTranscriptOnlyPrompt() {
    assertEquals("Hello", TalkPromptBuilder.build("Hello"))
  }

  @Test
  fun includesInterruptionLineWhenProvided() {
    assertEquals(
      "Assistant speech interrupted at 1.2s.\n\nHi",
      TalkPromptBuilder.build("Hi", interruptedAtSeconds = 1.234),
    )
  }

  @Test
  fun doesNotInjectTalkModeInstructions() {
    val prompt = TalkPromptBuilder.build("Hello")

    assertFalse(prompt.contains("Talk Mode active."))
    assertFalse(prompt.contains("ElevenLabs voice"))
  }
}
