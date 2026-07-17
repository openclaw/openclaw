package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(RobolectricTestRunner::class)
class ChatImageCodecTest {
  @Test
  fun computeInSampleSizeCapsLongestEdge() {
    assertEquals(4, computeInSampleSize(width = 4032, height = 3024, maxDimension = 1600))
    assertEquals(1, computeInSampleSize(width = 800, height = 600, maxDimension = 1600))
  }

  @Test
  fun normalizeAttachmentFileNameMatchesEncodedFormat() {
    assertEquals("photo.png", normalizeAttachmentFileName("photo.png", "image/png"))
    assertEquals("photo.jpg", normalizeAttachmentFileName("photo.png", "image/jpeg"))
    assertEquals("image.jpg", normalizeAttachmentFileName("", "image/jpeg"))
  }

  @Test
  fun pngInputsKeepPngMimeType() {
    assertEquals("image/png", attachmentOutputMimeType("image/png"))
    assertEquals("image/png", attachmentOutputMimeType("IMAGE/PNG"))
    assertEquals("image/jpeg", attachmentOutputMimeType("image/webp"))
  }

  @Test
  fun pickedPngReachesPendingAttachmentAsPng() {
    val bitmap = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(Color.argb(96, 20, 120, 220))
    val source = ByteArrayOutputStream()
    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, source))
    bitmap.recycle()

    val file = File.createTempFile("diagram-", ".png")
    try {
      file.writeBytes(source.toByteArray())
      val resolver = RuntimeEnvironment.getApplication().contentResolver
      val attachment = loadSizedImageAttachment(resolver, Uri.fromFile(file))
      val encoded = Base64.decode(attachment.base64, Base64.DEFAULT)

      assertEquals("image/png", attachment.mimeType)
      assertTrue(attachment.fileName.endsWith(".png"))
      assertEquals(listOf(0x89, 0x50, 0x4e, 0x47), encoded.take(4).map { it.toInt() and 0xff })
    } finally {
      file.delete()
    }
  }

  @Test
  fun decodeBase64BitmapRejectsOversizedInputBeforeDecode() {
    assertNull(decodeBase64Bitmap("A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)))
  }
}
