package ai.openclaw.app.ui.chat

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import org.junit.Assert.assertEquals
import org.junit.Test

class ImageViewportTest {
  @Test
  fun movingFocalPointPreservesTheSameImagePixelUntilAnEdgeIsReached() {
    val viewport = ImageViewport(Size(300f, 300f), Size(600f, 600f))
    viewport.change(2f, Offset(200f, 180f), Offset(10f, 20f))
    assertEquals(Offset(-40f, -10f), viewport.offset)
    // The original pixel at (200,180) is now at the translated focal point (210,200).
    assertEquals(210f, 150f + (200f - 150f) * viewport.scale + viewport.offset.x, 0.001f)
    assertEquals(200f, 150f + (180f - 150f) * viewport.scale + viewport.offset.y, 0.001f)
    viewport.change(100f, pan = Offset(10000f, -10000f))
    assertEquals(4f, viewport.scale)
    assertEquals(Offset(450f, -450f), viewport.offset)
    viewport.change(0.01f)
    assertEquals(1f, viewport.scale)
    assertEquals(Offset.Zero, viewport.offset)
  }

  @Test
  fun letterboxedAxisCannotPanIntoEmptySpace() {
    val viewport = ImageViewport(Size(300f, 600f), Size(600f, 300f))
    viewport.change(2f, pan = Offset(999f, 999f))
    assertEquals(Offset(150f, 0f), viewport.offset)
    viewport.reset()
    assertEquals(Offset.Zero, viewport.offset)
    assertEquals(1f, viewport.scale)
    assertEquals(225f, viewport.imageBounds.top)
    assertEquals(375f, viewport.imageBounds.bottom)
  }
}
