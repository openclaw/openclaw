package ai.openclaw.app.ui.chat

import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import coil3.ImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(AndroidJUnit4::class)
class ChatSourceFaviconDecodeTest {
  @Test
  fun gatewayPngSvgAndIcoDecodeOnAndroidAtIconSize() =
    runBlocking {
      val context = InstrumentationRegistry.getInstrumentation().targetContext
      val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
      val png =
        ByteArrayOutputStream().use { output ->
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
          bitmap.recycle()
          output.toByteArray()
        }
      val ico =
        ByteBuffer
          .allocate(22 + png.size)
          .order(ByteOrder.LITTLE_ENDIAN)
          .apply {
            putShort(0)
            putShort(1)
            putShort(1)
            put(16)
            put(16)
            put(0)
            put(0)
            putShort(1)
            putShort(32)
            putInt(png.size)
            putInt(22)
            put(png)
          }.array()
      val svg = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#3289bd"/></svg>""".toByteArray()
      val loader = ImageLoader(context)
      try {
        for ((format, bytes) in listOf("PNG" to png, "SVG" to svg, "ICO" to ico)) {
          val result =
            loader.execute(
              ImageRequest
                .Builder(context)
                .data(bytes)
                .size(64)
                .build(),
            )
          assertTrue("$format favicon must decode: $result", result is SuccessResult)
        }
      } finally {
        loader.shutdown()
      }
    }
}
