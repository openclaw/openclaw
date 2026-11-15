package ai.openclaw.app.ui.chat

import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import java.io.ByteArrayOutputStream

/** A real high-detail JPEG within camera/composer limits but above the inline preview budget. */
internal fun syntheticLargeChatPhotoBase64(): String {
  val width = 1024
  val height = 768
  var seed = 7
  val pixels =
    IntArray(width * height) {
      seed = seed * 1664525 + 1013904223
      Color.rgb((seed ushr 16) and 255, (seed ushr 8) and 255, seed and 255)
    }
  val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
  return try {
    ByteArrayOutputStream().use { output ->
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output))
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
  } finally {
    bitmap.recycle()
  }
}
