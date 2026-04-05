package ai.openclaw.app

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistantLaunchTest {
  @Test
  fun parsesAssistGestureIntent() {
    val parsed = parseAssistantLaunchIntent(Intent(Intent.ACTION_ASSIST))

    requireNotNull(parsed)
    assertEquals("assist", parsed.source)
    assertNull(parsed.prompt)
    assertFalse(parsed.autoSend)
  }

  @Test
  fun parsesAppActionPrompt() {
    val parsed =
      parseAssistantLaunchIntent(
        Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "  summarize my unread texts  "),
      )

    requireNotNull(parsed)
    assertEquals("app_action", parsed.source)
    assertEquals("summarize my unread texts", parsed.prompt)
    assertTrue(parsed.autoSend)
  }

  @Test
  fun trimsAndBoundsAppActionPrompt() {
    val oversized = "x".repeat(maxAssistantPromptChars + 123)
    val parsed =
      parseAssistantLaunchIntent(
        Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "  $oversized  "),
      )

    requireNotNull(parsed)
    assertEquals(maxAssistantPromptChars, parsed.prompt?.length)
    assertTrue(parsed.autoSend)
  }

  @Test
  fun consumesAssistantLaunchIntentAfterHandling() {
    val assist = Intent(Intent.ACTION_ASSIST)
    val appAction = Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "summarize mail")

    assertTrue(isRestoredAssistantLaunch(assist, assistantLaunchFingerprint(assist)))
    assertTrue(isRestoredAssistantLaunch(appAction, assistantLaunchFingerprint(appAction)))
  }

  @Test
  fun treatsFreshIdenticalPromptAsNewWhenNoRestoredFingerprintExists() {
    val intent = Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "summarize mail")

    assertFalse(isRestoredAssistantLaunch(intent, restoredFingerprint = null))
  }

  @Test
  fun ignoresUnrelatedIntents() {
    assertNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_VIEW)))
  }
}
