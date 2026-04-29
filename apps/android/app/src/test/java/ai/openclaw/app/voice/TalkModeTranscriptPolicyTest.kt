package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TalkModeTranscriptPolicyTest {
  @Test
  fun continuousModeUsesWholeTranscript() {
    assertEquals(
      "hello Nemo",
      TalkModeTranscriptPolicy.resolveCommand(
        transcript = " hello Nemo ",
        requireWakeWord = false,
        wakeWords = listOf("NemoNemo"),
      ),
    )
  }

  @Test
  fun wakeModeUsesOnlyCommandAfterWakeWord() {
    assertEquals(
      "look around",
      TalkModeTranscriptPolicy.resolveCommand(
        transcript = "Nemo Nemo look around",
        requireWakeWord = true,
        wakeWords = listOf("NemoNemo"),
      ),
    )
  }

  @Test
  fun wakeModeIgnoresSpeechWithoutWakeWord() {
    assertNull(
      TalkModeTranscriptPolicy.resolveCommand(
        transcript = "look around",
        requireWakeWord = true,
        wakeWords = listOf("NemoNemo"),
      ),
    )
  }
}
