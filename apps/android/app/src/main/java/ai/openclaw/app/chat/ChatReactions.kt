package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySessionRouting
import ai.openclaw.app.gateway.MessageReactionSummary
import ai.openclaw.app.gateway.MessageReactionSummaryIdentitiesItem
import android.icu.lang.UCharacter
import android.icu.lang.UProperty
import android.icu.text.BreakIterator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

data class ChatReactionSummary(
  val emoji: String,
  val count: Int,
  val identities: List<MessageReactionSummaryIdentitiesItem>,
)

data class ChatReactionAccess(
  val role: String? = null,
  val scopes: Set<String> = emptySet(),
  val sessionCap: String? = null,
  val viewerId: String? = null,
)

internal fun canReactToSession(
  access: ChatReactionAccess,
  session: ChatSessionEntry?,
  connected: Boolean,
  methodAdvertised: Boolean,
  catalog: Boolean,
): Boolean {
  val role = session?.sharingRole ?: return false
  if (
    !connected || !methodAdvertised || catalog || session.archived == true ||
    access.role?.trim() != "operator" || access.sessionCap == "none" ||
    access.scopes.none { it.trim() == "operator.write" || it.trim() == "operator.admin" }
  ) {
    return false
  }
  val visibility = session.visibility ?: "shared"
  if (visibility == "draft") return role == "owner" || role == "admin"
  if (role != "viewer") return true
  return when (visibility) {
    "shared" -> access.sessionCap != "view" && access.sessionCap != "suggest"
    "suggest" -> access.sessionCap != "view"
    else -> false
  }
}

internal fun isReactionCatalogSession(sessionKey: String): Boolean = sessionKey.replace(Regex("^agent:[^:]+:"), "").startsWith("catalog:")

internal fun reactionEventMatchesSession(
  sessionKey: String,
  ownerAgentId: String,
  eventSessionKey: String,
  eventAgentId: String,
  routing: GatewaySessionRouting?,
): Boolean {
  if (ownerAgentId != eventAgentId) return false

  fun canonical(key: String): String {
    val parts = key.split(":", limit = 3)
    val qualified = parts.size == 3 && parts[0] == "agent"
    if (qualified && parts[1] != ownerAgentId) return key
    val rest = if (qualified) parts[2] else key
    val main = rest == "main" || rest == routing?.mainKey
    val suffix =
      when {
        main && routing?.mainSessionKey == "global" -> "global"
        main -> routing?.mainKey?.takeIf { it.isNotBlank() } ?: "main"
        else -> rest
      }
    return "agent:$ownerAgentId:$suffix"
  }
  return canonical(sessionKey) == canonical(eventSessionKey)
}

/** Uses the same one-grapheme sequence grammar as the Gateway reaction validator. */
internal fun isReactionEmoji(emoji: String): Boolean {
  val points = emoji.codePoints().toArray()
  if (points.isEmpty() || points.size > 32) return false
  val graphemes = BreakIterator.getCharacterInstance(Locale.ENGLISH)
  graphemes.setText(emoji)
  graphemes.first()
  if (graphemes.next() != emoji.length || graphemes.next() != BreakIterator.DONE) return false
  if (points.size == 2 && points.all { it in 0x1F1E6..0x1F1FF }) return true
  if (
    points.first() in "#*0123456789".map(Char::code) &&
    (points.size == 2 || (points.size == 3 && points[1] == 0xFE0F)) &&
    points.last() == 0x20E3
  ) {
    return true
  }
  if (
    points.size >= 3 && points.first() == 0x1F3F4 && points.last() == 0xE007F &&
    points.sliceArray(1 until points.lastIndex).all { it in 0xE0061..0xE007A }
  ) {
    return true
  }
  var index = 0
  while (index < points.size) {
    if (!UCharacter.hasBinaryProperty(points[index++], UProperty.EXTENDED_PICTOGRAPHIC)) return false
    if (index < points.size && points[index] == 0xFE0F) index += 1
    if (index < points.size && UCharacter.hasBinaryProperty(points[index], UProperty.EMOJI_MODIFIER)) index += 1
    if (index == points.size) return true
    if (points[index++] != 0x200D || index == points.size) return false
  }
  return false
}

internal fun MessageReactionSummary.toChatReactionSummary(): ChatReactionSummary =
  ChatReactionSummary(
    emoji = emoji,
    count = Math.toIntExact(count),
    identities = identities,
  )

/** State changes run under the controller's publication lock; queued writes wait outside it. */
internal class ChatReactions {
  private val mutableReactions = MutableStateFlow<Map<String, List<ChatReactionSummary>>>(emptyMap())
  val reactions = mutableReactions.asStateFlow()
  private var generation = 0L
  private var readGeneration = 0L
  private var readUpdates: MutableMap<String, List<ChatReactionSummary>>? = null
  private val revisions = mutableMapOf<String, Long>()
  private val writes = mutableMapOf<Pair<String, String>, Write>()
  private val writeTails = mutableMapOf<String, Write>()

  class Write(
    val messageId: String,
    val emoji: String,
    val generation: Long,
    private val previous: CompletableDeferred<Unit>?,
  ) {
    val completion = CompletableDeferred<Unit>()
    var revision = 0L

    suspend fun awaitTurn() {
      previous?.await()
    }
  }

  fun reset() {
    generation += 1
    readGeneration += 1
    readUpdates = null
    revisions.clear()
    writes.clear()
    writeTails.clear()
    mutableReactions.value = emptyMap()
  }

  fun beginRead(): Long {
    readGeneration += 1
    readUpdates = mutableMapOf()
    return readGeneration
  }

  fun isCurrentRead(expectedGeneration: Long): Boolean = readGeneration == expectedGeneration

  fun applyRead(
    expectedGeneration: Long,
    reactions: Map<String, List<ChatReactionSummary>>,
  ) {
    if (!isCurrentRead(expectedGeneration)) return
    for (messageId in revisions.keys + reactions.keys) {
      revisions[messageId] = (revisions[messageId] ?: 0) + 1
    }
    mutableReactions.value = reactions + readUpdates.orEmpty()
  }

  fun finishRead(expectedGeneration: Long) {
    if (isCurrentRead(expectedGeneration)) readUpdates = null
  }

  fun applyEvent(
    messageId: String,
    reactions: List<ChatReactionSummary>,
  ) {
    revisions[messageId] = (revisions[messageId] ?: 0) + 1
    publish(messageId, reactions)
  }

  fun beginWrite(
    messageId: String,
    emoji: String,
  ): Write =
    Write(messageId, emoji, generation, writeTails[messageId]?.completion).also {
      writes[messageId to emoji] = it
      writeTails[messageId] = it
    }

  fun isCurrent(write: Write): Boolean = write.generation == generation && writes[write.messageId to write.emoji] === write

  fun prepareWrite(write: Write): Boolean {
    if (write.generation != generation) return false
    // Earlier queued requests can publish events or refreshes before this request reaches the socket.
    write.revision = revisions.getOrPut(write.messageId) { 0 }
    return true
  }

  fun applyWrite(
    write: Write,
    reactions: List<ChatReactionSummary>,
  ) {
    if (isCurrent(write) && (revisions[write.messageId] ?: 0) == write.revision) publish(write.messageId, reactions)
  }

  fun finishWrite(write: Write) {
    if (isCurrent(write)) writes.remove(write.messageId to write.emoji)
    if (writeTails[write.messageId] === write) writeTails.remove(write.messageId)
    write.completion.complete(Unit)
  }

  private fun publish(
    messageId: String,
    reactions: List<ChatReactionSummary>,
  ) {
    readUpdates?.set(messageId, reactions)
    mutableReactions.value = mutableReactions.value + (messageId to reactions)
  }
}
