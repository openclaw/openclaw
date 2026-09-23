package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

/** On-demand pages, not a larger preview or an unbounded Data Layer frame. */
object WearReplyText {
  const val MAX_TEXT_LENGTH = 1_000_000
  const val PAGE_LENGTH = 4_096

  /** Twenty Talk previews must fit one event even when JSON expands control characters. */
  fun preview(text: String): String {
    var low = 0
    var high = minOf(text.length, 1_500)
    while (low < high) {
      val middle = (low + high + 1) / 2
      val candidate = text.substring(0, middle)
      if (JsonPrimitive(candidate).toString().toByteArray(Charsets.UTF_8).size <= 2_048) low = middle else high = middle - 1
    }
    if (low > 0 && text[low - 1].isHighSurrogate()) low--
    return text.substring(0, low)
  }

  fun revision(
    text: String,
    owner: String,
  ): String = MessageDigest.getInstance("SHA-256").digest((owner + "\u0000" + text).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

  fun page(
    text: String,
    owner: String,
    offset: Int,
    expectedRevision: String?,
  ): WearReplyTextPage {
    if (text.length > MAX_TEXT_LENGTH) return WearReplyTextPage(status = WearReplyTextStatus.TooLarge)
    val revision = revision(text, owner)
    if (expectedRevision != null && expectedRevision != revision) return WearReplyTextPage(status = WearReplyTextStatus.Changed)
    if (offset !in 0..text.length || (offset > 0 && expectedRevision == null) ||
      (offset < text.length && text[offset].isLowSurrogate())
    ) {
      return WearReplyTextPage(status = WearReplyTextStatus.Unavailable)
    }
    var end = minOf(text.length, offset + PAGE_LENGTH)
    if (end < text.length && text[end].isLowSurrogate()) end--
    return WearReplyTextPage(
      status = WearReplyTextStatus.Ready,
      text = text.substring(offset, end),
      offset = offset,
      nextOffset = end.takeIf { it < text.length },
      totalLength = text.length,
      revision = revision,
    )
  }

  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
      explicitNulls = false
    }

  fun encode(page: WearReplyTextPage): JsonElement = json.encodeToJsonElement(WearReplyTextPage.serializer(), page)

  fun decode(value: JsonElement): WearReplyTextPage = json.decodeFromJsonElement(WearReplyTextPage.serializer(), value)
}

@Serializable
enum class WearReplyTextStatus { Ready, Unavailable, Unsupported, TooLarge, Changed, Failed }

@Serializable
data class WearReplyTextPage(
  val status: WearReplyTextStatus,
  val text: String = "",
  val offset: Int = 0,
  val nextOffset: Int? = null,
  val totalLength: Int = 0,
  val revision: String? = null,
)
