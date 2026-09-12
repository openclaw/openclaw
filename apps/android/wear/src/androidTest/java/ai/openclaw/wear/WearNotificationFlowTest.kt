package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.Instrumentation
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Parcel
import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import com.google.android.gms.common.api.GoogleApi
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.ChannelClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream

/** Actual notification PendingIntent → launcher → ViewModel → wire IO. No screenshot mode. */
@RunWith(AndroidJUnit4::class)
class WearNotificationFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)

  @Test
  fun notificationAWhileBIsOpenAndColdStart() {
    val app = instrumentation.targetContext.applicationContext as WearApplication
    val phone = ControlledPhone()
    val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    val previousClient = clientField.get(app)
    val previousRepository = repositoryField.get(app)
    val failures = mutableListOf<String>()
    var activity: MainActivity? = null
    clientField.set(app, lazyOf(phone.client))
    repositoryField.set(app, lazyOf(WearGatewayRepository(phone.client)))
    val manager = app.getSystemService(NotificationManager::class.java)
    val previousNotifications = manager.activeNotifications.map { it.tag to it.id }.toSet()
    try {
      val a = notification(app, manager, "agent:alpha:shared", "notification-a")
      val b = notification(app, manager, "agent:beta:shared", "notification-b")
      activity = instrumentation.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
      lateinit var vm: WearViewModel
      instrumentation.runOnMainSync { vm = ViewModelProvider(checkNotNull(activity))[WearViewModel::class.java] }
      await { !vm.state.value.loading && vm.state.value.connected }
      assertEquals(
        "agent:beta:shared",
        vm.state.value.selectedSession
          ?.key,
      )
      if (a == b) failures += "A and B share an open PendingIntent"
      a.send()
      SystemClock.sleep(3500)
      await { !vm.state.value.loading }
      if (vm.state.value.selectedSession
          ?.key != "agent:alpha:shared"
      ) {
        failures += "Warm A opens B instead of A"
      }
      if (!device.hasObject(By.text("Alpha reply"))) failures += "Warm A transcript missing"
      b.send()
      SystemClock.sleep(2000)
      await { !vm.state.value.loading }
      assertEquals(
        "agent:beta:shared",
        vm.state.value.selectedSession
          ?.key,
      )
      val warmActivity = checkNotNull(activity)
      instrumentation.runOnMainSync { warmActivity.finish() }
      instrumentation.waitForIdleSync()
      activity = null
      val monitor = instrumentation.addMonitor(MainActivity::class.java.name, null, false)
      a.send()
      activity = instrumentation.waitForMonitorWithTimeout(monitor, 10000) as? MainActivity
      instrumentation.removeMonitor(monitor)
      assertTrue("Cold PendingIntent launches MainActivity", activity != null)
      instrumentation.runOnMainSync { vm = ViewModelProvider(checkNotNull(activity))[WearViewModel::class.java] }
      await { !vm.state.value.loading && vm.state.value.connected }
      if (vm.state.value.selectedSession
          ?.key != "agent:alpha:shared"
      ) {
        failures += "Cold A follows current phone B"
      }
      // Return from real remote input after the conversation changed underneath it.
      instrumentation.runOnMainSync {
        vm.openSession(WearSession("agent:beta:shared", "Beta", null, false, "synthetic-phone"))
      }
      await { !vm.state.value.loading }
      val inputMonitor =
        object : Instrumentation.ActivityMonitor() {
          override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
            vm.openSession(WearSession("agent:alpha:shared", "Alpha", null, false, "synthetic-phone"))
            val result = Intent()
            RemoteInput.addResultsToIntent(
              arrayOf(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Message").build()),
              result,
              Bundle().apply { putCharSequence(REPLY_RESULT_KEY, "Reply written for Beta") },
            )
            return Instrumentation.ActivityResult(Activity.RESULT_OK, result)
          }
        }
      instrumentation.addMonitor(inputMonitor)
      try {
        repeat(6) {
          if (device
              .findObject(By.text("Type"))
              ?.visibleBounds
              ?.height()
              ?.let { it > 12 } != true
          ) {
            device.swipe(190, 290, 190, 130, 12)
            SystemClock.sleep(250)
          }
        }
        device.findObject(By.text("Type")).click()
        SystemClock.sleep(2000)
        await { !vm.state.value.loading && !vm.state.value.sending }
        if (phone.sends != 0) failures += "Stale input sent to a different conversation"
      } finally {
        instrumentation.removeMonitor(inputMonitor)
      }
      instrumentation.runOnMainSync {
        vm.openSession(WearSession("agent:beta:shared", "Beta", null, false, "synthetic-phone"))
        vm.refresh()
      }
      await { !vm.state.value.loading }
      val channels = ControlledChannels(app)
      val talkClient =
        WearViewModel::class.java
          .getDeclaredField("realtimeTalkClient")
          .apply { isAccessible = true }
          .get(vm) as WearRealtimeTalkClient
      WearRealtimeTalkClient::class.java
        .getDeclaredField("channelClient")
        .apply { isAccessible = true }
        .set(talkClient, channels)
      val currentActivity = checkNotNull(activity)
      instrumentation.runOnMainSync {
        currentActivity.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(extraWearLaunchTarget, "voice"))
      }
      SystemClock.sleep(2000)
      val talkButton = device.findObject(By.desc("Talk"))
      assertTrue("Production Talk control reachable", talkButton != null)
      talkButton.click()
      await { vm.state.value.realtimeTalk.active && vm.state.value.realtimeCapturing }
      assertEquals("agent:beta:shared", phone.talkSession)
      a.send()
      SystemClock.sleep(3500)
      await { !vm.state.value.loading }
      if (phone.stoppedAttempt != phone.talkAttempt) failures += "Notification did not stop original Talk attempt"
      if (vm.state.value.realtimeCapturing || vm.state.value.realtimeTalk.active) failures += "Notification left Talk active"
      if (vm.state.value.selectedSession
          ?.key != "agent:alpha:shared"
      ) {
        failures += "Talk notification did not open A"
      }
      if (!device.hasObject(By.text("Alpha reply"))) failures += "Talk notification did not navigate to Chat A"
      channels.shutdown()
      println("B2_NATIVE_ASSERTIONS: " + failures.ifEmpty { listOf("PASS") }.joinToString("; "))
      assertEquals("Captured notification context", emptyList<String>(), failures)
    } finally {
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      manager.activeNotifications.filter { it.tag?.startsWith("ai.openclaw.wear.NOTIFICATION.") == true && (it.tag to it.id) !in previousNotifications }.forEach { manager.cancel(it.tag, it.id) }
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }

  private fun notification(
    app: WearApplication,
    manager: NotificationManager,
    key: String,
    id: String,
  ): PendingIntent {
    val reply = if (key.contains("alpha")) "Alpha reply" else "Beta reply"
    WearReplyNotifier(app).show(
      WearInboundEvent(
        "synthetic-phone",
        1,
        WearEventType.Chat,
        Json.parseToJsonElement(
          """{"sessionKey":"$key","runId":"$id","state":"final","message":{"id":"$id","role":"assistant","content":"$reply"}}""",
        ),
        "b2-epoch",
      ),
    )
    return manager.activeNotifications
      .single {
        it.notification.extras
          .getCharSequence("android.text")
          ?.toString() == reply
      }.notification.contentIntent
  }

  private fun await(predicate: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + 15000
    while (!predicate() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
    assertTrue("Production state reached", predicate())
    instrumentation.waitForIdleSync()
    SystemClock.sleep(800)
  }

  private class ControlledChannels(
    context: Context,
  ) : ChannelClient(context, GoogleApi.Settings.DEFAULT_SETTINGS) {
    private val input = PipedInputStream()
    private val keepOpen = PipedOutputStream(input)
    private val output =
      object : OutputStream() {
        override fun write(value: Int) = Unit
      }
    private val channel =
      object : ChannelClient.Channel {
        override fun getNodeId() = "synthetic-phone"

        override fun getPath() = WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH

        override fun describeContents() = 0

        override fun writeToParcel(
          dest: Parcel,
          flags: Int,
        ) = Unit
      }

    override fun openChannel(
      nodeId: String,
      path: String,
    ): Task<ChannelClient.Channel> {
      assertEquals("synthetic-phone", nodeId)
      return Tasks.forResult(channel)
    }

    override fun getInputStream(channel: ChannelClient.Channel): Task<InputStream> = Tasks.forResult(input)

    override fun getOutputStream(channel: ChannelClient.Channel): Task<OutputStream> = Tasks.forResult(output)

    fun shutdown() {
      input.close()
      keepOpen.close()
    }

    override fun close(channel: ChannelClient.Channel): Task<Void> {
      shutdown()
      return Tasks.forResult(null)
    }

    override fun close(
      channel: ChannelClient.Channel,
      errorCode: Int,
    ): Task<Void> = close(channel)

    override fun registerChannelCallback(callback: ChannelClient.ChannelCallback): Task<Void> = Tasks.forResult(null)

    override fun registerChannelCallback(
      channel: ChannelClient.Channel,
      callback: ChannelClient.ChannelCallback,
    ): Task<Void> = Tasks.forResult(null)

    override fun unregisterChannelCallback(callback: ChannelClient.ChannelCallback): Task<Boolean> = Tasks.forResult(true)

    override fun unregisterChannelCallback(
      channel: ChannelClient.Channel,
      callback: ChannelClient.ChannelCallback,
    ): Task<Boolean> = Tasks.forResult(true)

    override fun receiveFile(
      channel: ChannelClient.Channel,
      uri: Uri,
      append: Boolean,
    ): Task<Void> = error("Unexpected file IO")

    override fun sendFile(
      channel: ChannelClient.Channel,
      uri: Uri,
    ): Task<Void> = error("Unexpected file IO")

    override fun sendFile(
      channel: ChannelClient.Channel,
      uri: Uri,
      offset: Long,
      length: Long,
    ): Task<Void> = error("Unexpected file IO")
  }

  private class ControlledPhone {
    var sends = 0
    var talkSession: String? = null
    var talkAttempt: String? = null
    var stoppedAttempt: String? = null
    val client: WearProxyClient =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { "synthetic-phone" },
        transport = WearMessageTransport { _, _, bytes -> respond(bytes) },
      )

    private suspend fun respond(bytes: ByteArray) {
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val key = request.params["sessionKey"]?.jsonPrimitive?.content
      val reply = if (key?.contains("alpha") == true) "Alpha reply" else "Beta reply"
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"beta","activeSessionKey":"agent:beta:shared"}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"activeAgentId":"beta","sessions":[{"key":"agent:beta:shared","displayName":"Beta","agentId":"beta"}]}""")
          }

          WearRpcMethod.ChatHistory -> {
            Json.parseToJsonElement("""{"sessionKey":"$key","messages":[{"id":"$key","role":"assistant","content":"$reply"}]}""")
          }

          WearRpcMethod.ChatSend -> {
            sends += 1
            Json.parseToJsonElement("""{"status":"started"}""")
          }

          WearRpcMethod.TalkStart -> {
            talkSession = key
            talkAttempt =
              request.params
                .getValue("attemptId")
                .jsonPrimitive.content
            WearRealtimeTalkCodec.encode(WearRealtimeTalkSnapshot(attemptId = talkAttempt, active = true, listening = true, status = WearRealtimeTalkStatus.LISTENING))
          }

          WearRpcMethod.TalkStop -> {
            stoppedAttempt =
              request.params
                .getValue("attemptId")
                .jsonPrimitive.content
            WearRealtimeTalkCodec.encode(WearRealtimeTalkSnapshot(attemptId = stoppedAttempt))
          }

          else -> {
            error("Unexpected IO: " + request.method)
          }
        }
      client.handleMessage(
        "synthetic-phone",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(
          WearMessage.Response(requestId = request.requestId, ok = true, result = result, eventStreamId = "b2-epoch", eventSequence = 0),
        ),
      )
    }
  }
}
