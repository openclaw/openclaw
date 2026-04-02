package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class TalkPromptDisplayTest {
  @Test
  fun displayTextStripsTalkModePrefix() {
    val fullPrompt =
      """
      Talk Mode active. Reply in a concise, spoken tone.
      You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {"voice":"<id>","once":true}.

      Hello, can you hear me?
      """.trimIndent()
    val display = TalkPromptDisplay.displayTextFromPrompt(fullPrompt)
    assertEquals("Hello, can you hear me?", display)
    assertFalse(display.contains("Talk Mode active"))
    assertFalse(display.contains("ElevenLabs"))
  }

  @Test
  fun displayTextReturnsOriginalWhenNotTalkModePrompt() {
    val plain = "Just a normal user message."
    assertEquals(plain, TalkPromptDisplay.displayTextFromPrompt(plain))
  }

  @Test
  fun displayTextStripsSystemEventsBeforeTalkMode() {
    val prompt =
      """
      System: [2026-03-31 13:10:45 PDT] Node: Example · reason launch
      System: [2026-03-31 13:10:45 PDT] reason connect

      Talk Mode active. Reply in a concise, spoken tone.
      You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {"voice":"<id>","once":true}.

      Hey what's up?
      """.trimIndent()
    val display = TalkPromptDisplay.displayTextFromPrompt(prompt)
    assertEquals("Hey what's up?", display)
    assertFalse(display.contains("System:"))
    assertFalse(display.contains("Talk Mode active"))
  }
}
