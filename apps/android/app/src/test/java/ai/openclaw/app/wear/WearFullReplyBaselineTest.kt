package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearFullReplyBaselineTest {
  @Test
  fun historyPreservesLookupIdentityAndOffersTheMissingTail() =
    runTest {
      val full = "Grüße 👩🏽‍🚀\n".repeat(300) + "TRAILING SENTINEL"
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            buildJsonObject {
              put(
                "messages",
                kotlinx.serialization.json.buildJsonArray {
                  add(
                    buildJsonObject {
                      put("role", "assistant")
                      put("__openclaw", buildJsonObject { put("id", "stable-entry") })
                      put("content", full)
                    },
                  )
                },
              )
            }
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
        )
      val response = controller.handle(WearMessage.Request(requestId = "baseline", method = WearRpcMethod.ChatHistory, params = buildJsonObject { put("sessionKey", "agent:fixture:chat") }))
      WearProtocolCodec.encode(response)
      val message =
        response.result!!
          .jsonObject
          .getValue("messages")
          .jsonArray
          .single()
          .jsonObject
      assertEquals("stable-entry", message["entryId"]?.jsonPrimitive?.content)
      assertTrue(message["textTruncated"] == JsonPrimitive(true))
    }
}
