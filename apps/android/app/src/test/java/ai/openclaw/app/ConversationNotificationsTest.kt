package ai.openclaw.app

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

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
  fun launchIntentRoundTripsOnlyForTheOwnedAction() {
    val intent = conversationNotificationLaunchIntent(context, target)

    assertEquals(target, parseConversationNotificationLaunchIntent(intent))
    assertEquals(
      null,
      parseConversationNotificationLaunchIntent(Intent(intent).setAction(Intent.ACTION_VIEW)),
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
