package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeErrorParserTest {
  @Test
  fun parseInvokeErrorMessage_parsesUppercaseCodePrefix() {
    val parsed = parseInvokeErrorMessage("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
    assertEquals("CAMERA_PERMISSION_REQUIRED", parsed.code)
    assertEquals("grant Camera permission", parsed.message)
    assertTrue(parsed.hadExplicitCode)
    assertEquals("CAMERA_PERMISSION_REQUIRED: grant Camera permission", parsed.prefixedMessage)
  }

  @Test
  fun parseInvokeErrorMessage_rejectsNonCanonicalCodePrefix() {
    val parsed = parseInvokeErrorMessage("IllegalStateException: boom")
    assertEquals("UNAVAILABLE", parsed.code)
    assertEquals("IllegalStateException: boom", parsed.message)
    assertFalse(parsed.hadExplicitCode)
  }

  @Test
  fun parseInvokeErrorFromThrowable_usesFallbackWhenMessageMissing() {
    val parsed = parseInvokeErrorFromThrowable(IllegalStateException(), fallbackMessage = "fallback")
    assertEquals("UNAVAILABLE", parsed.code)
    assertEquals("fallback", parsed.message)
    assertFalse(parsed.hadExplicitCode)
  }
}
