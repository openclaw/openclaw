package ai.openclaw.app.node

import android.graphics.Bitmap
import android.graphics.Matrix
import androidx.core.graphics.scale
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

internal data class JpegSizeLimiterResult(
  val bytes: ByteArray,
  val width: Int,
  val height: Int,
  val quality: Int,
)

internal object JpegSizeLimiter {
  private const val MAX_SCALE_ATTEMPTS = 6
  private const val MAX_QUALITY_ATTEMPTS = 6
  private const val SCALE_STEP = 0.85

  /** Keeps the caller's bitmap alive and recycles only temporary resized images. */
  fun compressToLimit(
    bitmap: Bitmap,
    startQuality: Int,
    maxBytes: Int,
    errorMessage: String,
    minQuality: Int = 20,
    minSize: Int = 256,
  ): JpegSizeLimiterResult =
    compressToLimit(bitmap.width, bitmap.height, startQuality, maxBytes, minQuality, minSize) { width, height, quality ->
      val working = if (width == bitmap.width && height == bitmap.height) bitmap else bitmap.scale(width, height)
      try {
        val out = ByteArrayOutputStream()
        check(working.compress(Bitmap.CompressFormat.JPEG, quality, out)) { errorMessage }
        out.toByteArray()
      } finally {
        if (working !== bitmap) working.recycle()
      }
    }

  fun readOrientation(open: () -> InputStream?): Int =
    try {
      open()?.use { stream ->
        ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      } ?: ExifInterface.ORIENTATION_NORMAL
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }

  /** Applies camera/gallery orientation before resize, display, or metadata-stripping JPEG encoding. */
  fun normalizeOrientation(
    bitmap: Bitmap,
    orientation: Int,
  ): Bitmap {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> {
        matrix.postRotate(90f)
      }

      ExifInterface.ORIENTATION_ROTATE_180 -> {
        matrix.postRotate(180f)
      }

      ExifInterface.ORIENTATION_ROTATE_270 -> {
        matrix.postRotate(270f)
      }

      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> {
        matrix.postScale(-1f, 1f)
      }

      ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
        matrix.postScale(1f, -1f)
      }

      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.postRotate(90f)
        matrix.postScale(-1f, 1f)
      }

      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.postRotate(-90f)
        matrix.postScale(-1f, 1f)
      }

      else -> {
        return bitmap
      }
    }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { oriented ->
      if (oriented !== bitmap) bitmap.recycle()
    }
  }

  /** Compresses with the caller-provided encoder, reducing quality before image dimensions. */
  fun compressToLimit(
    initialWidth: Int,
    initialHeight: Int,
    startQuality: Int,
    maxBytes: Int,
    minQuality: Int = 20,
    minSize: Int = 256,
    encode: (width: Int, height: Int, quality: Int) -> ByteArray,
  ): JpegSizeLimiterResult {
    require(initialWidth > 0 && initialHeight > 0) { "Invalid image size" }
    require(maxBytes > 0) { "Invalid maxBytes" }

    val clampedStartQuality = startQuality.coerceIn(minQuality, 100)
    var width = initialWidth
    var height = initialHeight
    var lastSize = 0

    for (scaleAttempt in 0..MAX_SCALE_ATTEMPTS) {
      var quality = clampedStartQuality
      for (qualityAttempt in 0 until MAX_QUALITY_ATTEMPTS) {
        val bytes = encode(width, height, quality)
        lastSize = bytes.size
        if (bytes.size <= maxBytes) return JpegSizeLimiterResult(bytes = bytes, width = width, height = height, quality = quality)
        if (quality <= minQuality) break
        quality = max(minQuality, (quality * 0.75).roundToInt())
      }

      if (scaleAttempt == MAX_SCALE_ATTEMPTS) break
      val minScale = (minSize.toDouble() / min(width, height).toDouble()).coerceAtMost(1.0)
      val nextScale = max(SCALE_STEP, minScale)
      val nextWidth = min(width, max(minSize, (width * nextScale).roundToInt()))
      val nextHeight = min(height, max(minSize, (height * nextScale).roundToInt()))
      if (nextWidth == width && nextHeight == height) break
      width = nextWidth
      height = nextHeight
    }

    throw IllegalStateException("CAMERA_TOO_LARGE: $lastSize bytes > $maxBytes bytes")
  }
}
