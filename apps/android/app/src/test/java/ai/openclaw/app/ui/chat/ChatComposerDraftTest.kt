package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatComposerDraftTest {
  @Test
  fun replyDraftPreservesExistingComposerText() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    assertEquals("> quoted\n\nmy reply", mergeChatDraft(draft, "my reply"))
  }

  @Test
  fun preservesReplySeparatorWhitespace() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    val applied =
      applyDraftText(
        draft = draft,
        currentInput = "",
        lastAppliedDraft = null,
      )

    assertEquals(draft.text, applied.input)
    assertEquals(draft.text, applied.lastAppliedDraft)
    assertTrue(applied.consumed)
  }

  @Test
  fun clearsLastAppliedDraftWhenViewModelDraftResets() {
    val consumed =
      applyDraftText(
        draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace),
        currentInput = "",
        lastAppliedDraft = null,
      )

    assertTrue(consumed.consumed)
    assertEquals("repeat this", consumed.input)
    assertEquals("repeat this", consumed.lastAppliedDraft)

    val cleared =
      applyDraftText(
        draft = null,
        currentInput = consumed.input,
        lastAppliedDraft = consumed.lastAppliedDraft,
      )

    assertFalse(cleared.consumed)
    assertEquals("repeat this", cleared.input)
    assertEquals(null, cleared.lastAppliedDraft)

    val repeated =
      applyDraftText(
        draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace),
        currentInput = cleared.input,
        lastAppliedDraft = cleared.lastAppliedDraft,
      )

    assertTrue(repeated.consumed)
    assertEquals("repeat this", repeated.input)
    assertEquals("repeat this", repeated.lastAppliedDraft)
  }
}
