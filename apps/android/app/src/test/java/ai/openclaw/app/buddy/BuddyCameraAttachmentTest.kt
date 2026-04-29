package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BuddyCameraAttachmentTest {
  @Test
  fun parsesJpegSnapPayloadAsImageAttachment() {
    val attachment =
      BuddyCameraAttachment.fromSnapPayload(
        """{"format":"jpg","base64":"abc123","width":640,"height":480}""",
      )

    assertEquals("image", attachment?.type)
    assertEquals("image/jpeg", attachment?.mimeType)
    assertEquals("nemo-camera.jpg", attachment?.fileName)
    assertEquals("abc123", attachment?.base64)
  }

  @Test
  fun ignoresPayloadWithoutImageBytes() {
    assertNull(BuddyCameraAttachment.fromSnapPayload("""{"format":"jpg"}"""))
    assertNull(BuddyCameraAttachment.fromSnapPayload("""{"format":"mp4","base64":"abc123"}"""))
    assertNull(BuddyCameraAttachment.fromSnapPayload("not-json"))
  }
}
