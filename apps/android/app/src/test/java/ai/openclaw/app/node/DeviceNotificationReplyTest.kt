package ai.openclaw.app.node

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowApplication
import org.robolectric.shadows.ShadowNotificationListenerService
import org.robolectric.shadows.ShadowNotificationManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceNotificationReplyTest {
  private lateinit var context: Context
  private lateinit var service: DeviceNotificationListenerService
  private lateinit var shadowService: ShadowNotificationListenerService
  private lateinit var shadowApplication: ShadowApplication

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    val controller = Robolectric.buildService(DeviceNotificationListenerService::class.java)
    controller.create()
    service = controller.get()
    shadowService = Shadow.extract(service)
    shadowApplication = Shadow.extract(RuntimeEnvironment.getApplication())
    shadowApplication.clearBroadcastIntents()
    val manager = context.getSystemService(NotificationManager::class.java)
    val shadowManager = Shadow.extract<ShadowNotificationManager>(manager)
    shadowManager.setNotificationListenerAccessGranted(
      ComponentName(context, DeviceNotificationListenerService::class.java),
      true,
    )
  }

  @After
  fun tearDown() {
    service.onListenerDisconnected()
    service.onDestroy()
    DeviceNotificationListenerService.setNodeEventSink(null)
    ShadowNotificationListenerService.reset()
    shadowApplication.clearBroadcastIntents()
  }

  @Test
  fun replySkipsIncompatibleActionAndDoesNotFillRestrictedInputs() {
    val restricted =
      RemoteInput
        .Builder("status")
        .setAllowFreeFormInput(false)
        .setChoices(arrayOf("Yes", "No"))
        .build()
    val freeform = RemoteInput.Builder("reply").build()
    val key =
      postNotification(
        replyAction("choice-action", restricted),
        replyAction("text-action", restricted, freeform),
      )

    val result = reply(key, "I will join at six")

    assertTrue(result.ok)
    val sent = shadowApplication.broadcastIntents.single()
    assertEquals("text-action", sent.action)
    val values = requireNotNull(RemoteInput.getResultsFromIntent(sent))
    assertEquals(setOf("reply"), values.keySet())
    assertEquals("I will join at six", values.getCharSequence("reply"))
  }

  @Test
  fun choicesOnlyReplyRejectsOtherTextButAcceptsAnOfferedChoice() {
    val restricted =
      RemoteInput
        .Builder("answer")
        .setAllowFreeFormInput(false)
        .setChoices(arrayOf("Yes", "No"))
        .build()
    val key = postNotification(replyAction("choice-action", restricted))

    val rejected = reply(key, "Other")

    assertFalse(rejected.ok)
    assertEquals("ACTION_UNAVAILABLE", rejected.code)
    assertTrue(shadowApplication.broadcastIntents.isEmpty())

    val accepted = reply(key, "Yes")

    assertTrue(accepted.ok)
    val sent = shadowApplication.broadcastIntents.single()
    assertEquals("choice-action", sent.action)
    val values = requireNotNull(RemoteInput.getResultsFromIntent(sent))
    assertEquals("Yes", values.getCharSequence("answer"))
  }

  private fun reply(
    key: String,
    text: String,
  ): NotificationActionResult =
    DeviceNotificationListenerService.executeAction(
      context,
      NotificationActionRequest(key, NotificationActionKind.Reply, text),
    )

  private fun replyAction(
    action: String,
    vararg inputs: RemoteInput,
  ): Notification.Action {
    val intent = Intent(action).setPackage(context.packageName)
    val pendingIntent =
      PendingIntent.getBroadcast(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
    val icon = Icon.createWithResource(context, android.R.drawable.ic_dialog_info)
    val builder = Notification.Action.Builder(icon, action, pendingIntent)
    inputs.forEach { builder.addRemoteInput(it) }
    return builder.build()
  }

  private fun postNotification(vararg actions: Notification.Action): String {
    val builder =
      Notification
        .Builder(context, "test-channel")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("Reply input contract")
    actions.forEach { builder.addAction(it) }
    val key = shadowService.addActiveNotification("com.example.reply", 401, builder.build())
    service.onListenerConnected()
    return key
  }
}
