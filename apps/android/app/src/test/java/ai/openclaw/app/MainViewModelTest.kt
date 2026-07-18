package ai.openclaw.app

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.chat.PendingAttachment
import android.content.Context
import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainViewModelTest {
  @After
  fun resetNodeServiceStartSuppression() {
    val app = RuntimeEnvironment.getApplication()
    NodeForegroundService.resume(app, startNow = false)
    val appShadow = shadowOf(app)
    while (appShadow.nextStartedService != null) {
      // Drain queued service intents so each test owns its lifecycle assertions.
    }
  }

  @Test
  fun foregroundStartupRequiresForegroundAndCompletedOnboarding() {
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = true,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = false,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = false,
      ),
    )
    assertTrue(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = true,
      ),
    )
  }

  @Test
  fun cronEditorDraftMemoryIsBoundedAndClearsOnlyItsOwningJob() {
    val memory = CronEditorDraftMemory()
    val first = draft("First")
    val second = draft("Second")

    memory.set("job-a", first)
    assertEquals(first, memory.get("job-a"))
    assertNull(memory.get("job-b"))

    memory.set("job-b", second)
    assertNull(memory.get("job-a"))
    memory.clear("job-a")
    assertEquals(second, memory.get("job-b"))

    memory.set("job-b", null)
    assertNull(memory.get("job-b"))
  }

  @Test
  fun disconnectStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)
    prefs.setOnboardingCompleted(true)

    viewModel.disconnect()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)

    viewModel.resumeNodeServiceForConnection()

    assertNodeServiceResumeRequested()
  }

  @Test
  fun pairNewGatewayStopsStickyNodeServiceWithoutClearingSavedGateways() {
    val (viewModel, prefs) = createViewModel()
    val gateway =
      GatewayRegistryEntry(
        stableId = "manual|gateway.test|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "gateway.test",
        host = "gateway.test",
        port = 18789,
      )
    prefs.gatewayRegistry.upsert(gateway)

    viewModel.pairNewGateway()

    assertNodeServiceStopRequested()
    assertEquals(listOf(gateway), prefs.gatewayRegistry.entries.value)
  }

  @Test
  fun assistantLaunchDraftCapturesItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()

    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "captured prompt",
        autoSend = false,
      ),
    )

    val draft = requireNotNull(viewModel.chatDraft.value)
    val captured = requireNotNull(draft.owner)
    assertEquals("captured prompt", draft.text)
    assertNull(
      claimChatDraftForOwner(
        draft = draft,
        owner = captured.copy(gatewayStableId = "another-gateway", agentId = "another-agent"),
        mainSessionKey = "agent:another-agent:main",
      ),
    )
  }

  @Test
  fun assistantAutoSendCapturesAndMigratesItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()

    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "send to the captured chat",
        autoSend = true,
      ),
    )

    val pending = requireNotNull(viewModel.pendingAssistantAutoSend.value)
    val resolvedOwner =
      pending.owner.copy(
        agentId = "work",
        sessionKey = "agent:work:device",
        routingVerified = true,
      )
    viewModel.resolveChatComposerOwnerAliases(to = resolvedOwner, mainSessionKey = resolvedOwner.sessionKey)

    assertEquals("send to the captured chat", viewModel.pendingAssistantAutoSend.value?.prompt)
    assertEquals(resolvedOwner, viewModel.pendingAssistantAutoSend.value?.owner)
  }

  @Test
  fun mediaAuthorizationMigratesWithItsProvisionalComposerOwner() {
    val (viewModel, _) = createViewModel()
    val provisional = ChatComposerOwner("gateway", "main", "main", routingVerified = false)
    val resolved = ChatComposerOwner("gateway", "work", "agent:work:device")
    val authorizationId = requireNotNull(viewModel.beginChatComposerMediaAcquisition(provisional))

    viewModel.resolveChatComposerOwnerAliases(to = resolved, mainSessionKey = resolved.sessionKey)

    assertEquals(
      0,
      viewModel.addChatComposerAttachments(
        owner = resolved,
        mediaAuthorizationId = authorizationId,
        attachments = listOf(PendingAttachment("migrated", "photo.jpg", "image/jpeg", "YQ==")),
      ),
    )
    assertEquals(1, viewModel.chatComposerAttachments.value[resolved]?.size)
  }

  @Test
  fun completedAssistantAutoSendClearsItsMigratedOperationButNotAReplacement() {
    val original =
      PendingAssistantAutoSend(
        prompt = "send once",
        owner = ChatComposerOwner("gateway", "main", "main"),
      )
    val migrated = original.copy(owner = original.owner.copy(sessionKey = "agent:main:device"))
    val replacement = PendingAssistantAutoSend(prompt = original.prompt, owner = migrated.owner)

    assertNull(clearCompletedAssistantAutoSend(migrated, original.id))
    assertEquals(replacement, clearCompletedAssistantAutoSend(replacement, original.id))
  }

  @Test
  fun refusedAssistantPromptBecomesEditableWithoutOverwritingNewerText() {
    assertEquals("send once", retainRefusedAssistantPrompt("send once", ""))
    assertEquals("send once\n\nnewer edit", retainRefusedAssistantPrompt("send once", "newer edit"))
    assertEquals("send once", retainRefusedAssistantPrompt("send once", "send once"))
  }

  @Test
  fun assistantAutoSendSharesTheManualComposerAdmissionGate() {
    val owner =
      ai.openclaw.app.chat
        .ChatComposerOwner("gateway", "main", "agent:main:device")

    assertTrue(chatComposerOwnerHasActiveSend(owner, setOf(owner), emptyMap()))
    assertTrue(
      chatComposerOwnerHasActiveSend(
        owner,
        emptySet(),
        mapOf(
          owner to
            ChatComposerSendAdmission(
              id = 1,
              owner = owner,
            ),
        ),
      ),
    )
    assertFalse(chatComposerOwnerHasActiveSend(owner, emptySet(), emptyMap()))
  }

  @Test
  fun gatewayAuthResetCleanupPurgesOnlyThatGatewaysComposerState() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val removed =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "main")
      val retained =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-b", "main", "main")
      viewModel.chatComposerTextDrafts[removed] = "private a"
      viewModel.chatComposerTextDrafts[retained] = "private b"
      val removedAttachment = PendingAttachment("a", "a.txt", "text/plain", "YQ==")
      val retainedAttachment = PendingAttachment("b", "b.txt", "text/plain", "Yg==")
      viewModel.addChatComposerAttachments(removed, listOf(removedAttachment))
      viewModel.addChatComposerAttachments(retained, listOf(retainedAttachment))

      viewModel.clearChatComposerGateway("gateway-a")

      assertEquals("", viewModel.chatComposerTextDrafts[removed])
      assertEquals("private b", viewModel.chatComposerTextDrafts[retained])
      assertEquals(null, viewModel.chatComposerAttachments.value[removed])
      assertEquals(listOf(retainedAttachment), viewModel.chatComposerAttachments.value[retained])
    }

  @Test
  fun gatewayAuthResetRejectsMediaCompletionsCapturedByRetiredCredentials() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val owner = ChatComposerOwner("gateway-a", "main", "main")
      val authorizationId = requireNotNull(viewModel.beginChatComposerMediaAcquisition(owner))
      var imageLoaderCalled = false

      viewModel.clearChatComposerGateway("gateway-a")

      assertFalse(viewModel.isChatComposerMediaAcquisitionActive(authorizationId))
      assertNull(
        viewModel.addChatComposerAttachments(
          owner = owner,
          mediaAuthorizationId = authorizationId,
          attachments = listOf(PendingAttachment("late", "late.txt", "text/plain", "YQ==")),
        ),
      )
      viewModel.importChatComposerAttachments(owner, authorizationId, mainSessionKey = "main", expectedCount = 1) {
        imageLoaderCalled = true
        listOf(PendingAttachment("late-image", "late.jpg", "image/jpeg", "YQ=="))
      }
      assertFalse(imageLoaderCalled)
      assertNull(viewModel.chatComposerAttachments.value[owner])
    }

  @Test
  fun deletedSessionCleanupPurgesItsMainAliasesWithoutTouchingSiblingOwners() =
    runBlocking {
      val (viewModel, _) = createViewModel()
      val alias =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "main")
      val canonical =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "agent:main:device")
      val provisional =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "placeholder", "main", routingVerified = false)
      val sibling =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "main", "agent:main:other")
      val otherAgent =
        ai.openclaw.app.chat
          .ChatComposerOwner("gateway-a", "work", "agent:main:device")
      val mediaAuthorizationId = requireNotNull(viewModel.beginChatComposerMediaAcquisition(canonical))
      listOf(alias, canonical, provisional, sibling, otherAgent).forEach { owner ->
        viewModel.chatComposerTextDrafts[owner] = owner.toString()
        viewModel.addChatComposerAttachments(
          owner,
          listOf(PendingAttachment(owner.toString(), "draft.txt", "text/plain", "YQ==")),
        )
      }

      viewModel.clearChatComposerSession(
        gatewayStableId = "gateway-a",
        agentId = "main",
        sessionKey = "main",
        mainSessionKey = "agent:main:device",
      )

      assertEquals("", viewModel.chatComposerTextDrafts[alias])
      assertEquals("", viewModel.chatComposerTextDrafts[canonical])
      assertEquals("", viewModel.chatComposerTextDrafts[provisional])
      assertEquals(sibling.toString(), viewModel.chatComposerTextDrafts[sibling])
      assertEquals(otherAgent.toString(), viewModel.chatComposerTextDrafts[otherAgent])
      assertEquals(null, viewModel.chatComposerAttachments.value[alias])
      assertEquals(null, viewModel.chatComposerAttachments.value[canonical])
      assertEquals(null, viewModel.chatComposerAttachments.value[provisional])
      assertEquals(1, viewModel.chatComposerAttachments.value[sibling]?.size)
      assertEquals(1, viewModel.chatComposerAttachments.value[otherAgent]?.size)
      assertFalse(viewModel.isChatComposerMediaAcquisitionActive(mediaAuthorizationId))
      assertNull(
        viewModel.addChatComposerAttachments(
          owner = canonical,
          mediaAuthorizationId = mediaAuthorizationId,
          attachments = listOf(PendingAttachment("late", "late.txt", "text/plain", "YQ==")),
        ),
      )
    }

  @Test
  fun replyDraftRejectsACallbackCapturedForAnotherChat() {
    val (viewModel, _) = createViewModel()
    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "initial",
        autoSend = false,
      ),
    )
    val owner = requireNotNull(viewModel.chatDraft.value?.owner)

    viewModel.setChatReplyDraft("quoted", owner)
    assertEquals("quoted", viewModel.chatDraft.value?.text)

    viewModel.setChatReplyDraft("stale", owner.copy(sessionKey = "agent:main:another"))
    assertEquals("quoted", viewModel.chatDraft.value?.text)
  }

  private fun assertNodeServiceStopRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStartedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertEquals("ai.openclaw.app.action.STOP", intent?.action)
  }

  private fun assertNodeServiceResumeRequested() {
    val app = RuntimeEnvironment.getApplication()
    val intent: Intent? = shadowOf(app).nextStartedService
    assertNotNull(intent)
    assertEquals(NodeForegroundService::class.java.name, intent?.component?.className)
    assertEquals("ai.openclaw.app.action.RESUME", intent?.action)
  }

  private fun createViewModel(): Pair<MainViewModel, SecurePrefs> {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        securePrefsOverride =
          app.getSharedPreferences(
            "main-view-model-test-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
          ),
      )
    return MainViewModel(app, prefs, SavedStateHandle()) to prefs
  }

  private fun draft(name: String): CronEditorDraftState {
    val edit =
      GatewayCronJobEdit(
        name = name,
        description = "",
        enabled = true,
        deleteAfterRun = false,
        schedule = GatewayCronScheduleEdit.At("2026-07-10T09:00:00Z"),
        sessionTarget = "isolated",
        wakeMode = "now",
        payload = GatewayCronPayloadEdit.SystemEvent("Wake up"),
      )
    return CronEditorDraftState(
      baseline = edit,
      edit = edit.copy(name = "$name draft"),
    )
  }
}
