package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearProxyControllerTest {
  private val json = Json

  @Test
  fun statusDoesNotTouchGateway() =
    runTest {
      var gatewayCalls = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            gatewayCalls += 1
            buildJsonObject {}
          },
          isGatewayConnected = { false },
          gatewayStatusText = { "Offline" },
        )

      val response = controller.handle(request(WearRpcMethod.ProxyStatus))

      assertTrue(response.ok)
      assertEquals(0, gatewayCalls)
      val result = checkNotNull(response.result).jsonObject
      assertEquals(
        false,
        result
          .getValue("connected")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
      assertEquals("Offline", result.getValue("status").jsonPrimitive.content)
    }

  @Test
  fun sessionsListBuildsFixedGatewayScopeAndProjectsRows() =
    runTest {
      var requestedMethod: String? = null
      var requestedParams: JsonObject? = null
      val controller =
        controller { method, params ->
          requestedMethod = method
          requestedParams = params
          json.parseToJsonElement(
            """{"sessions":[{"key":"agent:main","displayName":"Main","updatedAt":7,"model":"secret-model","lastMessage":"hidden"}],"hasMore":true,"totalCount":9}""",
          )
        }

      val response =
        controller.handle(
          request(
            WearRpcMethod.SessionsList,
            buildJsonObject { put("limit", 5) },
          ),
        )

      assertEquals("sessions.list", requestedMethod)
      assertEquals(
        json
          .parseToJsonElement("""{"limit":5,"includeGlobal":false,"includeUnknown":false}""")
          .jsonObject,
        requestedParams,
      )
      val result = checkNotNull(response.result).jsonObject
      val session =
        result
          .getValue("sessions")
          .jsonArray
          .single()
          .jsonObject
      assertEquals(setOf("key", "displayName", "updatedAt"), session.keys)
      assertEquals(
        true,
        result
          .getValue("hasMore")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
    }

  @Test
  fun historyBoundsGatewayRequestAndDropsBinaryContent() =
    runTest {
      var requestedParams: JsonObject? = null
      val controller =
        controller { method, params ->
          assertEquals("chat.history", method)
          requestedParams = params
          json.parseToJsonElement(
            """{"sessionKey":"main","messages":[{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello 😀"},{"type":"image","base64":"private"}],"timestamp":9}],"defaults":{"token":"hidden"},"offset":40,"nextOffset":60,"totalMessages":80,"hasMore":true}""",
          )
        }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatHistory,
            buildJsonObject {
              put("sessionKey", "main")
              put("limit", 20)
              put("maxChars", 2_000)
              put("offset", 40)
            },
          ),
        )

      assertEquals(
        json
          .parseToJsonElement("""{"sessionKey":"main","limit":20,"maxChars":2000,"offset":40}""")
          .jsonObject,
        requestedParams,
      )
      val result = checkNotNull(response.result).jsonObject
      assertFalse("defaults" in result)
      assertEquals(
        40,
        result
          .getValue("offset")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertEquals(
        60,
        result
          .getValue("nextOffset")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertEquals(
        80,
        result
          .getValue("totalMessages")
          .jsonPrimitive
          .content
          .toInt(),
      )
      assertTrue(
        result
          .getValue("hasMore")
          .jsonPrimitive
          .content
          .toBoolean(),
      )
      val content =
        result
          .getValue("messages")
          .jsonArray
          .single()
          .jsonObject
          .getValue("content")
          .jsonArray
      assertEquals(1, content.size)
      assertEquals(
        "hello 😀",
        content
          .single()
          .jsonObject
          .getValue("text")
          .jsonPrimitive
          .content,
      )
      assertTrue(WearProtocolCodec.encode(response).isNotEmpty())
    }

  @Test
  fun sendForwardsOnlyApprovedFields() =
    runTest {
      var requestedParams: JsonObject? = null
      val controller =
        controller { method, params ->
          assertEquals("chat.send", method)
          requestedParams = params
          json.parseToJsonElement("""{"runId":"run-1","status":"started","internal":true}""")
        }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "reply")
              put("idempotencyKey", "wear-1")
            },
          ),
        )

      assertEquals(
        json
          .parseToJsonElement(
            """{"sessionKey":"main","message":"reply","idempotencyKey":"wear-1","deliver":false}""",
          ).jsonObject,
        requestedParams,
      )
      assertEquals(setOf("runId", "status"), checkNotNull(response.result).jsonObject.keys)
    }

  @Test
  fun rejectsUnknownOrOversizedWatchFieldsBeforeGateway() =
    runTest {
      var gatewayCalls = 0
      val controller =
        controller { _, _ ->
          gatewayCalls += 1
          buildJsonObject {}
        }
      val unknownField =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "reply")
              put("idempotencyKey", "wear-1")
              put("attachments", "not allowed")
            },
          ),
        )
      val oversized =
        controller.handle(
          request(
            WearRpcMethod.ChatSend,
            buildJsonObject {
              put("sessionKey", "main")
              put("message", "x".repeat(4_001))
              put("idempotencyKey", "wear-2")
            },
          ),
        )

      assertEquals(0, gatewayCalls)
      assertEquals("invalid_request", unknownField.error?.code)
      assertEquals("invalid_request", oversized.error?.code)
    }

  @Test
  fun preservesBoundedGatewayError() =
    runTest {
      val controller =
        controller { _, _ -> throw WearProxyGatewayException("INVALID_REQUEST", "session unavailable") }

      val response =
        controller.handle(
          request(
            WearRpcMethod.ChatAbort,
            buildJsonObject { put("sessionKey", "main") },
          ),
        )

      assertFalse(response.ok)
      assertEquals("INVALID_REQUEST", response.error?.code)
      assertEquals("session unavailable", response.error?.message)
      assertNotNull(WearProtocolCodec.encode(response))
    }

  @Test
  fun chatEventPreservesReplacementSemantics() {
    val payload =
      checkNotNull(
        projectWearChatEvent(
          json.parseToJsonElement(
            """{"runId":"run-1","state":"delta","deltaText":"replacement","replace":true,"privateField":"drop"}""",
          ),
        ),
      )

    assertEquals(setOf("runId", "state", "deltaText", "replace"), payload.keys)
    assertTrue(
      payload
        .getValue("replace")
        .jsonPrimitive
        .content
        .toBoolean(),
    )
  }

  @Test
  fun chatEventBoundsAggregateContentAndPreservesTerminalState() {
    val payload =
      checkNotNull(
        projectWearChatEvent(
          buildJsonObject {
            put("runId", "run-1")
            put("state", "final")
            put(
              "message",
              buildJsonObject {
                put("role", "assistant")
                put(
                  "content",
                  buildJsonArray {
                    repeat(100) {
                      add(
                        buildJsonObject {
                          put("type", "text")
                          put("text", "😀".repeat(2_000))
                        },
                      )
                    }
                  },
                )
              },
            )
          },
        ),
      )

    assertEquals("final", payload.getValue("state").jsonPrimitive.content)
    val content =
      payload
        .getValue("message")
        .jsonObject
        .getValue("content")
        .jsonArray
    val projectedBytes =
      content.sumOf { part ->
        part.jsonObject
          .getValue("text")
          .jsonPrimitive.content
          .toByteArray(Charsets.UTF_8)
          .size
      }
    assertTrue(projectedBytes <= 1_024)
    assertTrue(content.size < 100)
    assertTrue(
      WearProtocolCodec
        .encode(
          WearMessage.Event(
            sequence = 1,
            event = WearEventType.Chat,
            payload = payload,
          ),
        ).isNotEmpty(),
    )
  }

  private fun controller(requestGateway: suspend (String, JsonObject) -> JsonElement): WearProxyController =
    WearProxyController(
      requestGateway = requestGateway,
      isGatewayConnected = { true },
      gatewayStatusText = { "Connected" },
    )

  private fun request(
    method: WearRpcMethod,
    params: JsonObject = buildJsonObject {},
  ): WearMessage.Request = WearMessage.Request(requestId = "req-1", method = method, params = params)
}
