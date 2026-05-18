package ai.openclaw.app.voice

import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthTokenStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import android.os.SystemClock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkModeManagerTest {
  @Test
  fun stopTtsCancelsTrackedPlaybackJob() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(7L)

    manager.stopTts()

    assertTrue(playbackJob.isCancelled)
    assertEquals(8L, playbackGeneration(manager).get())
  }

  @Test
  fun disablingPlaybackCancelsTrackedJobOnce() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(11L)

    manager.setPlaybackEnabled(false)
    manager.setPlaybackEnabled(false)

    assertTrue(playbackJob.isCancelled)
    assertEquals(12L, playbackGeneration(manager).get())
  }

  @Test
  fun duplicateFinalForPendingTalkRunDoesNotStartAllResponseTts() {
    val manager = createManager()
    val final = CompletableDeferred<Boolean>()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "pendingRunId", "run-talk")
    setPrivateField(manager, "pendingFinal", final)

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-talk", text = "spoken once"))
    assertTrue(final.isCompleted)
    assertEquals(0L, playbackGeneration(manager).get())

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-talk", text = "spoken once"))

    assertEquals(0L, playbackGeneration(manager).get())
  }

  @Test
  fun nonPendingFinalStillUsesAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-other", text = "speak this"))

    assertEquals(1L, playbackGeneration(manager).get())
  }

  @Test
  fun nonPendingUserFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-user", text = "do not speak", role = "user"))

    assertEquals(0L, playbackGeneration(manager).get())
  }

  @Test
  fun realtimeToolFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "realtimeSessionId", "relay-1")
    realtimeToolRuns(manager)["run-tool"] =
      RealtimeToolRun(callId = "call-1", relaySessionId = "relay-1")

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-tool", text = "tool result"))

    assertEquals(0L, playbackGeneration(manager).get())
    assertTrue(realtimeToolRuns(manager).isEmpty())
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun realtimeStartWithoutGatewayTurnsTalkOff() =
    runTest {
      val stoppedByRelay = AtomicBoolean(false)
      val manager =
        createManager(
          scope = this,
          isConnected = { false },
          onStoppedByRelay = { stoppedByRelay.set(true) },
        )

      setPrivateField(manager, "executionMode", TalkModeExecutionMode.RealtimeRelay)
      setPrivateField(manager, "configLoaded", true)
      manager.setEnabled(true)
      advanceUntilIdle()

      assertFalse(manager.isEnabled.value)
      assertFalse(manager.isListening.value)
      assertEquals("Gateway not connected", manager.statusText.value)
      assertTrue(stoppedByRelay.get())
    }

  @Test
  fun staleRealtimeToolFinalDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    setPrivateField(manager, "realtimeSessionId", "relay-2")
    realtimeToolRuns(manager)["run-tool"] =
      RealtimeToolRun(callId = "call-1", relaySessionId = "relay-1")

    manager.handleGatewayEvent("chat", chatFinalPayload(runId = "run-tool", text = "stale result"))

    assertEquals(0L, playbackGeneration(manager).get())
    assertTrue(realtimeToolRuns(manager).isEmpty())
  }

  @Test
  fun textReadyDoesNotEnterSpeakingUntilAudioPlaybackStarts() =
    runTest {
      val talkSpeakClient = FakeTalkSpeechSynthesizer()
      val talkAudioPlayer = FakeTalkAudioPlayer()
      val manager = createManager(talkSpeakClient = talkSpeakClient, talkAudioPlayer = talkAudioPlayer)

      val job = launch { manager.speakAssistantReply("hello") }
      talkSpeakClient.requested.await()

      assertEquals("Generating voice…", manager.statusText.value)
      assertFalse(manager.isSpeaking.value)

      talkSpeakClient.result.complete(
        TalkSpeakResult.Success(
          TalkSpeakAudio(
            bytes = byteArrayOf(1, 2, 3),
            provider = "test",
            outputFormat = "mp3_44100_128",
            voiceCompatible = true,
            mimeType = "audio/mpeg",
            fileExtension = ".mp3",
          ),
        ),
      )
      talkAudioPlayer.started.await()

      assertEquals("Speaking…", manager.statusText.value)
      assertTrue(manager.isSpeaking.value)

      talkAudioPlayer.finished.complete(Unit)
      job.join()
    }

  @Test
  fun realtimeAudioFramesAreMutedDuringPlaybackAndSilence() {
    val manager = createManager()

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(0)))
    assertFalse(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(1_200)))
    assertFalse(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(1_200)))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(1_200)))
    assertTrue(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(0)))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() + 1_000)

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(1_200)))

    setPrivateField(manager, "realtimePlaybackEndsAtMs", SystemClock.elapsedRealtime() - 1)

    assertFalse(shouldAppendRealtimeCapturedFrame(manager, pcm16Frame(0)))
  }

  private fun createManager(
    talkSpeakClient: TalkSpeechSynthesizing = TalkSpeakClient(),
    talkAudioPlayer: TalkAudioPlaying? = null,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    isConnected: () -> Boolean = { true },
    onStoppedByRelay: () -> Unit = {},
  ): TalkModeManager {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = InMemoryDeviceAuthStore(),
        onConnected = { _, _, _ -> },
        onDisconnected = {},
        onEvent = { _, _ -> },
      )
    return TalkModeManager(
      context = app,
      scope = scope,
      session = session,
      supportsChatSubscribe = false,
      isConnected = isConnected,
      onStoppedByRelay = onStoppedByRelay,
      talkSpeakClient = talkSpeakClient,
      talkAudioPlayer = talkAudioPlayer ?: TalkAudioPlayer(app),
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun playbackGeneration(manager: TalkModeManager) =
    readPrivateField(manager, "playbackGeneration") as AtomicLong

  @Suppress("UNCHECKED_CAST")
  private fun realtimeToolRuns(manager: TalkModeManager) =
    readPrivateField(manager, "realtimeToolRuns") as MutableMap<String, RealtimeToolRun>

  private fun setPrivateField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    field.set(target, value)
  }

  private fun readPrivateField(
    target: Any,
    name: String,
  ): Any? {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target)
  }

  private fun shouldAppendRealtimeCapturedFrame(
    manager: TalkModeManager,
    frame: ByteArray,
  ): Boolean {
    val method =
      manager.javaClass.getDeclaredMethod(
        "shouldAppendRealtimeCapturedFrame",
        ByteArray::class.java,
        Int::class.javaPrimitiveType,
      )
    method.isAccessible = true
    return method.invoke(manager, frame, frame.size) as Boolean
  }

  private fun pcm16Frame(amplitude: Short): ByteArray {
    val frame = ByteArray(16)
    var index = 0
    while (index < frame.size) {
      frame[index] = (amplitude.toInt() and 0xff).toByte()
      frame[index + 1] = ((amplitude.toInt() shr 8) and 0xff).toByte()
      index += 2
    }
    return frame
  }

  private fun pcm16Frame(amplitude: Int): ByteArray = pcm16Frame(amplitude.toShort())

  private fun chatFinalPayload(
    runId: String,
    text: String,
    role: String = "assistant",
  ): String =
    """
    {
      "runId": "$runId",
      "sessionKey": "main",
      "state": "final",
      "message": {
        "role": "$role",
        "content": [
          { "type": "text", "text": "$text" }
        ]
      }
    }
    """.trimIndent()
}

private class FakeTalkSpeechSynthesizer : TalkSpeechSynthesizing {
  val requested = CompletableDeferred<Unit>()
  val result = CompletableDeferred<TalkSpeakResult>()

  override suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult {
    requested.complete(Unit)
    return result.await()
  }
}

private class FakeTalkAudioPlayer : TalkAudioPlaying {
  val started = CompletableDeferred<Unit>()
  val finished = CompletableDeferred<Unit>()
  var stopped = false

  override suspend fun play(audio: TalkSpeakAudio) {
    started.complete(Unit)
    finished.await()
  }

  override fun stop() {
    stopped = true
  }
}

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? = null

  override fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) = Unit

  override fun clearToken(
    deviceId: String,
    role: String,
  ) = Unit
}
