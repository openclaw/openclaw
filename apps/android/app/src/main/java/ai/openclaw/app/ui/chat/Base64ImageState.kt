package ai.openclaw.app.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal val LocalBase64ImageDecodeDispatcher = staticCompositionLocalOf<CoroutineDispatcher> { Dispatchers.Default }

/** Compose state for async base64 image decoding. */
internal data class Base64ImageState(
  val image: ImageBitmap?,
  val failed: Boolean,
)

/** Decodes a base64 image off the UI thread and reports failure state. */
@Composable
internal fun rememberBase64ImageState(
  base64: String,
  source: Base64ImageSource = Base64ImageSource.Inline,
): Base64ImageState {
  val decodeDispatcher = LocalBase64ImageDecodeDispatcher.current
  var image by remember(base64, source) { mutableStateOf<ImageBitmap?>(null) }
  var failed by remember(base64, source) { mutableStateOf(false) }

  LaunchedEffect(base64, source, decodeDispatcher) {
    failed = false
    image =
      withContext(decodeDispatcher) {
        try {
          val bitmap = decodeBase64Bitmap(base64, source = source) ?: return@withContext null
          bitmap.asImageBitmap()
        } catch (_: Throwable) {
          null
        }
      }
    if (image == null) failed = true
  }

  return Base64ImageState(image = image, failed = failed)
}
