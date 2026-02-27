package ai.openclaw.android.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CameraHandlerTest {
  @Test
  fun parseCameraClipUploadUrl_returnsUrlForValidPayload() {
    val actual = parseCameraClipUploadUrl("""{"url":"https://example.com/upload/clip.mp4"}""")

    assertEquals("https://example.com/upload/clip.mp4", actual)
  }

  @Test
  fun parseCameraClipUploadUrl_trimsUrlWhitespace() {
    val actual = parseCameraClipUploadUrl("""{"url":"  https://example.com/u.mp4  "}""")

    assertEquals("https://example.com/u.mp4", actual)
  }

  @Test
  fun parseCameraClipUploadUrl_returnsNullForMalformedPayloads() {
    assertNull(parseCameraClipUploadUrl(""))
    assertNull(parseCameraClipUploadUrl("not-json"))
    assertNull(parseCameraClipUploadUrl("""{"ok":true}"""))
    assertNull(parseCameraClipUploadUrl("""{"url":123}"""))
    assertNull(parseCameraClipUploadUrl("""{"url":"   "}"""))
  }
}

