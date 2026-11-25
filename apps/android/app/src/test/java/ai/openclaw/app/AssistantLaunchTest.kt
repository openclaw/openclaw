package ai.openclaw.app

import android.content.Intent
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
  }

  @Test
  fun ignoresUnrelatedIntents() {
    assertNull(parseAssistantLaunchIntent(Intent(Intent.ACTION_VIEW)))
  }
}
