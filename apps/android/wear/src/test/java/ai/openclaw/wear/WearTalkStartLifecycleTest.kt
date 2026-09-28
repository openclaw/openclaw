package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.Manifest
import android.content.Intent
import android.media.AudioRecord
import android.os.Looper
import android.provider.Settings
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.time.Duration
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35], shadows = [CountingTalkStartAudioRecord::class])
class WearTalkStartLifecycleTest {
  @Test
  fun pauseCancelsPendingStartBeforeStopAndReturnDoesNotRestartIt() =
    withActivity { controller, vm ->
      val pending = Job()
      vm.setTalkTestField("talkStartJob", pending)
      vm.setTalkTestField("talkAttemptId", "pending-start")
      try {
        controller.pause()
        idle()
        assertEquals(Lifecycle.State.STARTED, controller.get().lifecycle.currentState)
        val activeAfterPause = pending.isActive
        controller.stop()
        idle()
        assertFalse("ON_STOP still revokes pending Talk", pending.isActive)
        controller
          .restart()
          .start()
          .resume()
          .visible()
        idle()
        assertEquals(null, vm.talkTestField("talkStartJob"))
        assertEquals(null, vm.talkTestField("talkAttemptId"))
        assertFalse(vm.state.value.talkBusy)
        assertEquals(0, CountingTalkStartAudioRecord.starts)
        assertFalse("ON_PAUSE must revoke pending Talk before ON_STOP", activeAfterPause)
      } finally {
        pending.cancel()
      }
    }

  @Test
  fun lateStartResultCannotCaptureWhilePaused() = checkLateStartResult(returnBeforeResult = false)

  @Test
  fun returningBeforeLateStartResultDoesNotRestoreRevokedIntent() = checkLateStartResult(returnBeforeResult = true)

  private fun checkLateStartResult(returnBeforeResult: Boolean) =
    withActivity { controller, vm ->
      var reply: Continuation<WearRealtimeTalkSnapshot>? = null
      var attemptId: String? = null
      val client = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      val fixture =
        WearTalkTestFixture(controller.get(), client) { id ->
          attemptId = id
          // Model an already-delivered callback that returns despite cancellation.
          suspendCoroutine { reply = it }
        }
      fixture.rpcReply.complete(Unit)
      try {
        vm.startRealtimeTalk()
        idle()
        assertNotNull("production start reached the phone RPC", reply)
        assertTrue(vm.state.value.talkBusy)
        controller.pause()
        idle()
        if (returnBeforeResult) controller.resume().visible()
        reply!!.resume(WearRealtimeTalkSnapshot(attemptId = attemptId, active = true))
        reply = null
        idle()
        assertEquals("a revoked start must never start AudioRecord", 0, CountingTalkStartAudioRecord.starts)
        assertFalse(client.isCapturing.value)
        assertFalse(vm.state.value.realtimeTalk.active)
        assertFalse(vm.state.value.talkBusy)
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.output.closes.get())
        assertEquals(1, fixture.channelCloses.get())
        assertTrue("ambiguous start still stops its phone attempt", fixture.rpcEntered.isCompleted)
        if (!returnBeforeResult) controller.resume().visible()
        idle()
        assertEquals(0, CountingTalkStartAudioRecord.starts)
      } finally {
        reply?.resume(WearRealtimeTalkSnapshot(attemptId = attemptId))
        idle()
        client.shutdown()
      }
    }

  @Test
  fun completedStartRemainsActiveOnPauseAndStopsOnStop() =
    withActivity { controller, vm ->
      val client = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      val fixture =
        WearTalkTestFixture(controller.get(), client) { id ->
          WearRealtimeTalkSnapshot(attemptId = id, active = true)
        }
      fixture.rpcReply.complete(Unit)
      try {
        vm.startRealtimeTalk()
        idle()
        assertEquals(1, CountingTalkStartAudioRecord.starts)
        assertTrue(client.isCapturing.value)
        assertFalse(vm.state.value.talkBusy)
        controller.pause()
        idle()
        assertTrue("do not change paused-visible active-call policy", client.isCapturing.value)
        assertEquals(0, fixture.input.closes.get())
        controller.stop()
        idle()
        assertFalse(client.isCapturing.value)
        assertEquals(1, fixture.input.closes.get())
        controller
          .restart()
          .start()
          .resume()
          .visible()
        idle()
        assertEquals("return is not new recording intent", 1, CountingTalkStartAudioRecord.starts)
        assertFalse(client.isCapturing.value)
      } finally {
        client.shutdown()
      }
    }

  private fun withActivity(test: (ActivityController<MainActivity>, WearViewModel) -> Unit) {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val scale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    CountingTalkStartAudioRecord.starts = 0
    val controller = Robolectric.buildActivity(MainActivity::class.java, Intent())
    try {
      controller.setup().visible()
      idle()
      val vm = ViewModelProvider(controller.get())[WearViewModel::class.java]
      (vm.talkTestField("loadJob") as? Job)?.cancel()
      @Suppress("UNCHECKED_CAST")
      val state = vm.talkTestField("mutableState") as kotlinx.coroutines.flow.MutableStateFlow<WearUiState>
      state.value = WearUiState(loading = false, connected = true, phoneNodeId = "phone-a", selectedSession = WearSession("agent:main:proof", "Proof", null, false, "phone-a"))
      val client = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      (client.talkTestField("scope") as CoroutineScope).cancel()
      // Audio workers do not race lifecycle assertions; real startCapture still owns AudioRecord.
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher()))
      idle()
      assertEquals(Lifecycle.State.RESUMED, controller.get().lifecycle.currentState)
      test(controller, vm)
    } finally {
      if (controller.get().lifecycle.currentState == Lifecycle.State.RESUMED) controller.pause()
      if (controller
          .get()
          .lifecycle.currentState
          .isAtLeast(Lifecycle.State.STARTED)
      ) {
        controller.stop()
      }
      controller.destroy()
      idle()
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
    }
  }

  private fun idle() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
}

@Implements(AudioRecord::class)
class CountingTalkStartAudioRecord {
  private var recording = false

  @Implementation
  fun getRecordingState(): Int = if (recording) AudioRecord.RECORDSTATE_RECORDING else AudioRecord.RECORDSTATE_STOPPED

  @Implementation
  fun getState(): Int = AudioRecord.STATE_INITIALIZED

  @Implementation
  fun startRecording() {
    starts += 1
    recording = true
  }

  companion object {
    var starts = 0

    @JvmStatic
    @Implementation
    fun getMinBufferSize(
      sampleRate: Int,
      channelConfig: Int,
      audioFormat: Int,
    ): Int = if (sampleRate > 0 && channelConfig > 0 && audioFormat > 0) 4096 else -1
  }
}
