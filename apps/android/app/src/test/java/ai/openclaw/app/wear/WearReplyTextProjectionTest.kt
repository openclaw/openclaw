package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextStatus
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearReplyTextProjectionTest {
  private fun reply(
    text: String,
    id: String = "canonical",
    truncated: Boolean? = false,
    synthetic: Boolean = false,
  ) = buildJsonObject {
    put("ok", true)
    put(
      "message",
      buildJsonObject {
        put("role", "assistant")
        put("id", "not-the-lookup-id")
        put(
          "__openclaw",
          buildJsonObject {
            put("id", id)
            truncated?.let { put("truncated", it) }
          },
        )
        if (synthetic) put("openclawStreamFallback", buildJsonObject {})
        put(
          "content",
          buildJsonArray {
            add(
              buildJsonObject {
                put("type", "text")
                put("text", text)
              },
            )
            add(
              buildJsonObject {
                put("type", "toolCall")
                put("text", "NOT USER TEXT")
              },
            )
          },
        )
      },
    )
  }

  @Test fun historyAndFullTextUseCanonicalIdentityAndWirePages() =
    runTest {
      val full = "Grüße 👩🏽‍🚀\n".repeat(600) + "TRAILING SENTINEL"
      val source = reply(full)
      val controller =
        WearProxyController(
          requestGateway = { method, _ ->
            assertEquals("chat.history", method)
            buildJsonObject { put("messages", buildJsonArray { add(source.getValue("message")) }) }
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          readChatReply = { session, agent, entry, offset, revision ->
            assertEquals("global", session)
            assertEquals("fixture-agent", agent)
            projectWearFullReply(source, entry, "$agent:$session", offset, revision)
          },
        )
      val history = controller.handle(WearMessage.Request(requestId = "history", method = WearRpcMethod.ChatHistory, params = buildJsonObject { put("sessionKey", "global") }), "watch")
      val preview =
        history.result!!
          .jsonObject
          .getValue("messages")
          .jsonArray
          .single()
          .jsonObject
      assertEquals("canonical", preview.getValue("entryId").jsonPrimitive.content)
      assertEquals(JsonPrimitive(true), preview["textTruncated"])
      assertFalse(wearReplyText(preview).contains("TRAILING SENTINEL"))
      var offset = 0
      var revision: String? = null
      val recovered = StringBuilder()
      do {
        val request =
          WearMessage.Request(
            requestId = "page-$offset",
            method = WearRpcMethod.ReplyText,
            params =
              buildJsonObject {
                put("source", "chat")
                put("sessionKey", "global")
                put("agentId", "fixture-agent")
                put("entryId", "canonical")
                put("offset", offset)
                revision?.let { put("revision", it) }
              },
          )
        val response = controller.handle(request, "watch")
        WearProtocolCodec.encode(response)
        assertTrue(response.ok)
        val page = WearReplyText.decode(response.result!!)
        assertEquals(WearReplyTextStatus.Ready, page.status)
        recovered.append(page.text)
        revision = page.revision
        offset = page.nextOffset ?: break
      } while (true)
      assertEquals(full, recovered.toString())
    }

  @Test fun missingChangedSyntheticAndStillTruncatedResponsesAreNotFullText() {
    fun status(
      value: JsonElement,
      revision: String? = null,
    ) = projectWearFullReply(value, "canonical", "owner", 0, revision).status
    assertEquals(WearReplyTextStatus.Unavailable, status(reply("text", id = "different")))
    assertEquals(WearReplyTextStatus.Unavailable, status(reply("text", synthetic = true)))
    assertEquals(WearReplyTextStatus.TooLarge, status(reply("text", truncated = true)))
    assertEquals(WearReplyTextStatus.TooLarge, status(reply("x".repeat(WearReplyText.MAX_TEXT_LENGTH) + "\n...(truncated)...", truncated = null)))
    assertEquals(WearReplyTextStatus.Ready, status(reply("literal ...(truncated)...", truncated = null)))
    assertEquals(WearReplyTextStatus.Changed, status(reply("changed"), WearReplyText.revision("old", "owner")))
    assertEquals(
      WearReplyTextStatus.Unavailable,
      status(
        buildJsonObject {
          put("ok", false)
          put("unavailableReason", "not_visible")
        },
      ),
    )
    assertEquals(
      WearReplyTextStatus.TooLarge,
      status(
        buildJsonObject {
          put("ok", false)
          put("unavailableReason", "oversized")
        },
      ),
    )
  }

  @Test fun successfulFullReadRequiresUsableText() {
    val contents =
      listOf<JsonElement?>(
        null,
        JsonPrimitive(""),
        JsonArray(emptyList()),
        JsonPrimitive(" \n\t"),
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "text")
              put("text", "")
            },
          )
        },
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "text")
              put("text", " \t")
            },
          )
        },
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "image")
              put("url", "fixture")
            },
          )
        },
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "toolCall")
              put("text", "not user-visible text")
            },
          )
        },
      )
    val failures = mutableListOf<String>()
    contents.forEachIndexed { index, content ->
      val result =
        buildJsonObject {
          put("ok", true)
          put(
            "message",
            buildJsonObject {
              put("role", "assistant")
              put("__openclaw", buildJsonObject { put("id", "canonical") })
              content?.let { put("content", it) }
            },
          )
        }
      val page = projectWearFullReply(result, "canonical", "owner", 0, null)
      if (page.status != WearReplyTextStatus.Failed) failures += "case=$index status=${page.status} length=${page.text.length}"
    }
    assertEquals("Invalid full reads must be retryable failures", emptyList<String>(), failures)
    for (text in listOf("Hi", "  Grüße 👩🏽🚀\n")) {
      val page = projectWearFullReply(reply(text), "canonical", "owner", 0, null)
      assertEquals(WearReplyTextStatus.Ready, page.status)
      assertEquals(text, page.text)
    }
  }

  @Test fun tailOnlyStreamIsNotUsedAsFullReplySource() {
    val projector = WearChatStreamProjector()
    val text = "HEAD SENTINEL" + "x".repeat(5000) + "TRAILING SENTINEL"
    var projection: JsonObject? = null
    text.chunked(500).forEach { chunk ->
      projection =
        projector.project(
          buildJsonObject {
            put("sessionKey", "fixture")
            put("runId", "run")
            put("state", "delta")
            put("deltaText", chunk)
          },
        )
    }
    assertTrue(
      projection!!
        .getValue("streamText")
        .jsonPrimitive.content.length <= 2000,
    )
    assertFalse(
      projection
        .getValue("streamText")
        .jsonPrimitive.content
        .contains("HEAD SENTINEL"),
    )
    val first = projectWearFullReply(reply(text), "canonical", "owner", 0, null)
    val second = projectWearFullReply(reply(text), "canonical", "owner", first.nextOffset!!, first.revision)
    assertEquals(text, first.text + second.text)
  }
}
