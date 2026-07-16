package ai.openclaw.wear.shared

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WearProtocolTest {
  @Test
  fun roundTripsEveryEnvelopeKind() {
    val messages =
      listOf(
        WearMessage.Request(
          requestId = "req-1",
          method = WearRpcMethod.ChatHistory,
          params = buildJsonObject { put("sessionKey", "main") },
        ),
        WearMessage.Response(
          requestId = "req-1",
          ok = true,
          result = buildJsonObject { put("count", 2) },
        ),
        WearMessage.Response(
          requestId = "req-2",
          ok = false,
          error = WearRpcError(code = "unavailable", message = "Phone offline"),
        ),
        WearMessage.Event(
          sequence = 7,
          event = WearEventType.Chat,
          payload = buildJsonObject { put("state", "delta") },
        ),
      )

    messages.forEach { message ->
      assertEquals(WearDecodeResult.Success(message), WearProtocolCodec.decode(WearProtocolCodec.encode(message)))
    }
  }

  @Test
  fun usesStableWireNamesAndPaths() {
    val request =
      WearMessage.Request(
        requestId = "req-1",
        method = WearRpcMethod.ChatSend,
      )
    val encoded = WearProtocolCodec.encode(request).decodeToString()
    val root = Json.parseToJsonElement(encoded).jsonObject

    assertEquals("request", root.getValue("type").jsonPrimitive.content)
    assertEquals("chat.send", root.getValue("method").jsonPrimitive.content)
    assertEquals("/openclaw/wear/v1/request", WearProtocol.REQUEST_PATH)
    assertEquals("/openclaw/wear/v1/response", WearProtocol.RESPONSE_PATH)
    assertEquals("/openclaw/wear/v1/event", WearProtocol.EVENT_PATH)
  }

  @Test
  fun ignoresUnknownFieldsWithinCurrentVersion() {
    val bytes =
      """{"type":"request","version":1,"requestId":"req-1","method":"proxy.status","params":{},"future":true}"""
        .encodeToByteArray()

    assertEquals(
      WearDecodeResult.Success(
        WearMessage.Request(requestId = "req-1", method = WearRpcMethod.ProxyStatus),
      ),
      WearProtocolCodec.decode(bytes),
    )
  }

  @Test
  fun rejectsMalformedUnsupportedAndInvalidMessages() {
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Empty),
      WearProtocolCodec.decode(byteArrayOf()),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Malformed),
      WearProtocolCodec.decode("not-json".encodeToByteArray()),
    )
    val invalidUtf8 =
      """{"type":"request","version":1,"requestId":"""".encodeToByteArray() +
        byteArrayOf(0xc3.toByte(), 0x28) +
        """","method":"proxy.status","params":{}}""".encodeToByteArray()
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.Malformed),
      WearProtocolCodec.decode(invalidUtf8),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.UnsupportedVersion),
      WearProtocolCodec.decode(
        """{"type":"future-message","version":2,"futureRequiredField":true}"""
          .encodeToByteArray(),
      ),
    )
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.InvalidEnvelope),
      WearProtocolCodec.decode(
        """{"type":"response","version":1,"requestId":"req-1","ok":false}""".encodeToByteArray(),
      ),
    )
  }

  @Test
  fun rejectsOversizedMessagesOnEncodeAndDecode() {
    val oversizedBytes = ByteArray(WearProtocol.MAX_MESSAGE_BYTES + 1)
    assertEquals(
      WearDecodeResult.Failure(WearDecodeFailureReason.TooLarge),
      WearProtocolCodec.decode(oversizedBytes),
    )

    val oversizedMessage =
      WearMessage.Request(
        requestId = "req-1",
        method = WearRpcMethod.ChatSend,
        params = buildJsonObject { put("message", "x".repeat(WearProtocol.MAX_MESSAGE_BYTES)) },
      )
    assertThrows(IllegalArgumentException::class.java) {
      WearProtocolCodec.encode(oversizedMessage)
    }
  }

  @Test
  fun encodingIsDeterministic() {
    val message = WearMessage.Request(requestId = "req-1", method = WearRpcMethod.SessionsList)
    assertArrayEquals(WearProtocolCodec.encode(message), WearProtocolCodec.encode(message))
  }
}
