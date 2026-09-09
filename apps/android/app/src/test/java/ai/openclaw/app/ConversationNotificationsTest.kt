package ai.openclaw.app

import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.chatTerminalPayload
import ai.openclaw.app.gateway.GatewayEndpoint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
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
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
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

  @Test
  fun assistantReplyBuildsPrivateConversationNotificationWithRemoteInput() {
    val notification =
      ConversationReplyNotifier(context).buildAssistantReplyNotification(target, "The task is complete.")
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
        ConversationReplyNotifier(context).buildAssistantReplyNotification(
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
      chat.prepareMainSessionKey("agent:main:visible")
      ChatController::class.java.getDeclaredMethod("publishSessions", List::class.java).apply { isAccessible = true }.invoke(
        chat,
        listOf(ChatSessionEntry(key = "agent:reviewer:background", updatedAtMs = null, label = "Troubleshooting")),
      )
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

  @Test
  fun sendFailureNotificationKeepsRemoteInputForRetry() {
    val notification =
      ConversationReplyNotifier(context).buildSendFailureNotification(target)
    val action = notification.actions.single()

    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals(1, notification.actions.size)
    assertEquals("Reply", action.title.toString())
    assertEquals(1, action.remoteInputs.size)
  }
}
