package ai.openclaw.android.gateway

import android.os.Build

object GatewayClientProfiles {
  const val AndroidClientId = "openclaw-android"
  const val UiMode = "ui"
  const val NodeMode = "node"
  const val AndroidPlatform = "android"
  const val WearOsPlatform = "wearos"
  const val AndroidDeviceFamily = "Android"
  const val WatchDeviceFamily = "watch"

  fun resolveModelIdentifier(): String? {
    return listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { null }
  }

  fun resolveVersionName(rawVersionName: String?, debug: Boolean): String {
    val versionName = rawVersionName?.trim().orEmpty().ifEmpty { "dev" }
    return if (debug && !versionName.contains("dev", ignoreCase = true)) {
      "$versionName-dev"
    } else {
      versionName
    }
  }

  fun resolveWearDisplayName(): String {
    val modelIdentifier = resolveModelIdentifier()
    return if (modelIdentifier.isNullOrBlank()) {
      "Wear OS"
    } else {
      "$modelIdentifier (Wear OS)"
    }
  }
}
