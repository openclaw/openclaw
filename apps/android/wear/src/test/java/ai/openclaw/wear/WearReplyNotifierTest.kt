package ai.openclaw.wear

import ai.openclaw.wear.shared.WearEventType
import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearReplyNotifierTest {
  @Test
  fun failedReplyReplacementStillOpensAppAndRetriesOriginalRoute() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = context.getSystemService(NotificationManager::class.java)
    val notifier = WearReplyNotifier(context)
    notifier.show(
      WearInboundEvent(
        sourceNodeId = "phone",
        sequence = 1,
        event = WearEventType.Chat,
        payload =
          Json.parseToJsonElement(
            """{"state":"final","sessionKey":"session","message":{"id":"message","role":"assistant","content":"Hello"}}""",
          ),
      ),
    )
    val original = manager.activeNotifications.single()
    assertOpensApp(original.notification)

    notifier.showReplyFailure("session", original.tag, "phone")

    val replacement = manager.activeNotifications.single()
    assertEquals(original.tag, replacement.tag)
    assertEquals(original.id, replacement.id)
    val notification = replacement.notification
    assertEquals(context.getString(R.string.notification_reply_failed_title), notification.extras.getString(Notification.EXTRA_TITLE))
    assertTrue(notification.flags and Notification.FLAG_AUTO_CANCEL != 0)
    assertTrue(notification.flags and Notification.FLAG_LOCAL_ONLY != 0)
    val reply = notification.actions.single()
    assertEquals(context.getString(R.string.notification_reply), reply.title.toString())
    assertEquals(REPLY_RESULT_KEY, reply.remoteInputs.single().resultKey)
    assertTrue(reply.allowGeneratedReplies)
    val pendingReply = shadowOf(reply.actionIntent)
    assertTrue(pendingReply.isBroadcast)
    assertEquals(PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_ONE_SHOT, pendingReply.flags)
    assertEquals(
      original.notification.actions
        .single()
        .actionIntent,
      reply.actionIntent,
    )
    val route = pendingReply.savedIntent
    assertEquals(ComponentName(context, WearReplyReceiver::class.java), route.component)
    assertEquals("session", route.getStringExtra(EXTRA_SESSION_KEY))
    assertEquals(original.tag, route.getStringExtra(EXTRA_NOTIFICATION_TAG))
    assertEquals("phone", route.getStringExtra(EXTRA_PHONE_NODE_ID))
    assertEquals(
      shadowOf(
        original.notification.actions
          .single()
          .actionIntent,
      ).savedIntent.action,
      route.action,
    )
    assertOpensApp(notification)
  }

  @Test
  fun preferredPhoneChangeOpensAppWithoutStaleReplyAction() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    WearReplyNotifier(context).showPreferredPhoneChanged("notification")

    val notification =
      context
        .getSystemService(NotificationManager::class.java)
        .activeNotifications
        .single()
        .notification
    assertNull(notification.actions)
    assertOpensApp(notification)
  }

  private fun assertOpensApp(notification: Notification) {
    val context = RuntimeEnvironment.getApplication()
    val open = notification.contentIntent
    assertNotNull("Notification body must open the app", open)
    assertTrue(shadowOf(open).isActivity)
    assertTrue(open.isImmutable)
    open.send()
    assertEquals(ComponentName(context, MainActivity::class.java), shadowOf(context).nextStartedActivity.component)
  }

  @Test
  fun visibilityTracksOverlappingActivityLifecycles() {
    val tracker = VisibleActivityTracker()

    tracker.onStarted()
    tracker.onStarted()
    tracker.onStopped()
    assertTrue(tracker.isVisible())
    tracker.onStopped()
    assertTrue(!tracker.isVisible())
  }

  @Test
  fun pendingIntentIdentityDoesNotUseCollidingStringHashCodes() {
    check("Aa".hashCode() == "BB".hashCode())

    val first = replyPendingIntentAction("Aa", "notification-1")
    val second = replyPendingIntentAction("BB", "notification-1")

    assertNotEquals(first, second)
    assertTrue(first.startsWith("ai.openclaw.wear.REPLY."))
  }

  @Test
  fun distinctFinalMessagesUseDistinctNotificationAndReplyIdentities() {
    val firstMessage = WearChatMessage(id = "m1", role = "assistant", text = "first", timestamp = 1)
    val secondMessage = WearChatMessage(id = "m2", role = "assistant", text = "second", timestamp = 2)

    val firstTag = replyNotificationTag("session", firstMessage, "run-1")
    val secondTag = replyNotificationTag("session", secondMessage, "run-2")

    assertNotEquals(firstTag, secondTag)
    assertNotEquals(
      replyPendingIntentAction("session", firstTag),
      replyPendingIntentAction("session", secondTag),
    )
  }

  @Test
  fun missingMessageIdentityUsesStableEventFallback() {
    val message = WearChatMessage(id = null, role = "assistant", text = "same", timestamp = null)

    val first = replyNotificationTag("session", message, "run-1")
    val retry = replyNotificationTag("session", message, "run-1")
    val distinct = replyNotificationTag("session", message, "run-2")

    assertEquals(first, retry)
    assertNotEquals(first, distinct)
  }

  @Test
  fun fallbackIdentitySeparatesPhoneProcessEpochs() {
    val message = WearChatMessage(id = null, role = "assistant", text = "same", timestamp = null)

    val first = replyNotificationTag("session", message, "source:phone\u0000stream:epoch-1\u0000sequence:1")
    val restarted = replyNotificationTag("session", message, "source:phone\u0000stream:epoch-2\u0000sequence:1")

    assertNotEquals(first, restarted)
  }

  @Test
  fun notificationRetryIdentityIsStableForTheSameLogicalReply() {
    val first = notificationReplyIdempotencyKey("session", "notification", "reply")
    val retry = notificationReplyIdempotencyKey("session", "notification", "reply")
    val edited = notificationReplyIdempotencyKey("session", "notification", "edited")

    assertEquals(first, retry)
    assertNotEquals(first, edited)
  }

  @Test
  fun preferredPhoneChangeRequiresAppRecoveryInsteadOfAStaleRetry() {
    assertEquals(
      NotificationReplyFailureAction.OpenApp,
      notificationReplyFailureAction(WearProxyException("phone_changed", "preferred phone changed")),
    )
    assertEquals(
      NotificationReplyFailureAction.RetrySamePhone,
      notificationReplyFailureAction(WearProxyException("phone_unavailable", "offline")),
    )
  }
}
