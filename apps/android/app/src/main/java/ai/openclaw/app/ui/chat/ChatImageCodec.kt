package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import ai.openclaw.app.node.JpegSizeLimiter
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.LruCache
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

private const val CHAT_ATTACHMENT_MAX_WIDTH = 1600
private const val CHAT_ATTACHMENT_START_QUALITY = 85
private const val CHAT_DECODE_MAX_DIMENSION = 1600
private const val CHAT_IMAGE_CACHE_BYTES = 16 * 1024 * 1024

private val decodedBitmapCache =
  object : LruCache<String, Bitmap>(CHAT_IMAGE_CACHE_BYTES) {
    override fun sizeOf(
      key: String,
      value: Bitmap,
    ): Int = value.byteCount.coerceAtLeast(1)
  }

/** Loads a picked image URI into the bounded attachment shape sent to chat. */
internal fun loadSizedImageAttachment(
  resolver: ContentResolver,
  uri: Uri,
): PendingAttachment {
  val decoded = decodeScaledBitmap(resolver, uri, maxDimension = CHAT_ATTACHMENT_MAX_WIDTH)
  if (decoded == null) {
    throw IllegalStateException("unsupported attachment")
  }
  val bitmap = decoded.bitmap
  val maxBytes = (CHAT_IMAGE_MAX_BASE64_CHARS / 4) * 3
  val outputMimeType = attachmentOutputMimeType(decoded.mimeType)
  val preservePng = outputMimeType == "image/png"
  val compressionFormat = if (preservePng) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
  // Reuse the node limiter so chat attachments and node photo payloads stay
  // within the same gateway frame budget. PNG has no lossy quality ladder,
  // so its search only reduces dimensions when needed.
  val encodedBytes =
    JpegSizeLimiter
      .compressToLimit(
        initialWidth = bitmap.width,
        initialHeight = bitmap.height,
        startQuality = if (preservePng) 100 else CHAT_ATTACHMENT_START_QUALITY,
        minQuality = if (preservePng) 100 else 20,
        maxQualityAttempts = if (preservePng) 1 else 6,
        maxBytes = maxBytes,
        minSize = 240,
        encode = { width, height, quality ->
          val working =
            if (width == bitmap.width && height == bitmap.height) {
              bitmap
            } else {
              bitmap.scale(width, height, true)
            }
          try {
            val out = ByteArrayOutputStream()
            if (!working.compress(compressionFormat, quality, out)) {
              throw IllegalStateException("attachment encode failed")
            }
            out.toByteArray()
          } finally {
            if (working !== bitmap) {
              working.recycle()
            }
          }
        },
      ).bytes
  val base64 = Base64.encodeToString(encodedBytes, Base64.NO_WRAP)
  val rawFileName = (uri.lastPathSegment ?: "image").substringAfterLast('/')
  return PendingAttachment(
    id = uri.toString() + "#" + System.currentTimeMillis().toString(),
    fileName = normalizeAttachmentFileName(rawFileName, outputMimeType),
    mimeType = outputMimeType,
    base64 = base64,
  )
}

internal fun attachmentOutputMimeType(sourceMimeType: String?): String =
  if (sourceMimeType.equals("image/png", ignoreCase = true)) "image/png" else "image/jpeg"

/** Normalizes arbitrary picked-image names to match the encoded format sent upstream. */
internal fun normalizeAttachmentFileName(
  raw: String,
  mimeType: String,
): String {
  val trimmed = raw.trim()
  val extension = if (mimeType == "image/png") "png" else "jpg"
  if (trimmed.isEmpty()) return "image.$extension"
  val stem = trimmed.substringBeforeLast('.', missingDelimiterValue = trimmed).ifEmpty { "image" }
  return "$stem.$extension"
}

private data class DecodedAttachmentBitmap(
  val bitmap: Bitmap,
  val mimeType: String?,
)

/** Decodes chat image payloads into display-sized bitmaps with an LRU cache. */
internal fun decodeBase64Bitmap(
  base64: String,
  maxDimension: Int = CHAT_DECODE_MAX_DIMENSION,
): Bitmap? {
  if (base64.length > CHAT_IMAGE_MAX_BASE64_CHARS) return null
  val cacheKey = "$maxDimension:${base64.length}:${base64.hashCode()}"
  decodedBitmapCache.get(cacheKey)?.let { return it }

  val bytes = Base64.decode(base64, Base64.DEFAULT)
  if (bytes.isEmpty()) return null

  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

  val bitmap =
    BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply {
        inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        inPreferredConfig = Bitmap.Config.RGB_565
      },
    ) ?: return null

  decodedBitmapCache.put(cacheKey, bitmap)
  return bitmap
}

/** Computes Android's power-of-two bitmap sampling size for bounded decode. */
internal fun computeInSampleSize(
  width: Int,
  height: Int,
  maxDimension: Int,
): Int {
  if (width <= 0 || height <= 0 || maxDimension <= 0) return 1

  var sample = 1
  var longestEdge = max(width, height)
  while (longestEdge > maxDimension && sample < 64) {
    sample *= 2
    longestEdge = max(width / sample, height / sample)
  }
  return sample.coerceAtLeast(1)
}

private fun decodeScaledBitmap(
  resolver: ContentResolver,
  uri: Uri,
  maxDimension: Int,
): DecodedAttachmentBitmap? {
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  resolver.openInputStream(uri).use { input ->
    if (input == null) return null
    BitmapFactory.decodeStream(input, null, bounds)
  }
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

  val decoded =
    resolver.openInputStream(uri).use { input ->
      if (input == null) return null
      BitmapFactory.decodeStream(
        input,
        null,
        BitmapFactory.Options().apply {
          inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
          inPreferredConfig = Bitmap.Config.ARGB_8888
        },
      )
    } ?: return null

  val longestEdge = max(decoded.width, decoded.height)
  if (longestEdge <= maxDimension) {
    return DecodedAttachmentBitmap(bitmap = decoded, mimeType = bounds.outMimeType)
  }

  val scale = maxDimension.toDouble() / longestEdge.toDouble()
  val targetWidth = max(1, (decoded.width * scale).roundToInt())
  val targetHeight = max(1, (decoded.height * scale).roundToInt())
  val scaled = decoded.scale(targetWidth, targetHeight, true)
  if (scaled !== decoded) {
    decoded.recycle()
  }
  return DecodedAttachmentBitmap(bitmap = scaled, mimeType = bounds.outMimeType)
}
