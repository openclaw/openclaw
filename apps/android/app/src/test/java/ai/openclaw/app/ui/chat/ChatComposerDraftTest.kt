package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatComposerDraftTest {
  @Test
  fun clearsLastAppliedDraftWhenViewModelDraftResets() {
    val consumed =
      applyDraftText(
        draftText = "repeat this",
        currentInput = "",
        lastAppliedDraft = null,
      )

    assertTrue(consumed.consumed)
    assertEquals("repeat this", consumed.input)
    assertEquals("repeat this", consumed.lastAppliedDraft)

    val cleared =
      applyDraftText(
        draftText = null,
        currentInput = consumed.input,
        lastAppliedDraft = consumed.lastAppliedDraft,
      )

    assertFalse(cleared.consumed)
    assertEquals("repeat this", cleared.input)
    assertEquals(null, cleared.lastAppliedDraft)

    val repeated =
      applyDraftText(
        draftText = "repeat this",
        currentInput = cleared.input,
        lastAppliedDraft = cleared.lastAppliedDraft,
      )

    assertTrue(repeated.consumed)
    assertEquals("repeat this", repeated.input)
    assertEquals("repeat this", repeated.lastAppliedDraft)
  }
}
