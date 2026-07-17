package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatComposerSendAdmission
import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.ChatShareDraft
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES
import ai.openclaw.app.chat.VoiceNoteRecorderState
import android.net.Uri
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.saveable.listSaver
import kotlinx.coroutines.CancellationException

internal const val CHAT_COMPOSER_MAX_DRAFT_OWNERS = 16
internal const val CHAT_COMPOSER_DRAFT_SNAPSHOT_MAX_CHARS = 64 * 1024
private const val CHAT_COMPOSER_DRAFT_SNAPSHOT_FIELDS = 8
private const val CHAT_COMPOSER_DRAFT_RECORD = "draft"
private const val CHAT_COMPOSER_PENDING_SEND_RECORD = "pending-send"
private const val CHAT_COMPOSER_PENDING_SEND_WITHOUT_INPUT_RECORD = "pending-send-without-input"

internal data class PendingChatComposerSend(
  val commandId: String,
  val owner: ChatComposerOwner,
  val inputSnapshot: String?,
)

internal data class ChatComposerDraftSnapshot(
  val drafts: Map<ChatComposerOwner, String> = emptyMap(),
  val pendingSends: List<PendingChatComposerSend> = emptyList(),
)

internal class ChatComposerTextDraftStore(
  initial: ChatComposerDraftSnapshot = ChatComposerDraftSnapshot(),
  private val onSnapshotChanged: (ArrayList<String>) -> Unit = {},
) {
  private val drafts = mutableStateMapOf<ChatComposerOwner, String>()
  private val recency = ArrayDeque<ChatComposerOwner>()
  private val pendingSends = LinkedHashMap<String, PendingChatComposerSend>()

  init {
    initial.drafts.forEach { (owner, text) ->
      drafts[owner] = text
      recency.addLast(owner)
    }
    initial.pendingSends.forEach { pending -> pendingSends[pending.commandId] = pending }
  }

  operator fun get(owner: ChatComposerOwner): String = drafts[owner].orEmpty()

  operator fun set(
    owner: ChatComposerOwner,
    value: String,
  ) {
    recency.remove(owner)
    if (value.isEmpty()) {
      drafts.remove(owner)
      onSnapshotChanged(snapshot())
      return
    }
    if (owner !in drafts) {
      while (drafts.size >= CHAT_COMPOSER_MAX_DRAFT_OWNERS) {
        drafts.remove(recency.removeFirst())
      }
    }
    drafts[owner] = value
    recency.addLast(owner)
    onSnapshotChanged(snapshot())
  }

  fun migrate(
    from: ChatComposerOwner,
    to: ChatComposerOwner,
  ) {
    if (from == to) return
    var changed = false
    pendingSends.toMap().forEach { (commandId, pending) ->
      if (pending.owner == from) {
        changed = true
        pendingSends[commandId] = pending.copy(owner = to)
      }
    }
    val draft = drafts.remove(from)
    if (draft == null) {
      if (changed) onSnapshotChanged(snapshot())
      return
    }
    recency.remove(from)
    val existing = drafts[to]
    this[to] =
      when {
        existing.isNullOrEmpty() -> draft
        draft == existing -> existing
        else -> "$existing\n\n$draft"
      }
  }

  /** Resolves every parked alias, including drafts not visited since gateway hello. */
  fun migrateMatching(
    to: ChatComposerOwner,
    mainSessionKey: String,
  ): Set<ChatComposerOwner> {
    val sources =
      (recency + pendingSends.values.map(PendingChatComposerSend::owner))
        .filterTo(linkedSetOf()) { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }
    sources.forEach { source -> migrate(from = source, to = to) }
    return sources
  }

  /** Clears only the exact text snapshot admitted to the durable outbox. */
  fun clearAccepted(
    owner: ChatComposerOwner,
    acceptedInputSnapshot: String,
  ): Boolean {
    if (drafts[owner] != acceptedInputSnapshot) return false
    this[owner] = ""
    return true
  }

  /** Checkpoints the pre-send draft with the id that the durable outbox will use. */
  fun beginAdmission(
    commandId: String,
    owner: ChatComposerOwner,
    inputSnapshot: String,
  ) {
    check(commandId !in pendingSends)
    pendingSends[commandId] = PendingChatComposerSend(commandId, owner, inputSnapshot)
    onSnapshotChanged(snapshot())
  }

  /** Resolves one live or process-restored send without clearing text edited after admission. */
  fun resolveAdmission(
    commandId: String,
    admitted: Boolean,
  ): PendingChatComposerSend? {
    val pending = pendingSends.remove(commandId) ?: return null
    val current = drafts[pending.owner]
    if (admitted) {
      if (current == pending.inputSnapshot) {
        drafts.remove(pending.owner)
        recency.remove(pending.owner)
      }
    } else if (current.isNullOrEmpty() && !pending.inputSnapshot.isNullOrEmpty()) {
      drafts[pending.owner] = pending.inputSnapshot
      recency.remove(pending.owner)
      recency.addLast(pending.owner)
    }
    onSnapshotChanged(snapshot())
    return pending
  }

  fun pendingAdmissions(): List<PendingChatComposerSend> = pendingSends.values.toList()

  fun pendingAdmission(commandId: String): PendingChatComposerSend? = pendingSends[commandId]

  internal fun snapshot(): ArrayList<String> {
    var remainingChars = CHAT_COMPOSER_DRAFT_SNAPSHOT_MAX_CHARS
    val records = mutableListOf<List<String>>()
    // Pending ids are the crash-consistency boundary. Always checkpoint the marker; keep its
    // draft too when it fits, so restart can restore it only after proving no outbox row exists.
    pendingSends.values.forEach { pending ->
      val fullEntry =
        listOf(CHAT_COMPOSER_PENDING_SEND_RECORD) +
          pending.owner.toCheckpointValues() +
          listOf(pending.commandId, pending.inputSnapshot.orEmpty())
      val entry =
        if (fullEntry.sumOf(String::length) <= remainingChars) {
          fullEntry
        } else {
          listOf(CHAT_COMPOSER_PENDING_SEND_WITHOUT_INPUT_RECORD) +
            pending.owner.toCheckpointValues() +
            listOf(pending.commandId, "")
        }
      records += entry
      remainingChars -= entry.sumOf(String::length)
    }
    val retainedNewestFirst = mutableListOf<List<String>>()
    // SavedStateHandle is written into the Activity transaction. Keep the full in-memory drafts,
    // but checkpoint only the newest complete entries that fit the bounded process-death budget.
    for (owner in recency.reversed()) {
      val text = drafts.getValue(owner)
      if (pendingSends.values.any { pending -> pending.owner == owner && pending.inputSnapshot == text }) continue
      val entry = listOf(CHAT_COMPOSER_DRAFT_RECORD) + owner.toCheckpointValues() + listOf("", text)
      val entryChars = entry.sumOf(String::length)
      if (entryChars > remainingChars) continue
      retainedNewestFirst += entry
      remainingChars -= entryChars
    }
    records += retainedNewestFirst.asReversed()
    return ArrayList(records.flatten())
  }

  internal fun size(): Int = drafts.size
}

internal fun chatComposerTextDraftsFromSnapshot(values: List<String>?): ChatComposerDraftSnapshot {
  if (values == null || values.size % CHAT_COMPOSER_DRAFT_SNAPSHOT_FIELDS != 0) {
    return ChatComposerDraftSnapshot()
  }
  val restored = LinkedHashMap<ChatComposerOwner, String>()
  val pending = mutableListOf<PendingChatComposerSend>()
  values.chunked(CHAT_COMPOSER_DRAFT_SNAPSHOT_FIELDS).forEach { entry ->
    val owner = chatComposerOwnerFromCheckpointValues(entry.subList(1, 6)) ?: return@forEach
    when (entry[0]) {
      CHAT_COMPOSER_DRAFT_RECORD -> if (entry[7].isNotEmpty()) restored[owner] = entry[7]
      CHAT_COMPOSER_PENDING_SEND_RECORD -> {
        if (entry[6].isNotEmpty()) pending += PendingChatComposerSend(entry[6], owner, entry[7])
      }
      CHAT_COMPOSER_PENDING_SEND_WITHOUT_INPUT_RECORD -> {
        if (entry[6].isNotEmpty()) pending += PendingChatComposerSend(entry[6], owner, null)
      }
    }
  }
  return ChatComposerDraftSnapshot(drafts = restored, pendingSends = pending)
}

internal class ChatComposerOwnerCheckpoint(
  var owner: ChatComposerOwner? = null,
) {
  companion object {
    val Saver =
      listSaver<ChatComposerOwnerCheckpoint, String>(
        save = { checkpoint -> checkpoint.owner?.toCheckpointValues().orEmpty() },
        restore = { values -> ChatComposerOwnerCheckpoint(chatComposerOwnerFromCheckpointValues(values)) },
      )
  }
}

internal fun ChatComposerOwner.toCheckpointValues(): List<String> =
  listOf(
    if (gatewayStableId == null) "0" else "1",
    gatewayStableId.orEmpty(),
    agentId,
    sessionKey,
    if (routingVerified) "1" else "0",
  )

internal fun chatComposerOwnerFromCheckpointValues(values: List<String>): ChatComposerOwner? {
  if (values.size != 5) return null
  return ChatComposerOwner(
    gatewayStableId = values[1].takeIf { values[0] == "1" },
    agentId = values[2],
    sessionKey = values[3],
    routingVerified = values[4] == "1",
  )
}

internal fun shouldMigrateComposerDraft(
  previous: ChatComposerOwner?,
  current: ChatComposerOwner,
  mainSessionKey: String,
): Boolean {
  if (previous == null || previous == current) return false
  val canonicalMain = mainSessionKey.trim()
  val mainAliasResolved =
    previous.sessionKey == "main" &&
      canonicalMain != "main" &&
      current.sessionKey == canonicalMain
  // A draft captured without a selected gateway has no safe resolution target. Only a
  // provisional owner already bound to the active registry entry may follow hello metadata.
  if (previous.gatewayStableId != current.gatewayStableId) return false
  if (!previous.routingVerified && current.routingVerified) {
    return previous.sessionKey == current.sessionKey || mainAliasResolved
  }
  return previous.agentId == current.agentId && mainAliasResolved
}

internal fun canCommitComposerResult(
  ownerSnapshot: ChatComposerOwner,
  currentOwner: ChatComposerOwner,
): Boolean = ownerSnapshot == currentOwner

internal fun mergeChatDraft(
  draft: ChatDraft?,
  currentInput: String,
  currentOwner: ChatComposerOwner? = null,
): String? {
  if (draft?.owner != null && draft.owner != currentOwner) return null
  val text = draft?.text?.takeIf { it.isNotBlank() } ?: return null
  return when (draft.placement) {
    ChatDraftPlacement.Replace -> text
    ChatDraftPlacement.BeforeExisting -> text + currentInput
  }
}

internal fun clearAcceptedChatComposerInput(
  admission: ChatComposerSendAdmission,
  currentOwner: ChatComposerOwner,
  currentInput: String,
): String? = if (admission.accepted && admission.owner == currentOwner && currentInput == admission.inputSnapshot) "" else null

/** Appends system shares so existing drafts stay first and queued shares remain FIFO. */
internal fun mergeSharedChatText(
  sharedText: String?,
  currentInput: String,
): String {
  val shared = sharedText?.trim()?.takeIf { it.isNotEmpty() } ?: return currentInput
  return if (currentInput.isEmpty()) shared else listOf(currentInput, shared).joinToString(separator = "\n\n")
}

internal data class StagedChatShare(
  val text: String?,
  val attachments: List<PendingAttachment>,
  val failedImageCount: Int,
  val droppedImageCount: Int,
)

internal const val CHAT_COMPOSER_MAX_ATTACHMENTS = 8
internal const val CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES = OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES
internal const val CHAT_COMPOSER_MAX_BASE64_CHARS = ((CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES + 2) / 3) * 4
internal const val CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS = 24
internal const val CHAT_COMPOSER_MAX_TOTAL_DECODED_ATTACHMENT_BYTES = CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES * 3
internal const val CHAT_COMPOSER_MAX_TOTAL_BASE64_CHARS = ((CHAT_COMPOSER_MAX_TOTAL_DECODED_ATTACHMENT_BYTES + 2) / 3) * 4

internal data class ChatAttachmentAdmission(
  val accepted: List<PendingAttachment>,
  val omittedCount: Int,
)

internal fun admitChatAttachments(
  currentAttachments: List<PendingAttachment>,
  candidates: List<PendingAttachment>,
  maxAttachmentCount: Int = CHAT_COMPOSER_MAX_ATTACHMENTS,
  maxBase64Chars: Long = CHAT_COMPOSER_MAX_BASE64_CHARS,
  maxDecodedBytes: Long = CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES,
): ChatAttachmentAdmission {
  require(maxAttachmentCount >= 0 && maxBase64Chars >= 0 && maxDecodedBytes >= 0)
  val accepted = mutableListOf<PendingAttachment>()
  var base64Chars = currentAttachments.sumOf { it.base64.length.toLong() }
  var decodedBytes = currentAttachments.sumOf { decodedBase64ByteCount(it.base64) }
  var omittedCount = 0
  for (candidate in candidates) {
    val candidateBase64Chars = candidate.base64.length.toLong()
    val candidateDecodedBytes = decodedBase64ByteCount(candidate.base64)
    val withinCount = currentAttachments.size + accepted.size < maxAttachmentCount
    val withinBase64 = candidateBase64Chars <= maxBase64Chars - base64Chars
    val withinDecoded = candidateDecodedBytes <= maxDecodedBytes - decodedBytes
    if (withinCount && withinBase64 && withinDecoded) {
      accepted += candidate
      base64Chars += candidateBase64Chars
      decodedBytes += candidateDecodedBytes
    } else {
      omittedCount += 1
    }
  }
  return ChatAttachmentAdmission(accepted = accepted, omittedCount = omittedCount)
}

internal fun decodedBase64ByteCount(base64: String): Long {
  val padding =
    when {
      base64.endsWith("==") -> 2
      base64.endsWith('=') -> 1
      else -> 0
    }
  return ((base64.length.toLong() * 3) / 4 - padding).coerceAtLeast(0)
}

/** Loads a complete queue head before any part of it becomes visible in the composer. */
internal suspend fun stageChatShareDraft(
  draft: ChatShareDraft,
  loadImage: suspend (Uri) -> PendingAttachment,
): StagedChatShare {
  val attachments = mutableListOf<PendingAttachment>()
  var failedImageCount = 0
  var droppedImageCount = draft.droppedImageCount
  for (uri in draft.imageUris) {
    try {
      val candidate = loadImage(uri)
      val admission = admitChatAttachments(attachments, listOf(candidate))
      attachments += admission.accepted
      droppedImageCount += admission.omittedCount
    } catch (error: CancellationException) {
      // Screen disposal must leave the queue head unacknowledged for the next ChatScreen.
      throw error
    } catch (_: Exception) {
      failedImageCount += 1
    }
  }
  return StagedChatShare(
    text = draft.text,
    attachments = attachments,
    failedImageCount = failedImageCount,
    droppedImageCount = droppedImageCount,
  )
}

internal fun canCommitStagedChatShare(
  stagedId: Long,
  currentHead: ChatShareDraft?,
  ownerSnapshot: ChatComposerOwner,
  currentOwner: ChatComposerOwner,
): Boolean =
  currentHead?.id == stagedId &&
    canCommitComposerResult(ownerSnapshot = ownerSnapshot, currentOwner = currentOwner)

internal fun chatComposerSendEnabled(
  voiceNoteState: VoiceNoteRecorderState,
  pendingRunCount: Int,
  hasContent: Boolean,
  shareStaging: Boolean,
  sendInFlight: Boolean = false,
): Boolean =
  !shareStaging &&
    !sendInFlight &&
    voiceNoteState !is VoiceNoteRecorderState.Recording &&
    voiceNoteState !is VoiceNoteRecorderState.Preparing &&
    pendingRunCount == 0 &&
    hasContent
