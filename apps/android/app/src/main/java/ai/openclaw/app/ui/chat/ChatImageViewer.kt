package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.center
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlin.math.min
import kotlin.math.roundToInt

/** Owns only the open image's viewport; loading and transcript anchors stay with ChatImagePreview. */
@Composable
internal fun ChatImageViewer(
  image: ImageBitmap,
  onDismiss: () -> Unit,
) {
  var viewport by remember { mutableStateOf(Size.Zero) }
  // A new image or viewport (including rotation) starts fitted, never with stale pixel offsets.
  val transform = remember(image, viewport) { ImageViewport(viewport, Size(image.width.toFloat(), image.height.toFloat())) }
  val density = LocalDensity.current
  val stageOrigin = with(density) { Offset(12.dp.toPx(), 68.dp.toPx()) }
  Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    CompositionLocalProvider(LocalDensity provides density) {
      Box(
        Modifier
          .fillMaxSize()
          .background(Color.Black.copy(alpha = 0.96f))
          .pointerInput(transform, onDismiss, stageOrigin) {
            var lastTap: Offset? = null
            var lastTapTime = 0L
            awaitEachGesture {
              val down = awaitFirstDown()
              val startedOnImage = transform.imageBounds.contains(down.position - stageOrigin)
              var stationary = true
              var multiplePointers = false
              var canceled = false
              var released = down
              do {
                val event = awaitPointerEvent()
                multiplePointers = multiplePointers || event.changes.size > 1
                stationary = stationary && event.changes.all { (it.position - down.position).getDistance() <= 4.dp.toPx() }
                canceled = canceled || event.changes.any { it.isConsumed }
                if (!canceled && (multiplePointers || !stationary)) {
                  val centroid = event.calculateCentroid(useCurrent = false)
                  if (centroid != Offset.Unspecified) {
                    transform.change(event.calculateZoom(), centroid - stageOrigin, event.calculatePan())
                  }
                }
                released = event.changes.firstOrNull { it.id == down.id } ?: released
                event.changes.forEach { it.consume() }
              } while (event.changes.any { it.pressed })
              val tap = !canceled && stationary && !multiplePointers && released.uptimeMillis - down.uptimeMillis < viewConfiguration.longPressTimeoutMillis
              if (tap && !startedOnImage && !transform.imageBounds.contains(released.position - stageOrigin)) {
                onDismiss()
              } else if (tap && startedOnImage) {
                val previous = lastTap
                val elapsed = down.uptimeMillis - lastTapTime
                if (previous != null && elapsed in viewConfiguration.doubleTapMinTimeMillis..viewConfiguration.doubleTapTimeoutMillis &&
                  (previous - down.position).getDistance() <= viewConfiguration.touchSlop * 2
                ) {
                  if (transform.scale > 1f) transform.reset() else transform.change(2.5f, down.position - stageOrigin)
                  lastTap = null
                } else {
                  lastTap = down.position
                  lastTapTime = released.uptimeMillis
                }
              } else {
                lastTap = null
              }
            }
          },
      ) {
        Box(
          modifier =
            Modifier
              .fillMaxSize()
              .padding(start = 12.dp, end = 12.dp, top = 68.dp, bottom = 64.dp)
              .clipToBounds()
              .onSizeChanged { viewport = Size(it.width.toFloat(), it.height.toFloat()) },
          contentAlignment = Alignment.Center,
        ) {
          Image(
            bitmap = image,
            contentDescription = nativeString("Image preview"),
            contentScale = ContentScale.Fit,
            modifier =
              Modifier.fillMaxSize().graphicsLayer {
                scaleX = transform.scale
                scaleY = transform.scale
                translationX = transform.offset.x
                translationY = transform.offset.y
              },
          )
        }
        Surface(
          onClick = onDismiss,
          modifier = Modifier.align(Alignment.TopEnd).padding(12.dp).size(48.dp),
          shape = CircleShape,
          color = Color.White.copy(alpha = 0.16f),
          contentColor = Color.White,
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Default.Close, nativeString("Close image preview"), Modifier.size(18.dp))
          }
        }
        Row(
          Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          ImageZoomControl("−", nativeString("Zoom out"), transform.scale > 1f) { transform.change(1f / 1.5f) }
          ImageZoomControl("${(transform.scale * 100).roundToInt()}%", nativeString("Reset zoom"), transform.scale > 1f) { transform.reset() }
          ImageZoomControl("+", nativeString("Zoom in"), transform.scale < 4f) { transform.change(1.5f) }
        }
      }
    }
  }
}

@Composable
private fun ImageZoomControl(
  text: String,
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.sizeIn(minWidth = if (text.length > 1) 64.dp else 48.dp, minHeight = 48.dp).semantics { contentDescription = label },
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = Color.White.copy(alpha = 0.16f),
    contentColor = Color.White.copy(alpha = if (enabled) 1f else 0.8f),
  ) {
    Box(contentAlignment = Alignment.Center) { Text(text, style = ClawTheme.type.caption) }
  }
}

/** Coordinates are stage pixels; the image is fitted once, then transformed around its center. */
internal class ImageViewport(
  private val viewport: Size,
  image: Size,
) {
  private val fit = if (viewport == Size.Zero) 0f else min(viewport.width / image.width, viewport.height / image.height)
  private val fitted = Size(image.width * fit, image.height * fit)
  var scale by mutableStateOf(1f)
    private set
  var offset by mutableStateOf(Offset.Zero)
    private set
  val imageBounds: Rect
    get() {
      val half = Offset(fitted.width * scale / 2, fitted.height * scale / 2)
      return Rect(viewport.center + offset - half, viewport.center + offset + half).intersect(Rect(Offset.Zero, viewport))
    }

  fun change(
    zoom: Float,
    focal: Offset = viewport.center,
    pan: Offset = Offset.Zero,
  ) {
    val next = (scale * zoom).coerceIn(1f, 4f)
    val ratio = next / scale
    // The same image pixel stays under the moving centroid, unless an edge clamp wins.
    val translated = (offset - (focal - viewport.center)) * ratio + (focal - viewport.center) + pan
    scale = next
    val maxX = ((fitted.width * scale - viewport.width) / 2).coerceAtLeast(0f)
    val maxY = ((fitted.height * scale - viewport.height) / 2).coerceAtLeast(0f)
    offset = Offset(if (maxX == 0f) 0f else translated.x.coerceIn(-maxX, maxX), if (maxY == 0f) 0f else translated.y.coerceIn(-maxY, maxY))
  }

  fun reset() {
    scale = 1f
    offset = Offset.Zero
  }
}
