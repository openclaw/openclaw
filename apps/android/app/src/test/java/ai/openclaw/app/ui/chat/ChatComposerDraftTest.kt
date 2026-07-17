package ai.openclaw.app.ui.chat

import ai.openclaw.app.ChatComposerSendAdmission
import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.ChatShareDraft
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.GatewayDefaultAgentOwner
import ai.openclaw.app.chat.VoiceNoteRecorderState
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.claimChatDraftForOwner
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatComposerDraftTest {
  @Test
  fun textDraftsRemainKeyedToTheirComposerOwner() {
    val store = ChatComposerTextDraftStore()
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val second = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:second")

    store[first] = "first draft"
    store[second] = "second draft"

    assertEquals("first draft", store[first])
    assertEquals("second draft", store[second])
  }

  @Test
  fun textDraftSnapshotRestoresEveryOwnerAfterProcessRecreation() {
    var saved = arrayListOf<String>()
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:first")
    val second = ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "work", sessionKey = "agent:work:second")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[first] = "first draft"
    store[second] = "second draft"

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("first draft", restored[first])
    assertEquals("second draft", restored[second])
  }

  @Test
  fun acceptedSnapshotDoesNotClearTextEditedAfterSendStarted() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val store = ChatComposerTextDraftStore()
    store[owner] = "sent text"
    assertTrue(store.clearAccepted(owner, "sent text"))
    assertEquals("", store[owner])

    store[owner] = "edited after tap"
    assertFalse(store.clearAccepted(owner, "sent text"))
    assertEquals("edited after tap", store[owner])
  }

  @Test
  fun processRecreationHidesPendingDraftUntilOutboxReconciliation() {
    var saved = arrayListOf<String>()
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("", restored[owner])
    assertEquals(listOf("command-a"), restored.pendingAdmissions().map { it.commandId })
    restored.resolveAdmission("command-a", admitted = false)
    assertEquals("send once", restored[owner])
  }

  @Test
  fun restoredPendingAdmissionMigratesWithoutAVisibleDraft() {
    var saved = arrayListOf<String>()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[alias] = "send once"
    store.beginAdmission(commandId = "command-a", owner = alias, inputSnapshot = "send once")
    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))

    assertEquals("", restored[alias])
    assertEquals(setOf(alias), restored.migrateMatching(canonical, canonical.sessionKey))
    assertEquals(canonical, restored.pendingAdmissions().single().owner)

    restored.resolveAdmission("command-a", admitted = false)
    assertEquals("", restored[alias])
    assertEquals("send once", restored[canonical])
  }

  @Test
  fun durablePendingSendStaysHiddenAndLaterEditsSurviveReconciliation() {
    var saved = arrayListOf<String>()
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    store[owner] = "send once"
    store.beginAdmission(commandId = "command-a", owner = owner, inputSnapshot = "send once")
    store[owner] = "new draft"

    val restored = ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))
    assertEquals("new draft", restored[owner])

    restored.resolveAdmission("command-a", admitted = true)
    assertEquals("new draft", restored[owner])
    assertTrue(restored.pendingAdmissions().isEmpty())
  }

  @Test
  fun pendingReplyDraftClaimsTheCanonicalMainAliasOwner() {
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    val draft = ChatDraft(text = "reply", placement = ChatDraftPlacement.BeforeExisting, owner = alias)

    val claimed = claimChatDraftForOwner(draft, canonical, canonical.sessionKey)

    assertEquals(canonical, claimed?.owner)
    assertEquals("reply", claimed?.text)
  }

  @Test
  fun textDraftStoreEvictsTheOldestOwnerAndBoundsProcessCheckpoint() {
    var saved = arrayListOf<String>()
    val store = ChatComposerTextDraftStore(onSnapshotChanged = { saved = it })
    val owners =
      (0..CHAT_COMPOSER_MAX_DRAFT_OWNERS).map { index ->
        ChatComposerOwner(
          gatewayStableId = "gateway-a",
          agentId = "main",
          sessionKey = "agent:main:$index",
        )
      }

    val longDraft = "x".repeat(40_000)
    owners.forEach { owner -> store[owner] = longDraft }

    assertEquals(CHAT_COMPOSER_MAX_DRAFT_OWNERS, store.size())
    assertEquals("", store[owners.first()])
    assertEquals(longDraft, store[owners.last()])
    assertTrue(saved.sumOf(String::length) <= CHAT_COMPOSER_DRAFT_SNAPSHOT_MAX_CHARS)
    assertEquals(longDraft, ChatComposerTextDraftStore(initial = chatComposerTextDraftsFromSnapshot(saved))[owners.last()])
  }

  @Test
  fun mainAliasDraftMovesToCanonicalMainOwner() {
    val store = ChatComposerTextDraftStore()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    store[alias] = "typed while connecting"

    assertTrue(shouldMigrateComposerDraft(alias, canonical, canonical.sessionKey))
    store.migrate(from = alias, to = canonical)

    assertEquals("", store[alias])
    assertEquals("typed while connecting", store[canonical])
  }

  @Test
  fun mainAliasDraftDoesNotCrossGatewayOrAgent() {
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")

    assertFalse(
      shouldMigrateComposerDraft(
        alias,
        ChatComposerOwner(gatewayStableId = "gateway-b", agentId = "main", sessionKey = "agent:main:device"),
        "agent:main:device",
      ),
    )
    assertFalse(
      shouldMigrateComposerDraft(
        alias,
        ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "other", sessionKey = "agent:other:device"),
        "agent:other:device",
      ),
    )
  }

  @Test
  fun mainAliasMigrationPreservesAnExistingCanonicalDraft() {
    val store = ChatComposerTextDraftStore()
    val alias = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "main")
    val canonical = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "main", sessionKey = "agent:main:device")
    store[alias] = "typed while connecting"
    store[canonical] = "saved canonical draft"

    store.migrate(from = alias, to = canonical)

    assertEquals("saved canonical draft\n\ntyped while connecting", store[canonical])
  }

  @Test
  fun gatewayBoundProvisionalDraftMovesToItsVerifiedOwner() {
    val store = ChatComposerTextDraftStore()
    val provisional =
      ChatComposerOwner(
        gatewayStableId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        routingVerified = false,
      )
    val verified = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "work", sessionKey = "agent:work:device")
    store[provisional] = "typed before gateway hello"

    assertTrue(shouldMigrateComposerDraft(provisional, verified, verified.sessionKey))
    store.migrate(provisional, verified)

    assertEquals("", store[provisional])
    assertEquals("typed before gateway hello", store[verified])
  }

  @Test
  fun provisionalOwnerCheckpointSurvivesRecreation() {
    val provisional =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "main",
        sessionKey = "main",
        routingVerified = false,
      )

    val restored = chatComposerOwnerFromCheckpointValues(provisional.toCheckpointValues())

    assertEquals(provisional, restored)
  }

  @Test
  fun ownerlessProvisionalDraftStaysParkedWhenAGatewayAppears() {
    val unresolvedGateway =
      ChatComposerOwner(
        gatewayStableId = null,
        agentId = "main",
        sessionKey = "custom",
      )
    val resolvedGateway = unresolvedGateway.copy(gatewayStableId = "gateway-a")

    assertFalse(shouldMigrateComposerDraft(unresolvedGateway, resolvedGateway, "agent:main:device"))
  }

  @Test
  fun verifiedDraftDoesNotMoveWhenTheDefaultOwnerChanges() {
    val first = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "first", sessionKey = "custom")
    val second = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "second", sessionKey = "custom")

    assertFalse(shouldMigrateComposerDraft(first, second, "agent:second:device"))
  }

  @Test
  fun replyDraftPreservesExistingComposerText() {
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting)

    assertEquals("> quoted\n\nmy reply", mergeChatDraft(draft, "my reply"))
  }

  @Test
  fun replacementDraftReplacesExistingComposerText() {
    val draft = ChatDraft(text = "repeat this", placement = ChatDraftPlacement.Replace)

    assertEquals("repeat this", mergeChatDraft(draft, "existing text"))
  }

  @Test
  fun replyDraftCanOnlyMergeIntoItsOriginatingOwner() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")
    val draft = ChatDraft(text = "> quoted\n\n", placement = ChatDraftPlacement.BeforeExisting, owner = owner)

    assertEquals(
      null,
      mergeChatDraft(draft = draft, currentInput = "wrong", currentOwner = owner.copy(sessionKey = "session-b")),
    )
    assertEquals(
      "> quoted\n\nreply",
      mergeChatDraft(draft = draft, currentInput = "reply", currentOwner = owner),
    )
  }

  @Test
  fun sharedTextPreservesExistingComposerText() {
    assertEquals(
      "existing draft\n\nshared link",
      mergeSharedChatText(sharedText = "shared link", currentInput = "existing draft"),
    )
  }

  @Test
  fun queuedSharedTextPreservesArrivalOrder() {
    val first = mergeSharedChatText(sharedText = "first", currentInput = "")

    assertEquals("first\n\nsecond", mergeSharedChatText(sharedText = "second", currentInput = first))
  }

  @Test
  fun imageOnlyShareLeavesExistingComposerTextUntouched() {
    assertEquals(
      "existing draft",
      mergeSharedChatText(sharedText = null, currentInput = "existing draft"),
    )
  }

  @Test
  fun stagedSharePreservesComposerAndReportsDroppedImages() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val existing = pendingAttachment("existing")
    val shared = pendingAttachment("shared")
    val staged =
      StagedChatShare(
        text = "shared link",
        attachments = listOf(shared),
        failedImageCount = 0,
        droppedImageCount = 2,
      )

    store.add(owner, listOf(existing))
    val omitted = store.add(owner, staged.attachments)

    assertEquals("existing draft\n\nshared link", mergeSharedChatText(staged.text, "existing draft"))
    assertEquals(listOf(existing, shared), store.get(owner))
    assertEquals(2, staged.failedImageCount + staged.droppedImageCount + omitted)
  }

  @Test
  fun unreadableSharedImageDoesNotDiscardOtherStagedContent() =
    runBlocking {
      val readable = Uri.parse("content://photos/readable")
      val unreadable = Uri.parse("content://photos/unreadable")
      val draft =
        ChatShareDraft(
          id = 1,
          text = "caption",
          imageUris = listOf(readable, unreadable),
          droppedImageCount = 0,
        )

      val staged =
        stageChatShareDraft(draft) { uri ->
          if (uri == unreadable) error("provider read failed")
          pendingAttachment(uri.toString())
        }

      assertEquals("caption", staged.text)
      assertEquals(listOf(readable.toString()), staged.attachments.map { it.id })
      assertEquals(1, staged.failedImageCount)
      assertEquals(0, staged.droppedImageCount)
    }

  @Test
  fun screenDisposalCancellationLeavesShareUnstaged() {
    val draft =
      ChatShareDraft(
        id = 1,
        text = null,
        imageUris = listOf(Uri.parse("content://photos/slow")),
        droppedImageCount = 0,
      )

    assertThrows(CancellationException::class.java) {
      runBlocking {
        stageChatShareDraft(draft) { throw CancellationException("screen disposed") }
      }
    }
  }

  @Test
  fun repeatedSharesRespectExistingComposerAttachmentLimit() =
    runBlocking {
      val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
      val store = ChatComposerAttachmentStore()
      val current = (1..7).map { pendingAttachment("existing-$it") }
      val uris = (1..3).map { Uri.parse("content://photos/shared/$it") }
      val draft = ChatShareDraft(id = 1, text = null, imageUris = uris, droppedImageCount = 0)

      val staged =
        stageChatShareDraft(draft) { uri ->
          pendingAttachment(uri.toString())
        }

      assertEquals(uris.map(Uri::toString), staged.attachments.map { it.id })
      assertEquals(0, staged.droppedImageCount)
      store.add(owner, current)
      val omitted = store.add(owner, staged.attachments)
      assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.get(owner).size)
      assertEquals(2, staged.droppedImageCount + omitted)
    }

  @Test
  fun mergeRechecksAttachmentBudgetAfterStaging() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val staged =
      StagedChatShare(
        text = null,
        attachments = listOf(pendingAttachment("one"), pendingAttachment("two")),
        failedImageCount = 0,
        droppedImageCount = 0,
      )
    val current = (1..7).map { pendingAttachment("existing-$it") }

    store.add(owner, current)
    val omitted = store.add(owner, staged.attachments)

    assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.get(owner).size)
    assertEquals(1, staged.droppedImageCount + omitted)
  }

  @Test
  fun sharedAttachmentsAtomicallyMergeWithAConcurrentPickerImport() {
    val owner = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val existing = pendingAttachment("existing")
    val picker = pendingAttachment("picker")
    val shared = pendingAttachment("shared")
    store.add(owner, listOf(existing))

    store.add(owner, listOf(picker))
    store.add(owner, listOf(shared))

    assertEquals(listOf(existing, picker, shared), store.get(owner))
  }

  @Test
  fun attachmentAdmissionEnforcesBase64AndDecodedBudgets() {
    val candidates = listOf(pendingAttachment("one", base64 = "AAAA"), pendingAttachment("two", base64 = "AAAA"))

    val base64Bound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 4,
        maxDecodedBytes = 100,
      )
    val decodedBound =
      admitChatAttachments(
        currentAttachments = emptyList(),
        candidates = candidates,
        maxAttachmentCount = 8,
        maxBase64Chars = 100,
        maxDecodedBytes = 3,
      )

    assertEquals(listOf(candidates.first()), base64Bound.accepted)
    assertEquals(1, base64Bound.omittedCount)
    assertEquals(listOf(candidates.first()), decodedBound.accepted)
    assertEquals(1, decodedBound.omittedCount)
  }

  @Test
  fun stagedShareCommitsOnlyForMatchingQueueHead() {
    val current = ChatShareDraft(id = 7, text = "current", imageUris = emptyList(), droppedImageCount = 0)
    val replacement = ChatShareDraft(id = 8, text = "replacement", imageUris = emptyList(), droppedImageCount = 0)
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")

    assertTrue(canCommitStagedChatShare(current.id, current, owner, owner))
    assertFalse(canCommitStagedChatShare(current.id, replacement, owner, owner))
    assertFalse(canCommitStagedChatShare(current.id, null, owner, owner))
  }

  @Test
  fun asyncComposerResultsCommitOnlyToTheirOriginalOwner() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")

    assertTrue(canCommitComposerResult(owner, owner))
    assertFalse(canCommitComposerResult(owner, owner.copy(gatewayStableId = "gateway-b")))
    assertFalse(canCommitComposerResult(owner, owner.copy(agentId = "agent-b")))
    assertFalse(canCommitComposerResult(owner, owner.copy(sessionKey = "session-b")))
  }

  @Test
  fun pendingAttachmentsRemainKeyedAcrossComposerNavigationAndOwnerResolution() {
    val ownerA = ChatComposerOwner(gatewayStableId = "gateway", agentId = "agent-a", sessionKey = "session-a")
    val ownerB = ChatComposerOwner(gatewayStableId = "gateway", agentId = "agent-b", sessionKey = "session-b")
    val resolvedA = ownerA.copy(sessionKey = "agent:agent-a:device")
    val store = ChatComposerAttachmentStore()
    val first = pendingAttachment("first")
    val second = pendingAttachment("second")
    val late = pendingAttachment("late")
    val importId = store.beginImport(ownerA)

    store.add(ownerA, listOf(first))
    store.add(ownerB, listOf(second))
    assertEquals(listOf(first), store.attachments.value[ownerA])
    assertEquals(listOf(second), store.attachments.value[ownerB])

    store.migrate(ownerA, resolvedA)
    assertEquals(null, store.attachments.value[ownerA])
    assertEquals(listOf(first), store.attachments.value[resolvedA])
    assertEquals(listOf(second), store.attachments.value[ownerB])

    // Only the decode that was already in flight follows the explicit owner migration.
    store.completeImport(importId, listOf(late))
    assertEquals(listOf(first, late), store.attachments.value[resolvedA])

    val reusedProvisional = pendingAttachment("reused")
    store.add(ownerA, listOf(reusedProvisional))
    assertEquals(listOf(reusedProvisional), store.attachments.value[ownerA])

    store.remove(resolvedA, setOf(first.id, late.id))
    assertEquals(null, store.attachments.value[resolvedA])
  }

  @Test
  fun ownerResolutionMigratesParkedDraftsAttachmentsAndImportsAfterNavigation() {
    val provisional = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val unrelated = ChatComposerOwner("gateway", "other", "agent:other:device")
    val resolved = ChatComposerOwner("gateway", "work", "agent:work:device")
    val drafts = ChatComposerTextDraftStore()
    val attachments = ChatComposerAttachmentStore()
    val parked = pendingAttachment("parked")
    val late = pendingAttachment("late")
    val unrelatedAttachment = pendingAttachment("unrelated")
    drafts[provisional] = "parked draft"
    drafts[unrelated] = "other draft"
    attachments.add(provisional, listOf(parked))
    attachments.add(unrelated, listOf(unrelatedAttachment))
    val importId = attachments.beginImport(provisional)

    assertEquals(setOf(provisional), drafts.migrateMatching(resolved, resolved.sessionKey))
    val migration = attachments.migrateMatching(resolved, resolved.sessionKey)
    attachments.completeImport(importId, listOf(late))

    assertEquals(setOf(provisional), migration.sources)
    assertEquals(0, migration.omittedCount)
    assertEquals("parked draft", drafts[resolved])
    assertEquals("other draft", drafts[unrelated])
    assertEquals(listOf(parked, late), attachments.get(resolved))
    assertEquals(listOf(unrelatedAttachment), attachments.get(unrelated))
  }

  @Test
  fun pendingAttachmentsAreBoundedAcrossComposerOwners() {
    val ownerA = ChatComposerOwner("gateway", "agent-a", "session-a")
    val ownerB = ChatComposerOwner("gateway", "agent-b", "session-b")
    val store =
      ChatComposerAttachmentStore(
        maxTotalAttachmentCount = 8,
        maxTotalBase64Chars = 8,
        maxTotalDecodedBytes = 5,
      )
    val first = pendingAttachment("first", base64 = "AAAA")
    val second = pendingAttachment("second", base64 = "BBBB")

    assertEquals(0, store.add(ownerA, listOf(first)))
    assertEquals(1, store.add(ownerB, listOf(second)))
    assertEquals(listOf(first), store.attachments.value[ownerA])
    assertEquals(null, store.attachments.value[ownerB])
  }

  @Test
  fun durableAdmissionClearsOnlyTheUnchangedOriginatingDraft() {
    val owner = ChatComposerOwner(gatewayStableId = "gateway", agentId = "agent-a", sessionKey = "session-a")
    val accepted =
      ChatComposerSendAdmission(
        id = 1,
        owner = owner,
        message = "send me",
        inputSnapshot = " send me ",
        attachmentIds = setOf("image"),
        accepted = true,
      )

    assertEquals("", clearAcceptedChatComposerInput(accepted, owner, " send me "))
    assertEquals(null, clearAcceptedChatComposerInput(accepted, owner, "new draft"))
    assertEquals(null, clearAcceptedChatComposerInput(accepted, owner.copy(sessionKey = "session-b"), "send me"))
    assertEquals(null, clearAcceptedChatComposerInput(accepted.copy(accepted = false), owner, "send me"))
  }

  @Test
  fun ownerMigrationRetainsAndReportsAttachmentsBeyondTheDestinationLimit() {
    val from = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val to = ChatComposerOwner("gateway", "main", "agent:main:device")
    val store = ChatComposerAttachmentStore()
    val destination = (1..7).map { pendingAttachment("destination-$it") }
    val source = listOf(pendingAttachment("source-1"), pendingAttachment("source-2"))
    store.add(to, destination)
    store.add(from, source)

    assertEquals(1, store.migrate(from, to))
    assertEquals(CHAT_COMPOSER_MAX_ATTACHMENTS, store.attachments.value[to]?.size)
    assertEquals(listOf(source.last()), store.attachments.value[from])
  }

  @Test
  fun composerOwnerUsesTheSameSessionFallbackAsTheViewModel() {
    assertEquals(
      ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "alpha", sessionKey = "agent:alpha:main"),
      resolveChatComposerOwner(
        gatewayStableId = "gateway-a",
        gatewayDefaultAgentId = "main",
        sessionKey = " ",
        mainSessionKey = "agent:alpha:main",
      ),
    )
  }

  @Test
  fun composerOwnerRetainsVerifiedRoutingOnlyForTheSameGateway() {
    val retained = GatewayDefaultAgentOwner(gatewayStableId = "gateway-a", agentId = "agent-a")

    assertEquals(
      ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "main"),
      resolveChatComposerOwner(
        gatewayStableId = "gateway-a",
        gatewayDefaultAgentId = null,
        lastVerifiedOwner = retained,
        sessionKey = "main",
        mainSessionKey = "main",
      ),
    )
    assertFalse(
      resolveChatComposerOwner(
        gatewayStableId = "gateway-b",
        gatewayDefaultAgentId = null,
        lastVerifiedOwner = retained,
        sessionKey = "main",
        mainSessionKey = "main",
      ).routingVerified,
    )
  }

  @Test
  fun stagedShareRejectsAReplacementComposerOwner() {
    val share = ChatShareDraft(id = 7, text = "share", imageUris = emptyList(), droppedImageCount = 0)
    val owner = ChatComposerOwner(gatewayStableId = "gateway-a", agentId = "agent-a", sessionKey = "session-a")

    assertFalse(
      canCommitStagedChatShare(
        stagedId = share.id,
        currentHead = share,
        ownerSnapshot = owner,
        currentOwner = owner.copy(sessionKey = "session-b"),
      ),
    )
  }

  @Test
  fun sendIsDisabledWhileShareHeadStages() {
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = true,
        sendInFlight = false,
      ),
    )
    assertTrue(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
        sendInFlight = false,
      ),
    )
    assertFalse(
      chatComposerSendEnabled(
        voiceNoteState = VoiceNoteRecorderState.Idle,
        pendingRunCount = 0,
        hasContent = true,
        shareStaging = false,
        sendInFlight = true,
      ),
    )
  }

  private fun pendingAttachment(
    id: String,
    base64: String = id,
  ): PendingAttachment =
    PendingAttachment(
      id = id,
      fileName = "$id.jpg",
      mimeType = "image/jpeg",
      base64 = base64,
    )
}
