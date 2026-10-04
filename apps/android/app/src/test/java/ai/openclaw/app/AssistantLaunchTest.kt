package ai.openclaw.app

import android.content.Intent
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistantLaunchTest {
  @Test
  fun appActionsTargetInstalledPackageWithLiteralValues() {
    val application = RuntimeEnvironment.getApplication()
    var foundIntent = false
    application.resources.getXml(R.xml.shortcuts).use { parser ->
      while (parser.eventType != XmlPullParser.END_DOCUMENT) {
        if (parser.eventType == XmlPullParser.START_TAG && parser.name == "intent") {
          foundIntent = true
          val androidNamespace = "http://schemas.android.com/apk/res/android"
          assertEquals(
            "Google Play requires a literal targetPackage",
            0,
            parser.getAttributeResourceValue(androidNamespace, "targetPackage", 0),
          )
          assertEquals(application.packageName, parser.getAttributeValue(androidNamespace, "targetPackage"))
        }
        parser.next()
      }
    }
    assertTrue("Expected a packaged App Actions intent", foundIntent)
  }

  @Test
  fun parsesAssistGestureIntent() {
    val parsed = parseAssistantLaunchIntent(Intent(Intent.ACTION_ASSIST))

    requireNotNull(parsed)
    assertEquals("assist", parsed.source)
    assertNull(parsed.prompt)
    assertFalse(parsed.autoSend)
    assertTrue(parsed.startsTalk)
  }

  @Test
  fun assistantAndVoiceCommandResolveToTheSameExportedActivity() {
    val app = RuntimeEnvironment.getApplication()
    for (action in listOf(Intent.ACTION_ASSIST, Intent.ACTION_VOICE_COMMAND)) {
      val intent = Intent(action).addCategory(Intent.CATEGORY_DEFAULT).setPackage(app.packageName)
      val resolved = requireNotNull(app.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY))
      assertEquals(MainActivity::class.java.name, resolved.activityInfo.name)
      assertTrue(resolved.activityInfo.exported)
    }
  }

  @Test
  fun voiceCommandUsesTheSameTalkLaunchAsAssist() {
    val voiceCommand = requireNotNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_VOICE_COMMAND)))
    assertEquals(parseAssistantLaunchIntent(Intent(Intent.ACTION_ASSIST)), voiceCommand)
    assertTrue(voiceCommand.startsTalk)
    assertFalse(voiceCommand.autoSend)
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
    assertFalse(parsed.autoSend)
    assertFalse(parsed.startsTalk)
  }

  @Test
  fun assistWithPromptRetainsDraftBehavior() {
    val parsed = requireNotNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_ASSIST).putExtra(extraAssistantPrompt, "  hello  ")))
    assertEquals("hello", parsed.prompt)
    assertFalse(parsed.startsTalk)
    assertFalse(parsed.autoSend)
  }

  @Test
  fun emptyAppActionIsNotASystemVoiceRequest() {
    val parsed = requireNotNull(parseAssistantLaunchIntent(Intent(actionAskOpenClaw).putExtra(extraAssistantPrompt, "  ")))
    assertNull(parsed.prompt)
    assertFalse(parsed.startsTalk)
  }

  @Test
  fun restoredVoiceLaunchKeepsItsOriginalExpiryAndRejectsClockRollback() {
    val expiry = 20_000L
    assertEquals(5_000L, remainingAssistantTalkStartWindow(expiry, nowMillis = 15_000L))
    assertEquals(0L, remainingAssistantTalkStartWindow(expiry, nowMillis = expiry))
    assertEquals(0L, remainingAssistantTalkStartWindow(expiry, nowMillis = expiry + 600_000L))
    assertEquals(0L, remainingAssistantTalkStartWindow(expiry, nowMillis = 0L))
  }

  @Test
  fun ignoresUnrelatedIntents() {
    assertNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_VIEW)))
    assertNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_MAIN)))
    assertNull(parseAssistantLaunchIntent(null))
  }
}
