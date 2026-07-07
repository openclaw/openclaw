package ai.openclaw.app

import android.content.Intent

const val extraAndroidScreenshotMode = "openclaw.screenshotMode"
const val extraAndroidScreenshotScene = "openclaw.screenshotScene"
const val extraAndroidScreenshotAppLanguage = "openclaw.screenshotAppLanguage"

enum class AndroidScreenshotScene(
  val rawValue: String,
) {
  Connect("connect"),
  Chat("chat"),
  Voice("voice"),
  Screen("screen"),
  Settings("settings"),
  Language("language"),
  ;

  companion object {
    fun fromRawValue(raw: String?): AndroidScreenshotScene = entries.firstOrNull { it.rawValue == raw?.trim()?.lowercase() } ?: Connect
  }
}

data class AndroidScreenshotModeRequest(
  val scene: AndroidScreenshotScene,
  val appLanguageMode: AppLanguageMode,
)

fun parseAndroidScreenshotModeIntent(intent: Intent?): AndroidScreenshotModeRequest? {
  if (intent?.getBooleanExtra(extraAndroidScreenshotMode, false) != true) {
    return null
  }
  return AndroidScreenshotModeRequest(
    scene = AndroidScreenshotScene.fromRawValue(intent.getStringExtra(extraAndroidScreenshotScene)),
    appLanguageMode = AppLanguageMode.fromRawValue(intent.getStringExtra(extraAndroidScreenshotAppLanguage)),
  )
}
