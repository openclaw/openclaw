package ai.openclaw.wear

import android.content.Intent
import androidx.wear.protolayout.ActionBuilders
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearLaunchIntentTest {
  @Test
  fun normalAndUnknownLaunchesStartOnChat() {
    assertEquals(WearLaunchTarget.Chat, parseWearLaunchTarget(Intent(Intent.ACTION_MAIN)))
    assertEquals(
      WearLaunchTarget.Chat,
      parseWearLaunchTarget(Intent().putExtra(extraWearLaunchTarget, "unknown")),
    )
  }

  @Test
  fun tileTalkLaunchStartsOnVoice() {
    val target =
      parseWearLaunchTarget(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
      )

    assertEquals(WearLaunchTarget.Voice, target)
    assertEquals(WearHomePage.Voice, target.initialPage)
  }

  @Test
  fun warmLaunchesRecreateNavigationForTalkAndOpen() {
    val initial = WearLaunchState()
    val voice =
      initial.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Voice.rawValue),
      )
    val chat =
      voice.next(
        Intent().putExtra(extraWearLaunchTarget, WearLaunchTarget.Chat.rawValue),
      )

    assertEquals(WearLaunchTarget.Voice, voice.target)
    assertEquals(1, voice.generation)
    assertEquals(WearLaunchTarget.Chat, chat.target)
    assertEquals(2, chat.generation)
  }

  @Test
  fun tileActionsTargetMainActivityWithTheirRequestedPage() {
    val context = RuntimeEnvironment.getApplication()

    WearLaunchTarget.entries.forEach { target ->
      val activity = wearLaunchAction(context, target).androidActivity
      val pageExtra =
        activity?.keyToExtraMapping?.get(extraWearLaunchTarget)
          as? ActionBuilders.AndroidStringExtra

      assertEquals(context.packageName, activity?.packageName)
      assertEquals(MainActivity::class.java.name, activity?.className)
      assertEquals(target.rawValue, pageExtra?.value)
    }
  }
}
