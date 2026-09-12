package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.media.AudioRecord
import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35], shadows = [FailingRestartAudioRecord::class])
class WearAudioFailureTest {
  @Before
  fun resetRecorder() = FailingRestartAudioRecord.reset()

  @After
  fun clearRecorder() = FailingRestartAudioRecord.reset()

  @Test
  fun failedRecorderRestartReachesTheViewModelErrorAndClosesAttempt() = checkFailedRestart(throws = true)

  @Test
  fun stoppedRecorderRestartReachesTheViewModelErrorAndClosesAttempt() = checkFailedRestart(throws = false)

  private fun checkFailedRestart(throws: Boolean) =
    withViewModel { vm, fixture, audioScheduler ->
      val client = fixture.client
      fixture.activate()
      vm.setTalkTestField("talkAttemptId", "attempt-1")
      client.callTalkTestMethod("startCapture", fixture.attempt)
      assertTrue(client.isCapturing.value)
      client.callTalkTestMethod("pauseCaptureLocked")
      FailingRestartAudioRecord.failStart = throws
      FailingRestartAudioRecord.stayStopped = !throws
      client.callTalkTestMethod("clearOutput", fixture.attempt, true)
      // Check before running queued audio: a failed start must never publish capture.
      assertFalse("failed restart must not report Listening", client.isCapturing.value)
      audioScheduler.runCurrent()
      testScheduler.runCurrent()
      assertTrue("failed restart must signal the production error owner", client.channelFailed.value)
      assertTrue(vm.state.value.realtimePlaybackFailed)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, vm.state.value.failure)
      assertEquals(2, FailingRestartAudioRecord.releases)
      assertEquals(0, FailingRestartAudioRecord.reads)
      assertClosed(fixture)
    }

  @Test
  fun stoppedInitialRecorderStartFailsThroughTheViewModelAndClosesAttempt() =
    withViewModel { vm, fixture, _ ->
      @Suppress("UNCHECKED_CAST")
      val state = vm.talkTestField("mutableState") as MutableStateFlow<WearUiState>
      state.value = WearUiState(loading = false, connected = true, phoneNodeId = "phone-a", selectedSession = WearSession("agent:main:proof", "Proof", null, false, "phone-a"))
      FailingRestartAudioRecord.stayStopped = true
      vm.startRealtimeTalk()
      // Completed Play services Tasks post callbacks to the Android main looper.
      repeat(4) {
        testScheduler.runCurrent()
        shadowOf(Looper.getMainLooper()).idle()
      }
      testScheduler.runCurrent()
      assertFalse(fixture.client.isCapturing.value)
      assertFalse(state.value.realtimeTalk.active)
      assertFalse(state.value.talkBusy)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, state.value.failure)
      assertEquals(1, FailingRestartAudioRecord.releases)
      assertEquals(0, FailingRestartAudioRecord.reads)
      assertClosed(fixture)
    }

  @Test
  fun zeroReadsWhileRecordingKeepCaptureAlive() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      (client.talkTestField("scope") as CoroutineScope).cancel()
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))
      fixture.activate()
      try {
        client.callTalkTestMethod("startCapture", fixture.attempt)
        // yield after each zero read lets this check stop the otherwise continuous loop.
        val capture = client.talkTestField("captureJob") as Job
        FailingRestartAudioRecord.onRead = {
          if (FailingRestartAudioRecord.reads == 3) {
            assertTrue(client.isCapturing.value)
            assertFalse(client.channelFailed.value)
            assertEquals(0, fixture.channelCloses.get())
            capture.cancel()
          }
        }
        testScheduler.runCurrent()
        assertEquals(3, FailingRestartAudioRecord.reads)
        assertFalse(client.channelFailed.value)
        assertFalse(fixture.rpcEntered.isCompleted)
      } finally {
        client.shutdown()
      }
    }

  @Test
  fun staleRestartCannotCaptureOrFailTheReplacementAttempt() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      (client.talkTestField("scope") as CoroutineScope).cancel()
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))
      fixture.activate()
      client.disconnectLocal()
      val replacement = fixture.attempt.copy(generation = 2L, attemptId = "replacement")
      client.callTalkTestMethod("activate", replacement)
      FailingRestartAudioRecord.stayStopped = true
      try {
        client.callTalkTestMethod("clearOutput", fixture.attempt, true)
        assertFalse(client.channelFailed.value)
        assertFalse(client.isCapturing.value)
        assertEquals(0, FailingRestartAudioRecord.starts)
        assertEquals(replacement, client.talkTestField("activeAttempt"))
      } finally {
        client.shutdown()
      }
    }

  private fun assertClosed(fixture: WearTalkTestFixture) {
    assertEquals(1, fixture.input.closes.get())
    assertEquals(1, fixture.output.closes.get())
    assertEquals(1, fixture.channelCloses.get())
    assertTrue("failed capture must stop its phone attempt", fixture.rpcEntered.isCompleted)
  }

  private fun withViewModel(test: TestScope.(WearViewModel, WearTalkTestFixture, TestCoroutineScheduler) -> Unit) =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val owner =
        object : ViewModelStoreOwner {
          override val viewModelStore = ViewModelStore()
        }
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[WearViewModel::class.java]
      val client = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      val fixture = WearTalkTestFixture(app, client) { id -> WearRealtimeTalkSnapshot(attemptId = id, active = true) }
      fixture.rpcReply.complete(Unit)
      (vm.talkTestField("loadJob") as? Job)?.cancel()
      (client.talkTestField("scope") as CoroutineScope).cancel()
      // Keep the blocking channel reader separate from the ViewModel startup path.
      val audioDispatcher = StandardTestDispatcher(TestCoroutineScheduler())
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + audioDispatcher))
      try {
        testScheduler.runCurrent()
        test(vm, fixture, audioDispatcher.scheduler)
      } finally {
        owner.viewModelStore.clear()
        client.shutdown()
        Dispatchers.resetMain()
      }
    }
}

@Implements(AudioRecord::class)
class FailingRestartAudioRecord {
  private var recording = false

  @Implementation
  fun getState(): Int = AudioRecord.STATE_INITIALIZED

  @Implementation
  fun getRecordingState(): Int = if (recording) AudioRecord.RECORDSTATE_RECORDING else AudioRecord.RECORDSTATE_STOPPED

  @Implementation
  fun startRecording() {
    starts += 1
    if (failStart) throw IllegalStateException("controlled recorder restart denial")
    recording = !stayStopped
  }

  @Implementation
  fun read(
    buffer: ByteArray,
    offset: Int,
    size: Int,
  ): Int {
    check(offset >= 0 && size <= buffer.size - offset)
    reads += 1
    onRead?.invoke()
    return 0
  }

  @Implementation
  fun stop() {
    recording = false
  }

  @Implementation
  fun release() {
    releases += 1
  }

  companion object {
    @JvmStatic
    @Implementation
    fun getMinBufferSize(
      sampleRate: Int,
      channelConfig: Int,
      audioFormat: Int,
    ): Int = if (sampleRate > 0 && channelConfig > 0 && audioFormat > 0) 4096 else -1

    var failStart = false
    var stayStopped = false
    var starts = 0
    var reads = 0
    var releases = 0
    var onRead: (() -> Unit)? = null

    fun reset() {
      failStart = false
      stayStopped = false
      starts = 0
      reads = 0
      releases = 0
      onRead = null
    }
  }
}
