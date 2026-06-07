package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkResponseEnvelopeParserTest {
  @Test
  fun parsesWholeObjectResponse() {
    val result = TalkResponseEnvelopeParser.parse("""{"response":"I will check that.","status":"working"}""")

    assertTrue(result.isEnvelope)
    assertEquals("I will check that.", result.response)
    assertEquals(listOf("response", "status"), result.keys)
  }

  @Test
  fun parsesFirstLineObjectResponse() {
    val result =
      TalkResponseEnvelopeParser.parse(
        """
        {"response":"Done."}
        non-spoken diagnostic
        """.trimIndent(),
      )

    assertTrue(result.isEnvelope)
    assertEquals("Done.", result.response)
  }

  @Test
  fun parsesFencedObjectResponse() {
    val result =
      TalkResponseEnvelopeParser.parse(
        """
        ```json
        {"response":"Ready."}
        ```
        """.trimIndent(),
      )

    assertTrue(result.isEnvelope)
    assertEquals("Ready.", result.response)
  }

  @Test
  fun plainTextIsNotEnvelope() {
    val result = TalkResponseEnvelopeParser.parse("Plain reply.")

    assertFalse(result.isEnvelope)
    assertNull(result.response)
  }

  @Test
  fun emptyResponseSuppressesSpeech() {
    val result = TalkResponseEnvelopeParser.parse("""{"response":"   ","status":"queued"}""")

    assertTrue(result.isEnvelope)
    assertNull(result.response)
  }
}
