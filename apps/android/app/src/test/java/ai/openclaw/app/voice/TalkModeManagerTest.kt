package ai.openclaw.app.voice

import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthTokenStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import android.media.AudioManager
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

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
  fun transientAudioFocusLossDoesNotCancelAssistantSpeech() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(7L)
    isSpeaking(manager).value = true

    audioFocusListener(manager).onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)

    assertFalse(playbackJob.isCancelled)
    assertEquals(7L, playbackGeneration(manager).get())
    assertTrue(isSpeaking(manager).value)
  }

  @Test
  fun permanentAudioFocusLossCancelsAssistantSpeech() {
    val manager = createManager()
    val playbackJob = Job()

    setPrivateField(manager, "ttsJob", playbackJob)
    playbackGeneration(manager).set(7L)
    isSpeaking(manager).value = true

    audioFocusListener(manager).onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)

    assertTrue(playbackJob.isCancelled)
    assertEquals(8L, playbackGeneration(manager).get())
    assertFalse(isSpeaking(manager).value)
  }

  @Test
  fun talkPromptRequestsClearEnglishForLocalTts() {
    val prompt = buildPrompt(createManager(), "你好，介绍一下你自己")

    assertTrue(prompt.contains("Reply in clear, simple English"))
    assertTrue(prompt.contains("你好，介绍一下你自己"))
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
  fun nonPendingFinalWithoutSessionDoesNotUseAllResponseTts() {
    val manager = createManager()

    manager.ttsOnAllResponses = true
    manager.handleGatewayEvent("chat", chatFinalPayloadWithoutSession(runId = "run-other", text = "do not speak this"))

    assertEquals(0L, playbackGeneration(manager).get())
  }

  @Test
  fun noSpeechTimeoutKeepsNemoInListeningMode() {
    val manager = createManager()

    isEnabled(manager).value = true
    isListening(manager).value = true
    setPrivateField(manager, "listeningMode", true)
    listener(manager).onError(SpeechRecognizer.ERROR_SPEECH_TIMEOUT)

    assertTrue(isListening(manager).value)
    assertEquals("Listening", statusText(manager).value)
  }

  @Test
  fun noMatchKeepsNemoInListeningMode() {
    val manager = createManager()

    isEnabled(manager).value = true
    isListening(manager).value = true
    setPrivateField(manager, "listeningMode", true)
    listener(manager).onError(SpeechRecognizer.ERROR_NO_MATCH)

    assertTrue(isListening(manager).value)
    assertEquals("Listening", statusText(manager).value)
  }

  private fun createManager(): TalkModeManager {
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
      scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
      session = session,
      supportsChatSubscribe = false,
      isConnected = { true },
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun playbackGeneration(manager: TalkModeManager): AtomicLong {
    return readPrivateField(manager, "playbackGeneration") as AtomicLong
  }

  @Suppress("UNCHECKED_CAST")
  private fun isSpeaking(manager: TalkModeManager): MutableStateFlow<Boolean> {
    return readPrivateField(manager, "_isSpeaking") as MutableStateFlow<Boolean>
  }

  @Suppress("UNCHECKED_CAST")
  private fun isEnabled(manager: TalkModeManager): MutableStateFlow<Boolean> {
    return readPrivateField(manager, "_isEnabled") as MutableStateFlow<Boolean>
  }

  @Suppress("UNCHECKED_CAST")
  private fun isListening(manager: TalkModeManager): MutableStateFlow<Boolean> {
    return readPrivateField(manager, "_isListening") as MutableStateFlow<Boolean>
  }

  @Suppress("UNCHECKED_CAST")
  private fun statusText(manager: TalkModeManager): MutableStateFlow<String> {
    return readPrivateField(manager, "_statusText") as MutableStateFlow<String>
  }

  private fun audioFocusListener(manager: TalkModeManager): AudioManager.OnAudioFocusChangeListener {
    return readPrivateField(manager, "audioFocusListener") as AudioManager.OnAudioFocusChangeListener
  }

  private fun listener(manager: TalkModeManager): RecognitionListener {
    return readPrivateField(manager, "listener") as RecognitionListener
  }

  private fun buildPrompt(manager: TalkModeManager, transcript: String): String {
    val method = manager.javaClass.getDeclaredMethod("buildPrompt", String::class.java)
    method.isAccessible = true
    return method.invoke(manager, transcript) as String
  }

  private fun setPrivateField(target: Any, name: String, value: Any?) {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    field.set(target, value)
  }

  private fun readPrivateField(target: Any, name: String): Any? {
    val field = target.javaClass.getDeclaredField(name)
    field.isAccessible = true
    return field.get(target)
  }

  private fun chatFinalPayload(runId: String, text: String): String {
    return """
      {
        "runId": "$runId",
        "sessionKey": "main",
        "state": "final",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "$text" }
          ]
        }
      }
    """.trimIndent()
  }

  private fun chatFinalPayloadWithoutSession(runId: String, text: String): String {
    return """
      {
        "runId": "$runId",
        "state": "final",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "$text" }
          ]
        }
      }
    """.trimIndent()
  }
}

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  override fun loadEntry(deviceId: String, role: String): DeviceAuthEntry? = null

  override fun saveToken(deviceId: String, role: String, token: String, scopes: List<String>) = Unit

  override fun clearToken(deviceId: String, role: String) = Unit
}
