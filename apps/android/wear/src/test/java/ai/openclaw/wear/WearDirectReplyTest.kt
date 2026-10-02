package ai.openclaw.wear

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearDirectReplyTest {
  @Test
  fun incompletePreviewsRetainCanonicalLookupIdentity() {
    val contents =
      listOf(
        JsonPrimitive("x".repeat(4001)),
        JsonPrimitive("x".repeat(3999) + "\uD83D\uDE00"),
        JsonPrimitive("x".repeat(2000) + "\n...(truncated)..."),
      )
    for (content in contents) {
      val message =
        checkNotNull(
          directChatMessage(
            buildJsonObject {
              put("id", "display-id")
              put("role", "assistant")
              put("__openclaw", buildJsonObject { put("id", "stored-entry") })
              put("content", content)
            },
          ),
        )
      assertEquals("stored-entry", message.entryId)
      assertEquals(true, message.textTruncated)
      assertTrue(message.text.length <= 4000)
      assertTrue(!message.text.last().isHighSurrogate())
    }
  }

  @Test
  fun textAfterTwentyNonTextPartsRemainsReadable() {
    val message =
      directChatMessage(
        buildJsonObject {
          put("role", "assistant")
          put(
            "content",
            buildJsonArray {
              repeat(20) { add(buildJsonObject { put("type", "image") }) }
              add(
                buildJsonObject {
                  put("type", "text")
                  put("text", "TAIL SENTINEL")
                },
              )
            },
          )
        },
      )
    assertNotNull(message)
    assertEquals("TAIL SENTINEL", message!!.text)
    assertEquals(false, message.textTruncated)
  }

  @Test
  fun gatewayTruncationCannotBeMistakenForCompleteLocalText() {
    for (truncated in listOf(false, true)) {
      val message =
        checkNotNull(
          directChatMessage(
            buildJsonObject {
              put("role", "assistant")
              put("__openclaw", buildJsonObject { put("truncated", truncated) })
              put("content", "Short projected reply")
            },
          ),
        )
      assertEquals(truncated, message.textTruncated)
    }
  }
}
