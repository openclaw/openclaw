package ai.openclaw.app

import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.chatTerminalPayload
import ai.openclaw.app.gateway.GatewayEndpoint
import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Parcel
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadows.ShadowPendingIntent
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ConversationNotificationPendingIntentShadow::class])
@GraphicsMode(GraphicsMode.Mode.LEGACY)
class ConversationNotificationsTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val target =
    ConversationNotificationTarget(
      gatewayStableId = "gateway-a",
      agentId = "main",
      sessionKey = "agent:main:main",
      runId = "run-42",
    )

  @Test
  fun replyReceiverIsNotExported() {
    val packageManager = context.packageManager
    val receiverInfo =
      packageManager.getReceiverInfo(
        ComponentName(context, ConversationReplyReceiver::class.java),
        PackageManager.ComponentInfoFlags.of(0),
      )

    assertFalse(receiverInfo.exported)
  }

  @Test
  fun launchIntentTargetsPrivateTrampolineInsteadOfExportedMainActivity() {
    val intent = conversationNotificationLaunchIntent(context, target)
    val component = requireNotNull(intent.component)

    assertEquals(ConversationNotificationLaunchActivity::class.java.name, component.className)
    assertNotEquals(MainActivity::class.java.name, component.className)
  }

  @Test
  fun replyIntentTargetsPrivateReceiver() {
    val intent = conversationNotificationReplyIntent(context, target)
    val component = requireNotNull(intent.component)

    assertEquals(ConversationReplyReceiver::class.java.name, component.className)
  }

  @Test
  fun launchIntentIdentityDiffersAcrossConversationTargets() {
    val first = conversationNotificationLaunchIntent(context, target)
    val second =
      conversationNotificationLaunchIntent(
        context,
        target.copy(sessionKey = "agent:main:other", runId = "run-43"),
      )

    assertEquals(64, first.data?.lastPathSegment?.length)
    assertFalse(first.filterEquals(second))
  }

  @Test
  fun replyIntentIdentityDiffersAcrossConversationTargets() {
    val first = conversationNotificationReplyIntent(context, target)
    val second =
      conversationNotificationReplyIntent(
        context,
        target.copy(sessionKey = "agent:main:other", runId = "run-43"),
      )

    assertEquals(64, first.data?.lastPathSegment?.length)
    assertFalse(first.filterEquals(second))
  }

  @Test
  fun sameRequestCodeStillProducesDistinctPendingIntentsAcrossTargets() {
    val first =
      PendingIntent.getActivity(
        context,
        0,
        conversationNotificationLaunchIntent(context, target),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val second =
      PendingIntent.getActivity(
        context,
        0,
        conversationNotificationLaunchIntent(
          context,
          target.copy(sessionKey = "agent:main:other", runId = "run-43"),
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    assertNotEquals(first, second)
    first.cancel()
    second.cancel()
  }

  @Test
  fun sameRequestCodeStillProducesDistinctReplyPendingIntentsAcrossTargets() {
    val first =
      PendingIntent.getBroadcast(
        context,
        1,
        conversationNotificationReplyIntent(context, target),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
    val second =
      PendingIntent.getBroadcast(
        context,
        1,
        conversationNotificationReplyIntent(
          context,
          target.copy(sessionKey = "agent:main:other", runId = "run-43"),
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )

    assertNotEquals(first, second)
    first.cancel()
    second.cancel()
  }

  @Test
  fun privateTrampolineRejectsAlteredTargetIdentity() {
    val intent = conversationNotificationLaunchIntent(context, target)
    val forged = Intent(intent).putExtra("ai.openclaw.app.extra.CONVERSATION_RUN_ID", "forged-run")

    assertEquals(target, parseConversationNotificationTrampolineIntent(intent))
    assertNull(parseConversationNotificationTrampolineIntent(forged))
    assertEquals(
      null,
      parseConversationNotificationTrampolineIntent(Intent(intent).setAction(Intent.ACTION_VIEW)),
    )
  }

  @Test
  fun exportedMainActivityRejectsRawConversationTargetExtras() {
    val store = ConversationNotificationLaunchStore()
    val forged =
      Intent(conversationNotificationLaunchIntent(context, target))
        .setClass(context, MainActivity::class.java)

    assertNull(parseConversationNotificationLaunchIntent(forged, store::take))
  }

  @Test
  fun privateTrampolineForwardsOnlyAnOpaqueOneShotHandoff() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val controller =
      Robolectric
        .buildActivity(
          ConversationNotificationLaunchActivity::class.java,
          conversationNotificationLaunchIntent(context, target),
        ).create()
    val activity = controller.get()
    val forwarded = requireNotNull(shadowOf(activity).nextStartedActivity)

    assertEquals(MainActivity::class.java.name, forwarded.component?.className)
    assertEquals(target, parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
    assertNull(parseConversationNotificationLaunchIntent(forwarded, app.conversationNotificationLaunchStore::take))
    assertTrue(activity.isFinishing)
    controller.destroy()
  }

  @Test
  fun trustedMainActivityHandoffIsExactAndOneShot() {
    val store = ConversationNotificationLaunchStore()
    val launchToken = store.put(target)
    val intent = conversationNotificationMainIntent(context, launchToken)

    assertEquals(target, parseConversationNotificationLaunchIntent(intent, store::take))
    assertNull(parseConversationNotificationLaunchIntent(intent, store::take))
    assertNull(
      parseConversationNotificationLaunchIntent(
        conversationNotificationMainIntent(context, UUID.randomUUID().toString()),
        store::take,
      ),
    )
  }

  @After
  fun clearConversationNotification() {
    notificationManager()
      .activeNotifications
      .filter { it.tag == target.notificationTag }
      .forEach { notificationManager().cancel(it.tag, it.id) }
  }

  @Test
  fun assistantReplyBuildsPrivateConversationNotificationWithRemoteInput() {
    val notification = postAssistantReply(target, "The task is complete.")
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(target.shortcutId, notification.shortcutId)
    assertNotNull(notification.publicVersion)
    assertEquals(Notification.VISIBILITY_PUBLIC, notification.publicVersion.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
  }

  @Test
  fun oldReplyOutcomeDoesNotReplaceNewerConversationNotification() {
    for (outcome in listOf(ConversationNotificationReplyOutcome.Admitted, ConversationNotificationReplyOutcome.NotAdmitted)) {
      val reply = replyFrom(postAssistantReply(target, "Earlier assistant reply"))
      val newer = postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")

      assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", outcome) { true })

      val retained = currentNotification()
      assertEquals(newer.contentIntent, retained.contentIntent)
      assertEquals("Newer assistant reply", retained.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }
  }

  @Test
  fun sameRunRepostRetiresEveryOldReplyOutcomeAcrossNotifierInstances() {
    for (outcome in ConversationNotificationReplyOutcome.entries) {
      val oldReply = replyFrom(postAssistantReply(target, "Earlier assistant reply"))
      val newReply = replyFrom(postAssistantReply(target, "Newer assistant reply"))

      assertFalse(ConversationReplyNotifier(context).completeReply(oldReply, "Continue", outcome) { true })
      assertEquals("Newer assistant reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      assertTrue(ConversationReplyNotifier(context).completeReply(newReply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
      assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }
  }

  @Test
  fun sameRunRepostDoesNotUpgradeRetainedReplyActionPublication() {
    for (outcome in ConversationNotificationReplyOutcome.entries) {
      val retainedAction = postAssistantReply(target, "Earlier assistant reply").actions.single().actionIntent
      val newer = postAssistantReply(target, "Newer assistant reply")

      assertFalse("Reposting must not revoke an older holder's ability to submit its reply", shadowOf(retainedAction).isCanceled)
      // Read after repost: UPDATE_CURRENT changes extras on the token held by the old notice.
      val delivered = Intent(shadowOf(retainedAction).savedIntent)
      val oldReply = requireNotNull(parseConversationNotificationReplyIntent(delivered))
      assertEquals(target, oldReply.target)
      assertFalse(ConversationReplyNotifier(context).completeReply(oldReply, "Continue", outcome) { true })
      assertEquals("Newer assistant reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())

      val currentReply = replyFrom(newer)
      assertTrue(ConversationReplyNotifier(context).completeReply(currentReply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
      assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }
  }

  @Test
  fun replyGenerationSurvivesIntentParcelReconstruction() {
    val notification = postAssistantReply(target, "Synthetic reply")
    val original = shadowOf(notification.actions.single().actionIntent).savedIntent
    val parcel = Parcel.obtain()
    val delivered =
      try {
        original.writeToParcel(parcel, 0)
        parcel.setDataPosition(0)
        Intent.CREATOR.createFromParcel(parcel)
      } finally {
        parcel.recycle()
      }
    val reply = requireNotNull(parseConversationNotificationReplyIntent(delivered))

    assertEquals(target, reply.target)
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals(notification.contentIntent, currentNotification().contentIntent)
    assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun replyFillInCannotReplaceCreatorTargetOrGeneration() {
    val original = postAssistantReply(target, "Earlier assistant reply")
    val pendingReply = shadowOf(original.actions.single().actionIntent)
    val originalIntent = pendingReply.savedIntent
    val originalReply = requireNotNull(parseConversationNotificationReplyIntent(originalIntent))
    val newer = postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")
    val newerIntent = shadowOf(newer.actions.single().actionIntent).savedIntent
    val newerReply = requireNotNull(parseConversationNotificationReplyIntent(newerIntent))
    val delivered =
      Intent(originalIntent).apply {
        fillIn(
          Intent().setData(newerIntent.data).putExtra("ai.openclaw.app.extra.CONVERSATION_PUBLICATION_GENERATION", newerReply.generation),
          pendingReply.flags,
        )
      }
    val reply = requireNotNull(parseConversationNotificationReplyIntent(delivered))

    assertEquals(target, reply.target)
    assertEquals(originalReply.generation, reply.generation)
    assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals(newer.contentIntent, currentNotification().contentIntent)
  }

  @Test
  fun unknownReplyKeepsPrivateSubmittedTextAndOnlyOffersConversationCheck() {
    val original = postAssistantReply(target, "Synthetic reply")
    val reply = replyFrom(original)

    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Keep this submitted reply", ConversationNotificationReplyOutcome.Unknown) { true })

    val notification = currentNotification()
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals("Reply status is unknown. Open the conversation before sending again.", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    assertTrue(
      notification.extras
        .getCharSequence(Notification.EXTRA_BIG_TEXT)
        .toString()
        .contains("Keep this submitted reply"),
    )
    assertEquals(original.contentIntent, notification.contentIntent)
    assertEquals(
      "Open conversation",
      notification.actions
        .single()
        .title
        .toString(),
    )
    assertTrue(
      notification.actions
        .single()
        .remoteInputs
        .isNullOrEmpty(),
    )
    assertEquals(Notification.VISIBILITY_PUBLIC, notification.publicVersion.visibility)
    assertEquals(
      "Chat",
      notification.publicVersion.extras
        .getCharSequence(Notification.EXTRA_TEXT)
        .toString(),
    )
    assertNull(notification.publicVersion.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
  }

  @Test
  fun retiredServiceIntentCannotPublishAnyReplyOutcome() {
    for (outcome in ConversationNotificationReplyOutcome.entries) {
      val original = postAssistantReply(target, "Synthetic reply")
      val reply = replyFrom(original)

      assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", outcome) { false })
      assertEquals("Synthetic reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
      assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    }
  }

  @Test
  fun deniedNotificationPermissionDoesNotRetireExistingPublication() {
    val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
    shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertFalse(ConversationReplyNotifier(context).show(target.toComposerOwner(), "run-43", "Blocked reply"))
    assertFalse(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals("Synthetic reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Continue", ConversationNotificationReplyOutcome.Admitted) { true })
    assertEquals("Reply queued", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun replyOutcomeCanRenotifyAfterOriginalNotificationWasDismissed() {
    for (outcome in listOf(ConversationNotificationReplyOutcome.Unknown, ConversationNotificationReplyOutcome.Admitted)) {
      val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
      val original = notificationManager().activeNotifications.single { it.tag == target.notificationTag }
      notificationManager().cancel(original.tag, original.id)

      assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Keep this submitted reply", outcome) { true })
      val notification = currentNotification()
      assertEquals(
        "Open conversation",
        notification.actions
          .single()
          .title
          .toString(),
      )
      assertNotNull(notification.group)
      assertEquals(0, notification.flags and Notification.FLAG_GROUP_SUMMARY)
      assertEquals(
        if (outcome == ConversationNotificationReplyOutcome.Admitted) Notification.GROUP_ALERT_SUMMARY else Notification.GROUP_ALERT_ALL,
        notification.groupAlertBehavior,
      )
    }
  }

  @Test
  fun missingGenerationKeepsTargetButCannotClaimNotificationEffects() {
    val legacyIntent =
      conversationNotificationReplyIntent(context, target)
        .setData(Uri.parse("openclaw://conversation-notification/reply/${target.intentIdentityDigest}"))
    val legacyReply = requireNotNull(parseConversationNotificationReplyIntent(legacyIntent))
    postAssistantReply(target.copy(runId = "run-43"), "Newer assistant reply")

    assertEquals(target, legacyReply.target)
    assertNull(legacyReply.generation)
    assertFalse(ConversationReplyNotifier(context).completeReply(legacyReply, "Continue", ConversationNotificationReplyOutcome.Unknown) { true })
    assertEquals("Newer assistant reply", currentNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString())
  }

  @Test
  fun sendFailureNotificationKeepsRemoteInputForRetry() {
    val reply = replyFrom(postAssistantReply(target, "Synthetic reply"))
    assertTrue(ConversationReplyNotifier(context).completeReply(reply, "Retry this reply", ConversationNotificationReplyOutcome.NotAdmitted) { true })
    val notification = currentNotification()
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
    assertTrue(
      notification.extras
        .getCharSequence(Notification.EXTRA_BIG_TEXT)
        .toString()
        .contains("Retry this reply"),
    )
  }

  @Test
  fun notificationUsesConfiguredAgentNameAndSessionWithoutLeakingOnLockscreen() {
    val names =
      listOf(
        Triple("main", "Assistant", "Assistant"),
        Triple("reviewer", "Review agent", "Review agent"),
        Triple("research", " Researcher ", "Researcher"),
        Triple("unnamed", null, "unnamed"),
        Triple("blank-name", "  ", "blank-name"),
      )
    for ((agentId, configuredName, name) in names) {
      val notification =
        postAssistantReply(
          target.copy(agentId = agentId, sessionKey = "agent:$agentId:review"),
          "Done",
          configuredName,
          "Review",
        )
      val style = requireNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification))
      assertEquals("$name · Review", style.conversationTitle.toString())
      assertEquals(
        name,
        style.messages
          .single()
          .person
          ?.name
          .toString(),
      )
      assertEquals(
        "OpenClaw",
        notification.publicVersion.extras
          .getCharSequence(Notification.EXTRA_TITLE)
          .toString(),
      )
      assertFalse(
        notification.publicVersion.extras
          .toString()
          .contains("Review"),
      )
    }
  }

  @Test
  fun finalGatewayEventsNotifyOtherSessionsWhileForegroundButSuppressVisibleChat() {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    val prefs = SecurePrefs(context, securePrefsOverride = context.getSharedPreferences("notification-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(context, prefs)
    val manager = context.getSystemService(NotificationManager::class.java)
    try {
      ReflectionHelpers.setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
      val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
      chat.prepareAndSelectMainSessionKey("agent:reviewer:background")
      chat.handleGatewayEvent(
        "sessions.changed",
        """{"session":{"key":"agent:reviewer:background","label":"Troubleshooting"}}""",
      )
      chat.prepareAndSelectMainSessionKey("agent:main:visible")
      assertTrue(chat.sessions.value.none { it.ownerAgentId == "reviewer" })
      ReflectionHelpers.getField<MutableStateFlow<List<GatewayAgentSummary>>>(runtime, "_gatewayAgents").value =
        listOf(GatewayAgentSummary(id = "reviewer", name = "Review agent", emoji = null))
      runtime.setChatScreenActive(true)
      val handler = NodeRuntime::class.java.getDeclaredMethod("handleGatewayEvent", String::class.java, String::class.java).apply { isAccessible = true }

      fun finish(
        session: String,
        run: String,
        suppressNotification: Boolean? = null,
      ) {
        val original = Json.parseToJsonElement(chatTerminalPayload(session, run, 1, assistantText = "Done")).jsonObject
        val payload = JsonObject(original + (suppressNotification?.let { mapOf("suppressNotification" to JsonPrimitive(it)) } ?: emptyMap()))
        handler.invoke(runtime, "chat", payload.toString())
      }

      finish("agent:reviewer:background", "laptop-viewed-run", suppressNotification = true)
      assertTrue(manager.activeNotifications.isEmpty())

      finish("agent:reviewer:background", "background-run")
      val posted = manager.activeNotifications.single()
      val style = requireNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted.notification))
      assertEquals("Review agent · Troubleshooting", style.conversationTitle.toString())
      manager.cancelAll()

      finish("agent:main:visible", "visible-run")
      assertTrue(manager.activeNotifications.isEmpty())

      runtime.setChatScreenActive(false)
      finish("agent:main:visible", "settings-run")
      assertEquals(1, manager.activeNotifications.size)
      manager.cancelAll()

      runtime.setChatScreenActive(true)
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isForeground").value = false
      finish("agent:main:visible", "app-background-run")
      assertEquals(1, manager.activeNotifications.size)
      manager.cancelAll()

      finish("agent:reviewer:background", "laptop-left-run", suppressNotification = false)
      assertEquals(1, manager.activeNotifications.size)
      manager.cancelAll()

      finish("agent:main:dreaming-narrative-proof", "dream-run")
      finish("agent:main:background", "dreaming-narrative-proof")
      assertTrue(manager.activeNotifications.isEmpty())

      finish("agent:main:custom:dreaming-narrative-note", "ordinary-run")
      assertEquals(1, manager.activeNotifications.size)
      manager.cancelAll()

      shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
      finish("agent:reviewer:background", "permission-denied-run")
      assertTrue(manager.activeNotifications.isEmpty())
    } finally {
      manager.cancelAll()
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  private fun postAssistantReply(
    noticeTarget: ConversationNotificationTarget,
    text: String,
    agentName: String? = null,
    sessionTitle: String? = null,
  ): Notification {
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    assertTrue(ConversationReplyNotifier(context).show(noticeTarget.toComposerOwner(), noticeTarget.runId, text, agentName, sessionTitle))
    return notificationManager().activeNotifications.single { it.tag == noticeTarget.notificationTag }.notification
  }

  private fun replyFrom(notification: Notification): ConversationNotificationReply = requireNotNull(parseConversationNotificationReplyIntent(shadowOf(notification.actions.single().actionIntent).savedIntent))

  private fun currentNotification(): Notification = notificationManager().activeNotifications.single { it.tag == target.notificationTag }.notification

  private fun notificationManager(): NotificationManager = context.getSystemService(NotificationManager::class.java)
}

// Robolectric 4.16.1 compares Intent filters; Android compares tokens. Its factory and parcel cache retain token objects.
@Implements(PendingIntent::class)
class ConversationNotificationPendingIntentShadow : ShadowPendingIntent() {
  @RealObject
  private lateinit var token: PendingIntent

  @Implementation
  override fun equals(other: Any?): Boolean = token === other

  @Implementation
  override fun hashCode(): Int = System.identityHashCode(token)
}
