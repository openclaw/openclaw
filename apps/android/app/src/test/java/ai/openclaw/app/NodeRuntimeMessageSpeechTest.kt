package ai.openclaw.app

import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.MessageSpeechController
import ai.openclaw.app.chat.MessageSpeechPhase
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.MessageSpeechSynthesizing
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.LocalSpeechSpeaking
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeMessageSpeechTest {
  @Test
  fun deletingSelectedChatCancelsPendingListenWithoutFallback() {
    runTest { assertDeletionRetiresListen(MessageSpeechPhase.Preparing) }
  }

  @Test
  fun deletingSelectedChatStopsPlaybackAndAllowsAnotherListen() {
    runTest { assertDeletionRetiresListen(MessageSpeechPhase.Speaking) }
  }

  private suspend fun TestScope.assertDeletionRetiresListen(phase: MessageSpeechPhase) {
    val app = RuntimeEnvironment.getApplication()
    val preferences =
      app.getSharedPreferences("message-speech-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val runtime =
      NodeRuntime(
        app,
        SecurePrefs(app, securePrefsOverride = preferences),
        initialReconnectSuppressed = true,
      )
    val originalScope = ReflectionHelpers.getField<CoroutineScope>(runtime, "scope")
    val originalChatScope = ReflectionHelpers.getField<CoroutineScope>(runtime.chat, "scope")
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val firstSynthesis = CompletableDeferred<TalkSpeakAudio?>()
    val player = RecordingPlayer()
    val localSpeech = RecordingLocalSpeech()
    var synthesisCount = 0
    var cancelledSynthesis = false
    try {
      ReflectionHelpers.setField(runtime, "scope", scope)
      ReflectionHelpers.setField(runtime.chat, "scope", scope)
      ReflectionHelpers.setField(
        runtime,
        "connectedEndpoint",
        GatewayEndpoint.manual("127.0.0.1", 18789),
      )
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
      installChatGateway(runtime)
      val mainSession = runtime.chat.sessionKey.value
      val selectedSession = "agent:main:dashboard:listen"
      runtime.switchChatSession(selectedSession)
      runCurrent()
      assertEquals(selectedSession, runtime.chat.sessionKey.value)

      // Keep the runtime's real lazy controller and its lifecycle wiring; replace only I/O.
      val lazyController =
        ReflectionHelpers.getField<Lazy<MessageSpeechController>>(
          runtime,
          "messageSpeechControllerLazy",
        )
      val controller = lazyController.value
      val synthesizer =
        MessageSpeechSynthesizing {
          synthesisCount += 1
          if (synthesisCount == 1 && phase == MessageSpeechPhase.Preparing) {
            try {
              firstSynthesis.await()
            } catch (error: CancellationException) {
              cancelledSynthesis = true
              throw error
            }
          } else {
            speechClip()
          }
        }
      ReflectionHelpers.setField(controller, "synthesizer", synthesizer)
      ReflectionHelpers.setField(controller, "player", player)
      ReflectionHelpers.setField(controller, "localSpeech", localSpeech)
      runtime.toggleMessageSpeech("saved-reply", "A saved assistant reply.")
      runCurrent()
      val listening = MessageSpeechState("saved-reply", phase)
      assertEquals(listening, runtime.messageSpeechState.value)
      assertEquals(1, synthesisCount)
      val stopCount = player.stopCount

      // Another client's unrelated deletion must not interrupt the selected reply.
      publishDeletion(runtime, "agent:main:dashboard:other")
      runCurrent()
      assertEquals(selectedSession, runtime.chat.sessionKey.value)
      assertEquals(listening, runtime.messageSpeechState.value)
      assertEquals(stopCount, player.stopCount)

      // This is the production gateway event entry point, not a UI switch or explicit Stop.
      publishDeletion(runtime, selectedSession)
      runCurrent()
      assertEquals(mainSession, runtime.chat.sessionKey.value)
      assertNull("Listen must retire with the deleted chat", runtime.messageSpeechState.value)
      assertEquals(stopCount + 1, player.stopCount)
      if (phase == MessageSpeechPhase.Preparing) assertTrue(cancelledSynthesis)
      firstSynthesis.complete(speechClip())
      runCurrent()
      val previousPlayCount = if (phase == MessageSpeechPhase.Speaking) 1 else 0
      assertEquals(previousPlayCount, player.playCount)
      assertTrue(localSpeech.spoken.isEmpty())

      // Retirement does not disable Listen for the surviving conversation.
      player.gate = CompletableDeferred()
      runtime.toggleMessageSpeech("main-reply", "A reply in the surviving conversation.")
      runCurrent()
      assertEquals(
        MessageSpeechState("main-reply", MessageSpeechPhase.Speaking),
        runtime.messageSpeechState.value,
      )
      assertEquals(2, synthesisCount)
      assertEquals(previousPlayCount + 1, player.playCount)
      player.gate.complete(Unit)
      runCurrent()
      assertNull(runtime.messageSpeechState.value)
      assertTrue(localSpeech.spoken.isEmpty())
    } finally {
      firstSynthesis.complete(null)
      scope.cancel()
      runCurrent()
      ReflectionHelpers.setField(runtime, "scope", originalScope)
      ReflectionHelpers.setField(runtime.chat, "scope", originalChatScope)
      closeNodeRuntimeTestFixture(runtime)
    }
  }

  private fun publishDeletion(
    runtime: NodeRuntime,
    key: String,
  ) {
    val payload = """{"reason":"delete","sessionKey":"$key","agentId":"main"}"""
    ReflectionHelpers.callInstanceMethod<Unit>(
      runtime,
      "handleGatewayEvent",
      ReflectionHelpers.ClassParameter.from(String::class.java, "sessions.changed"),
      ReflectionHelpers.ClassParameter.from(String::class.java, payload),
    )
  }

  private fun installChatGateway(runtime: NodeRuntime) {
    val request: suspend (String, String?) -> String = { method, _ ->
      when (method) {
        "chat.history" -> """{"sessionId":"fixture-session","messages":[]}"""
        "sessions.list" -> """{"sessions":[]}"""
        "health" -> """{"ok":true}"""
        else -> "{}"
      }
    }
    val scopedRequest: suspend (String, String, String?) -> String = { _, method, params ->
      request(method, params)
    }
    val captureLease: (ChatCacheScope?) -> GatewaySession.RequestLease? = { cacheScope ->
      GatewaySession.RequestLease(
        endpointStableId = cacheScope?.gatewayId.orEmpty(),
      ) { method, params, _, withEnqueue ->
        withEnqueue {}
        request(method, params)
      }
    }
    ReflectionHelpers.setField(runtime.chat, "requestGateway", request)
    ReflectionHelpers.setField(runtime.chat, "requestGatewayForGateway", scopedRequest)
    ReflectionHelpers.setField(runtime.chat, "captureRequestLease", captureLease)
  }

  private fun speechClip(): TalkSpeakAudio =
    TalkSpeakAudio(
      bytes = byteArrayOf(1, 2, 3),
      outputFormat = "mp3",
      mimeType = "audio/mpeg",
      fileExtension = ".mp3",
    )

  private class RecordingPlayer : TalkAudioPlaying {
    var gate = CompletableDeferred<Unit>()
    var playCount = 0
    var stopCount = 0
    private var activeGate: CompletableDeferred<Unit>? = null

    override suspend fun play(audio: TalkSpeakAudio) {
      playCount += 1
      val playback = gate
      activeGate = playback
      playback.await()
    }

    override fun stop() {
      stopCount += 1
      activeGate?.cancel()
      activeGate = null
    }
  }

  private class RecordingLocalSpeech : LocalSpeechSpeaking {
    val spoken = mutableListOf<String>()

    override suspend fun speak(text: String) {
      spoken += text
    }

    override fun stop() = Unit
  }
}
