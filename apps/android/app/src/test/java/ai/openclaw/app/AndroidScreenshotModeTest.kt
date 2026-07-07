package ai.openclaw.app

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidScreenshotModeTest {
  @Test
  fun ignoresNormalLaunches() {
    assertNull(parseAndroidScreenshotModeIntent(Intent(Intent.ACTION_MAIN)))
  }

  @Test
  fun parsesRequestedScene() {
    val parsed =
      parseAndroidScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "voice")
          .putExtra(extraAndroidScreenshotAppLanguage, "zh-CN"),
      )

    assertEquals(AndroidScreenshotScene.Voice, parsed?.scene)
    assertEquals(AppLanguageMode.ChineseSimplified, parsed?.appLanguageMode)
  }

  @Test
  fun defaultsUnknownScenesToConnect() {
    val parsed =
      parseAndroidScreenshotModeIntent(
        Intent(Intent.ACTION_MAIN)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "unknown"),
      )

    assertEquals(AndroidScreenshotScene.Connect, parsed?.scene)
    assertEquals(AppLanguageMode.System, parsed?.appLanguageMode)
  }
}
