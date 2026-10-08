package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPhotoReadPermission
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.core.graphics.scale
import androidx.exifinterface.media.ExifInterface
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.time.Instant
import kotlin.math.max
import kotlin.math.roundToInt

private const val DEFAULT_PHOTOS_LIMIT = 1
private const val DEFAULT_PHOTOS_MAX_WIDTH = 1600
private const val DEFAULT_PHOTOS_QUALITY = 0.85
private const val MAX_TOTAL_BASE64_CHARS = 340 * 1024
private const val MAX_PER_PHOTO_BASE64_CHARS = 300 * 1024

internal data class PhotosLatestRequest(
  val limit: Int,
  val maxWidth: Int,
  val quality: Double,
)

@Serializable
internal data class EncodedPhotoPayload(
  val format: String,
  val base64: String,
  val width: Int,
  val height: Int,
  // A missing capture time is omitted, not serialized as JSON null.
  val createdAt: String? = null,
)

internal interface PhotosDataSource {
  fun hasPermission(context: Context): Boolean

  fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload>
}

private object SystemPhotosDataSource : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean = hasPhotoReadPermission(context)

  override fun latest(
    context: Context,
    request: PhotosLatestRequest,
  ): List<EncodedPhotoPayload> {
    val resolver = context.contentResolver
    val rows = queryLatestRows(resolver, request.limit)
    if (rows.isEmpty()) return emptyList()

    var remainingBudget = MAX_TOTAL_BASE64_CHARS
    val out = mutableListOf<EncodedPhotoPayload>()
    for (row in rows) {
      if (remainingBudget <= 0) break
      val bitmap = decodeScaledBitmap(resolver, row.uri, request.maxWidth) ?: continue
      try {
        // Enforce both per-photo and total payload budgets before returning
        // base64 data through the gateway invoke response.
        val encoded = encodeJpegUnderBudget(bitmap, request.quality)
        if (encoded == null) continue
        if (encoded.base64.length > remainingBudget) break
        remainingBudget -= encoded.base64.length
        out += encoded.copy(createdAt = row.createdAtMs?.let { Instant.ofEpochMilli(it).toString() })
      } finally {
        bitmap.recycle()
      }
    }
    return out
  }

  private data class PhotoRow(
    val uri: Uri,
    val createdAtMs: Long?,
  )

  private fun queryLatestRows(
    resolver: ContentResolver,
    limit: Int,
  ): List<PhotoRow> {
    val projection =
      arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.DATE_TAKEN,
        MediaStore.Images.Media.DATE_ADDED,
      )
    val sortOrder =
      "COALESCE(NULLIF(${MediaStore.Images.Media.DATE_TAKEN}, 0), " +
        "${MediaStore.Images.Media.DATE_ADDED} * 1000) DESC, ${MediaStore.Images.Media._ID} DESC"
    val args =
      Bundle().apply {
        putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder)
        putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
      }

    resolver
      .query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        projection,
        args,
        null,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
        val takenIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
        val addedIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
        val rows = mutableListOf<PhotoRow>()
        while (cursor.moveToNext()) {
          val id = cursor.getLong(idIndex)
          val takenMs = cursor.getLong(takenIndex).takeIf { it > 0L }
          val addedMs = cursor.getLong(addedIndex).takeIf { it > 0L }?.times(1000L)
          rows +=
            PhotoRow(
              uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id),
              createdAtMs = takenMs ?: addedMs,
            )
        }
        return rows
      }
  }

  private fun decodeScaledBitmap(
    resolver: ContentResolver,
    uri: Uri,
    maxWidth: Int,
  ): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { input ->
      if (input == null) return null
      BitmapFactory.decodeStream(input, null, bounds)
    }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val orientation = JpegSizeLimiter.readOrientation { resolver.openInputStream(uri) }
    val sourceWidth =
      if (orientation in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270) {
        bounds.outHeight
      } else {
        bounds.outWidth
      }
    val decodeOptions =
      BitmapFactory.Options().apply {
        inSampleSize = 1
        while (sourceWidth / inSampleSize / 2 >= maxWidth) {
          inSampleSize *= 2
        }
      }
    val decoded =
      resolver.openInputStream(uri).use { input ->
        if (input == null) return null
        BitmapFactory.decodeStream(input, null, decodeOptions)
      } ?: return null

    val oriented = JpegSizeLimiter.normalizeOrientation(decoded, orientation)
    if (oriented.width <= maxWidth) return oriented
    // Decode sampling is power-of-two only; finish with exact scaling when the
    // sampled bitmap is still wider than the requested max width.
    val targetHeight = max(1, ((oriented.height.toDouble() * maxWidth) / oriented.width).roundToInt())
    return try {
      oriented.scale(maxWidth, targetHeight, true)
    } finally {
      oriented.recycle()
    }
  }

  private fun encodeJpegUnderBudget(
    bitmap: Bitmap,
    quality: Double,
  ): EncodedPhotoPayload? {
    var working = bitmap
    try {
      var jpegQuality = (quality * 100.0).roundToInt()
      repeat(10) {
        val out = ByteArrayOutputStream()
        val ok = working.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
        if (!ok) return null
        val bytes = out.toByteArray()
        val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        if (base64.length <= MAX_PER_PHOTO_BASE64_CHARS) {
          return EncodedPhotoPayload(
            format = "jpeg",
            base64 = base64,
            width = working.width,
            height = working.height,
          )
        }
        if (jpegQuality > 35) {
          // Try quality reduction before resizing so small images keep detail.
          jpegQuality = max(25, jpegQuality - 15)
          return@repeat
        }
        val nextWidth = max(240, (working.width * 0.75f).roundToInt())
        if (nextWidth >= working.width) return null
        val nextHeight = max(1, ((working.height.toDouble() * nextWidth) / working.width).roundToInt())
        val previous = working
        working = working.scale(nextWidth, nextHeight, true)
        if (previous !== bitmap) previous.recycle()
      }
      return null
    } finally {
      if (working !== bitmap) working.recycle()
    }
  }
}

class PhotosHandler internal constructor(
  private val appContext: Context,
  private val dataSource: PhotosDataSource = SystemPhotosDataSource,
) {
  fun handlePhotosLatest(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasPermission(appContext)) {
      return nodeInvokeError("PHOTOS_PERMISSION_REQUIRED", "grant Photos permission")
    }
    val request =
      parseRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    return try {
      val photos = dataSource.latest(appContext, request)
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("photos" to photos)))
    } catch (err: Throwable) {
      nodeInvokeError("PHOTOS_UNAVAILABLE", err.message ?: "photo fetch failed")
    }
  }

  private fun parseRequest(paramsJson: String?): PhotosLatestRequest? {
    val params = if (paramsJson.isNullOrBlank()) null else parseJsonParamsObject(paramsJson) ?: return null
    // Clamp model-supplied values to protect memory and response-size limits.
    return PhotosLatestRequest(
      limit = (parseJsonInt(params, "limit") ?: DEFAULT_PHOTOS_LIMIT).coerceIn(1, 20),
      maxWidth = (parseJsonInt(params, "maxWidth") ?: DEFAULT_PHOTOS_MAX_WIDTH).coerceIn(240, 4096),
      quality = (parseJsonDouble(params, "quality") ?: DEFAULT_PHOTOS_QUALITY).coerceIn(0.1, 1.0),
    )
  }
}
