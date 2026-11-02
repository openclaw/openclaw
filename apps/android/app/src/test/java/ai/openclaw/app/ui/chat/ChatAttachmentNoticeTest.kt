package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatAttachmentNoticeTest {
  @Test
  fun typeRejectionStaysDistinctFromAFailedRead() {
    assertEquals(
      ChatComposerAttachmentNotice.UnsupportedType,
      chatAttachmentOmissionNotice(unsupportedCount = 1, otherFailureCount = 0),
    )
    assertEquals(
      ChatComposerAttachmentNotice.Attachment,
      chatAttachmentOmissionNotice(unsupportedCount = 1, otherFailureCount = 1),
    )
    assertNull(chatAttachmentOmissionNotice(unsupportedCount = 0, otherFailureCount = 0))
  }
}
