package ai.openclaw.app

import android.content.Intent

const val extraAndroidScreenshotMode = "openclaw.screenshotMode"
const val extraAndroidScreenshotScene = "openclaw.screenshotScene"

enum class AndroidScreenshotScene(
  val rawValue: String,
) {
  Connect("connect"),
  Chat("chat"),
  Voice("voice"),
  Screen("screen"),
  Settings("settings"),
  ;

  companion object {
    fun fromRawValue(raw: String?): AndroidScreenshotScene = entries.firstOrNull { it.rawValue == raw?.trim()?.lowercase() } ?: Connect
  }
}

fun parseAndroidScreenshotModeIntent(intent: Intent?): AndroidScreenshotScene? {
  if (intent?.getBooleanExtra(extraAndroidScreenshotMode, false) != true) {
    return null
  }
  return AndroidScreenshotScene.fromRawValue(intent.getStringExtra(extraAndroidScreenshotScene))
}
