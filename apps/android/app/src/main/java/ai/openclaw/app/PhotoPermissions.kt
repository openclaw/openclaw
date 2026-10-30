package ai.openclaw.app

import android.Manifest
import android.content.Context
import android.os.Build

internal fun photoReadPermissionsForRequest(): List<String> =
  when {
    Build.VERSION.SDK_INT >= 34 -> {
      listOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
      )
    }

    Build.VERSION.SDK_INT >= 33 -> {
      listOf(Manifest.permission.READ_MEDIA_IMAGES)
    }

    else -> {
      listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
  }

internal fun hasPhotoReadPermission(context: Context): Boolean = photoReadPermissionsForRequest().any(context::hasPermission)
