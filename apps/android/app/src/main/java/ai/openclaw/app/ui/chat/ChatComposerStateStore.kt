package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

internal enum class ChatComposerAttachmentNotice {
  Attachment,
  Image,
}

internal enum class ChatComposerSendStartResult {
  Started,
  Unavailable,
  MessageTooLong,
  CheckpointFull,
}

internal data class ChatComposerSendRequest(
  val commandId: String,
  val owner: ChatComposerOwner,
  val inputSnapshot: String,
  val message: String,
  val attachments: List<PendingAttachment>,
)

internal data class ChatComposerSendStart(
  val result: ChatComposerSendStartResult,
  val request: ChatComposerSendRequest? = null,
)

/** Owns all mutable state keyed by a composer owner and resolves aliases as one transaction. */
internal class ChatComposerStateStore(
  initialDrafts: ChatComposerDraftSnapshot = ChatComposerDraftSnapshot(),
  onDraftSnapshotChanged: (ArrayList<String>) -> Unit = {},
) {
  private val lock = Any()
  private val attachmentStore = ChatComposerAttachmentStore()
  private val mediaOwners = linkedMapOf<String, ChatComposerOwner>()

  val textDrafts =
    ChatComposerTextDraftStore(
      initial = initialDrafts,
      onSnapshotChanged = onDraftSnapshotChanged,
    )
  val attachments = attachmentStore.attachments

  private val attachmentNoticesState =
    MutableStateFlow<Map<ChatComposerOwner, ChatComposerAttachmentNotice>>(emptyMap())
  val attachmentNotices: StateFlow<Map<ChatComposerOwner, ChatComposerAttachmentNotice>> =
    attachmentNoticesState.asStateFlow()

  private val recoveredSends = textDrafts.pendingAdmissions()
  // Null means actively sending; a non-null id waits for one UI observation before release.
  private val sendStatesState =
    MutableStateFlow<Map<ChatComposerOwner, String?>>(
      recoveredSends.associate { pending -> pending.owner to null },
    )
  val sendStates: StateFlow<Map<ChatComposerOwner, String?>> = sendStatesState.asStateFlow()

  fun recoveredSends(): List<PendingChatComposerSend> = recoveredSends

  fun resolveRecoveredSend(
    commandId: String,
    fallbackOwner: ChatComposerOwner,
    admitted: Boolean,
  ) {
    synchronized(lock) {
      val resolvedOwner = textDrafts.resolveAdmission(commandId, admitted)?.owner ?: fallbackOwner
      sendStatesState.value = sendStatesState.value - fallbackOwner - resolvedOwner
    }
  }

  fun tryBeginTrackedSend(owner: ChatComposerOwner): Boolean =
    synchronized(lock) {
      if (hasActiveSendLocked(owner)) return@synchronized false
      sendStatesState.value = sendStatesState.value + (owner to null)
      true
    }

  fun finishTrackedSend(owner: ChatComposerOwner) = synchronized(lock) { sendStatesState.value = sendStatesState.value - owner }

  fun beginSend(owner: ChatComposerOwner): ChatComposerSendStart =
    synchronized(lock) {
      if (hasActiveSendLocked(owner)) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.Unavailable)
      }
      val inputSnapshot = textDrafts[owner]
      val attachments = attachmentStore.get(owner)
      if (inputSnapshot.isBlank() && attachments.isEmpty()) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.Unavailable)
      }
      if (inputSnapshot.length > CHAT_COMPOSER_MAX_SEND_CHARS) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.MessageTooLong)
      }
      val commandId = UUID.randomUUID().toString()
      if (!textDrafts.beginAdmission(commandId, owner, inputSnapshot)) {
        return@synchronized ChatComposerSendStart(ChatComposerSendStartResult.CheckpointFull)
      }
      sendStatesState.value = sendStatesState.value + (owner to null)
      ChatComposerSendStart(
        result = ChatComposerSendStartResult.Started,
        request = ChatComposerSendRequest(commandId, owner, inputSnapshot, inputSnapshot.trim(), attachments),
      )
    }

  fun completeSend(
    request: ChatComposerSendRequest,
    accepted: Boolean?,
  ) {
    synchronized(lock) {
      if (accepted == null) {
        val currentOwner = textDrafts.pendingAdmission(request.commandId)?.owner ?: request.owner
        sendStatesState.value = sendStatesState.value - currentOwner
        return
      }
      val pending = textDrafts.resolveAdmission(request.commandId, accepted)
      val resolvedOwner = pending?.owner ?: request.owner
      if (pending == null) {
        sendStatesState.value = sendStatesState.value - request.owner
        return
      }
      if (accepted) {
        attachmentStore.remove(
          resolvedOwner,
          request.attachments.mapTo(linkedSetOf()) { attachment -> attachment.id },
        )
      }
      sendStatesState.value =
        (sendStatesState.value - request.owner - resolvedOwner) +
          (resolvedOwner to request.commandId)
    }
  }

  fun acknowledgeSendAdmission(
    owner: ChatComposerOwner,
    id: String,
  ) {
    synchronized(lock) {
      if (sendStatesState.value[owner] != id) return
      sendStatesState.value = sendStatesState.value - owner
    }
  }

  fun beginMediaAcquisition(owner: ChatComposerOwner): String? {
    owner.gatewayStableId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return synchronized(lock) {
      while (mediaOwners.size >= CHAT_COMPOSER_MAX_MEDIA_AUTHORIZATIONS) {
        mediaOwners.remove(mediaOwners.keys.firstOrNull() ?: break)
      }
      UUID.randomUUID().toString().also { id -> mediaOwners[id] = owner }
    }
  }

  fun isMediaAcquisitionActive(id: String): Boolean = synchronized(lock) { id in mediaOwners }

  fun cancelMediaAcquisition(id: String) = synchronized(lock) { mediaOwners.remove(id) }

  fun addAttachments(
    owner: ChatComposerOwner,
    candidates: List<PendingAttachment>,
  ): Int =
    synchronized(lock) {
      attachmentStore.add(owner, candidates).also { omitted ->
        recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Attachment)
      }
    }

  fun addAuthorizedAttachments(
    owner: ChatComposerOwner,
    mediaAuthorizationId: String,
    candidates: List<PendingAttachment>,
  ): Int? =
    synchronized(lock) {
      if (mediaOwners.remove(mediaAuthorizationId) != owner) return@synchronized null
      attachmentStore.add(owner, candidates).also { omitted ->
        recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Attachment)
      }
    }

  fun removeAttachments(owner: ChatComposerOwner, ids: Set<String>) =
    synchronized(lock) { attachmentStore.remove(owner, ids) }

  fun beginMediaImport(
    owner: ChatComposerOwner,
    mediaAuthorizationId: String,
    mainSessionKey: String,
  ): Long? =
    synchronized(lock) {
      val authorizedOwner = mediaOwners.remove(mediaAuthorizationId) ?: return@synchronized null
      if (authorizedOwner != owner && !shouldMigrateComposerDraft(authorizedOwner, owner, mainSessionKey)) {
        return@synchronized null
      }
      attachmentStore.beginImport(owner)
    }

  fun completeMediaImport(
    importId: Long,
    candidates: List<PendingAttachment>,
    failedCount: Int,
  ) {
    synchronized(lock) {
      attachmentStore.completeImport(importId, candidates)?.let { (owner, omitted) ->
        recordAttachmentOmissionLocked(
          owner,
          omitted + failedCount.coerceAtLeast(0),
          ChatComposerAttachmentNotice.Image,
        )
      }
    }
  }

  fun cancelMediaImport(importId: Long) = synchronized(lock) { attachmentStore.cancelImport(importId) }

  fun clearAttachmentOmission(owner: ChatComposerOwner) =
    synchronized(lock) { attachmentNoticesState.value = attachmentNoticesState.value - owner }

  fun reportImageOmission(owner: ChatComposerOwner, omitted: Int) =
    synchronized(lock) { recordAttachmentOmissionLocked(owner, omitted, ChatComposerAttachmentNotice.Image) }

  /** Migrates every state surface and returns aliases owned by external queues. */
  fun resolveAliases(
    to: ChatComposerOwner,
    mainSessionKey: String,
  ): Set<ChatComposerOwner> =
    synchronized(lock) {
      val mediaSources =
        mediaOwners.values.filterTo(linkedSetOf()) { source ->
          shouldMigrateComposerDraft(source, to, mainSessionKey)
        }
      if (mediaSources.isNotEmpty()) {
        for ((id, owner) in mediaOwners.toMap()) {
          if (owner in mediaSources) mediaOwners[id] = to
        }
      }

      val textSources = textDrafts.migrateMatching(to = to, mainSessionKey = mainSessionKey)
      val attachmentMigration = attachmentStore.migrateMatching(to = to, mainSessionKey = mainSessionKey)
      val sendSources = sendStatesState.value.keys.filterTo(linkedSetOf()) { source -> shouldMigrateComposerDraft(source, to, mainSessionKey) }
      val noticeSources =
        attachmentNoticesState.value.keys.filterTo(linkedSetOf()) { source ->
          shouldMigrateComposerDraft(source, to, mainSessionKey)
        }
      val sources = textSources + attachmentMigration.sources + sendSources + mediaSources + noticeSources

      if (sendSources.isNotEmpty()) {
        sendStatesState.value =
          sendStatesState.value.entries
            .groupBy({ (owner) -> if (owner in sendSources) to else owner }, { (_, admissionId) -> admissionId })
            .mapValues { (_, admissionIds) -> admissionIds.filterNotNull().maxOrNull() }
      }

      val currentNotices = attachmentNoticesState.value
      val sourceNotices = sources.mapNotNull(currentNotices::get)
      var nextNotices = currentNotices - sources
      val nextNotice =
        when {
          attachmentMigration.omittedCount > 0 ||
            currentNotices[to] == ChatComposerAttachmentNotice.Attachment ||
            ChatComposerAttachmentNotice.Attachment in sourceNotices -> ChatComposerAttachmentNotice.Attachment
          currentNotices[to] == ChatComposerAttachmentNotice.Image ||
            ChatComposerAttachmentNotice.Image in sourceNotices -> ChatComposerAttachmentNotice.Image
          else -> null
        }
      if (nextNotice != null) nextNotices += (to to nextNotice)
      attachmentNoticesState.value = nextNotices
      sources
    }

  fun removeMediaOwners(matches: (ChatComposerOwner) -> Boolean) {
    synchronized(lock) { removeMediaOwnersLocked(matches) }
  }

  fun removeOwners(
    matches: (ChatComposerOwner) -> Boolean,
    retainedSendOwner: ChatComposerOwner? = null,
  ) {
    synchronized(lock) {
      removeMediaOwnersLocked(matches)
      textDrafts.removeOwners(matches)
      sendStatesState.value =
        sendStatesState.value
          .filterKeys { !matches(it) }
          .let { retained -> retainedSendOwner?.let { retained + (it to null) } ?: retained }
      attachmentNoticesState.value = attachmentNoticesState.value.filterKeys { !matches(it) }
    }
  }

  private fun hasActiveSendLocked(owner: ChatComposerOwner): Boolean = owner in sendStatesState.value

  private fun removeMediaOwnersLocked(matches: (ChatComposerOwner) -> Boolean) {
    mediaOwners.entries.removeAll { matches(it.value) }
    attachmentStore.removeOwners(matches)
  }

  private fun recordAttachmentOmissionLocked(
    owner: ChatComposerOwner,
    omitted: Int,
    notice: ChatComposerAttachmentNotice,
  ) {
    if (omitted <= 0) return
    val current = attachmentNoticesState.value[owner]
    val resolved = if (current == ChatComposerAttachmentNotice.Attachment) current else notice
    attachmentNoticesState.value = attachmentNoticesState.value + (owner to resolved)
  }

  private companion object {
    const val CHAT_COMPOSER_MAX_MEDIA_AUTHORIZATIONS = 32
  }
}
