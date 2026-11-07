package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Constants and codecs mirror packages/openclaw-id-protocol/src/tunnel. */
internal object OpenClawIdFrames {
  const val MAX_FRAME_BYTES = 32 * 1024 * 1024
  const val MAX_HEAD_BYTES = 64 * 1024
  const val BAD_REQUEST = 4L

  fun encode(
    payload: ByteArray,
    limit: Int = MAX_FRAME_BYTES,
  ): ByteArray {
    if (payload.size > limit) throw OpenClawIdProtocolException()
    return ByteBuffer
      .allocate(4 + payload.size)
      .putInt(payload.size)
      .put(payload)
      .array()
  }

  fun webSocketHead(path: String): ByteArray {
    if (!path.startsWith('/') || path.any { it.code < 32 || it.code == 127 }) throw OpenClawIdProtocolException()
    // W is the credential. Never copy shared tokens, Access headers, or identity headers here.
    val head =
      buildJsonObject {
        put("kind", "ws")
        put("path", path)
        put("headers", JsonArray(emptyList()))
        put("protocols", JsonArray(emptyList()))
      }.toString().toByteArray(Charsets.UTF_8)
    if (head.size > MAX_HEAD_BYTES) throw OpenClawIdProtocolException()
    return head
  }

  fun responseStatus(payload: ByteArray): Int {
    if (payload.size > MAX_HEAD_BYTES) throw OpenClawIdProtocolException()
    val head =
      try {
        Json.parseToJsonElement(utf8(payload)) as? JsonObject ?: throw OpenClawIdProtocolException()
      } catch (_: IllegalArgumentException) {
        throw OpenClawIdProtocolException()
      }
    val statusValue = head["status"] as? JsonPrimitive ?: throw OpenClawIdProtocolException()
    val status = statusValue.intOrNull ?: throw OpenClawIdProtocolException()
    if (statusValue.isString || status !in 100..599) throw OpenClawIdProtocolException()
    if (status == 101) {
      val protocol = head["protocol"]
      if (protocol != null && protocol != JsonNull && (protocol !is JsonPrimitive || !protocol.isString)) throw OpenClawIdProtocolException()
      // This node requests no subprotocol, so the server cannot select one.
      if (protocol != null && protocol != JsonNull) throw OpenClawIdProtocolException()
    } else {
      val headers = head["headers"] ?: JsonArray(emptyList())
      if (headers !is JsonArray ||
        headers.any { pair ->
          pair !is JsonArray || pair.size != 2 || pair.any { it !is JsonPrimitive || !it.isString }
        }
      ) {
        throw OpenClawIdProtocolException()
      }
    }
    return status
  }

  sealed interface Message {
    data class Text(
      val text: String,
    ) : Message

    data class Binary(
      val bytes: ByteArray,
    ) : Message

    data class Close(
      val code: Int?,
      val reason: String,
    ) : Message
  }

  fun message(payload: ByteArray): Message {
    if (payload.isEmpty() || payload.size > MAX_FRAME_BYTES) throw OpenClawIdProtocolException()
    return when (payload[0].toInt()) {
      1 -> {
        Message.Text(utf8(payload.copyOfRange(1, payload.size)))
      }

      2 -> {
        Message.Binary(payload.copyOfRange(1, payload.size))
      }

      8 -> {
        when (payload.size) {
          1 -> Message.Close(null, "")
          2 -> throw OpenClawIdProtocolException()
          else -> Message.Close(((payload[1].toInt() and 255) shl 8) or (payload[2].toInt() and 255), utf8(payload.copyOfRange(3, payload.size)))
        }
      }

      else -> {
        throw OpenClawIdProtocolException()
      }
    }
  }

  fun text(text: String): ByteArray = data(1, text.toByteArray(Charsets.UTF_8))

  fun binary(bytes: ByteArray): ByteArray = data(2, bytes)

  fun close(
    code: Int?,
    reason: String = "",
  ): ByteArray {
    if (code == null) return byteArrayOf(8)
    if (code !in 1000..4999 || code in listOf(1004, 1005, 1006, 1015) || code in 1016..2999) throw OpenClawIdProtocolException()
    val bytes = reason.toByteArray(Charsets.UTF_8)
    if (bytes.size > 123) throw OpenClawIdProtocolException()
    return ByteBuffer
      .allocate(3 + bytes.size)
      .put(8.toByte())
      .putShort(code.toShort())
      .put(bytes)
      .array()
  }

  private fun data(
    op: Int,
    bytes: ByteArray,
  ): ByteArray {
    if (bytes.size >= MAX_FRAME_BYTES) throw OpenClawIdProtocolException()
    return byteArrayOf(op.toByte()) + bytes
  }

  private fun utf8(bytes: ByteArray): String =
    try {
      Charsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (_: java.nio.charset.CharacterCodingException) {
      throw OpenClawIdProtocolException()
    }
}

/** Reads the length before allocating its payload, including on the initial bounded HEAD. */
internal class OpenClawIdFrameReader(
  private val receive: OpenClawIdReceiveStream,
  private val onReceived: () -> Unit = {},
) {
  suspend fun next(limit: Int = OpenClawIdFrames.MAX_FRAME_BYTES): ByteArray? {
    val header = exact(4, allowEof = true) ?: return null
    val length = ByteBuffer.wrap(header).int.toLong() and 0xffffffffL
    if (length > limit) throw OpenClawIdProtocolException()
    return exact(length.toInt(), allowEof = false) ?: throw OpenClawIdProtocolException()
  }

  private suspend fun exact(
    size: Int,
    allowEof: Boolean,
  ): ByteArray? {
    val out = ByteArray(size)
    var position = 0
    while (position < size) {
      val bytes = receive.read(minOf(size - position, 1024 * 1024))
      if (bytes == null) {
        if (allowEof && position == 0) return null
        throw OpenClawIdProtocolException()
      }
      if (bytes.isEmpty() || bytes.size > size - position) throw OpenClawIdProtocolException()
      bytes.copyInto(out, position)
      position += bytes.size
      onReceived()
    }
    return out
  }
}
