package ai.openclaw.wear

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.speech.tts.TextToSpeech
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WearReplySpeakerTest {
  @Test
  fun deniedFocusNeverSubmitsSpeech() {
    val context = RuntimeEnvironment.getApplication()
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val speaker = WearReplySpeaker(context)
    try {
      speaker.awaitWork()
      val engine = speaker.talkTestField("engine") as TextToSpeech
      shadowOf(engine).onInitListener.onInit(TextToSpeech.SUCCESS)
      speaker.speak("Controlled reply")
      speaker.awaitWork()
      shadowOf(Looper.getMainLooper()).idle()
      assertNull("focus denial must not submit text to TTS", shadowOf(engine).lastSpokenText)
      assertTrue(speaker.failed.value)
      assertFalse(speaker.isSpeaking.value)
    } finally {
      speaker.shutdownAndJoin()
    }
  }

  @Test
  fun queuedSpeechReportsFocusDenialWhenInitializationCompletes() {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
      .setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val speaker = WearReplySpeaker(context)
    try {
      speaker.speak("Queued reply")
      speaker.awaitWork()
      val engine = speaker.talkTestField("engine") as TextToSpeech
      shadowOf(engine).onInitListener.onInit(TextToSpeech.SUCCESS)
      speaker.awaitWork()
      assertTrue(speaker.failed.value)
      assertNull(shadowOf(engine).lastSpokenText)
      assertFalse(speaker.isSpeaking.value)
    } finally {
      speaker.shutdownAndJoin()
    }
  }

  @Test
  fun stopAndShutdownInvalidatePendingInitializationAndUtteranceCallbacks() {
    val speaker = WearReplySpeaker(RuntimeEnvironment.getApplication())
    speaker.awaitWork()
    val engine = speaker.talkTestField("engine") as TextToSpeech
    val shadow = shadowOf(engine)
    try {
      speaker.speak("Obsolete pending reply")
      speaker.stop()
      shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
      speaker.awaitWork()
      assertNull(shadow.lastSpokenText)
      speaker.speak("First")
      speaker.awaitWork()
      val first = speaker.talkTestField("activeUtterance") as String
      speaker.speak("Replacement")
      speaker.awaitWork()
      val second = speaker.talkTestField("activeUtterance") as String
      shadow.utteranceProgressListener.onStart(second)
      shadow.utteranceProgressListener.onError(first, TextToSpeech.ERROR)
      shadow.utteranceProgressListener.onDone(first)
      speaker.awaitWork()
      assertTrue(speaker.isSpeaking.value)
      assertFalse(speaker.failed.value)
      shadow.utteranceProgressListener.onError(second, TextToSpeech.ERROR)
      speaker.awaitWork()
      assertTrue(speaker.failed.value)
      assertFalse(speaker.isSpeaking.value)
      speaker.shutdownAndJoin()
      shadow.utteranceProgressListener.onStart(second)
      shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
      speaker.speak("Must not restart")
      speaker.stop()
      speaker.shutdown()
      assertTrue(shadow.isShutdown)
      assertFalse(speaker.isSpeaking.value)
      assertFalse(speaker.failed.value)
    } finally {
      speaker.shutdownAndJoin()
    }
  }

  @Test
  fun shutdownBeforeInitializationDoesNotReplayQueuedSpeech() {
    val speaker = WearReplySpeaker(RuntimeEnvironment.getApplication())
    try {
      speaker.speak("Must not start after disposal")
      speaker.awaitWork()
      val shadow = shadowOf(speaker.talkTestField("engine") as TextToSpeech)
      speaker.shutdownAndJoin()
      shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
      assertTrue(shadow.isShutdown)
      assertNull(shadow.lastSpokenText)
      assertFalse(speaker.isSpeaking.value)
      assertFalse(speaker.failed.value)
    } finally {
      speaker.shutdownAndJoin()
    }
  }

  private fun WearReplySpeaker.awaitWork() {
    val completed = CountDownLatch(1)
    assertTrue((talkTestField("handler") as Handler).post { completed.countDown() })
    assertTrue("speech worker did not finish", completed.await(5, TimeUnit.SECONDS))
  }

  private fun WearReplySpeaker.shutdownAndJoin() {
    val worker = talkTestField("worker") as HandlerThread
    shutdown()
    worker.join(5_000)
    assertFalse("speech worker must exit after shutdown", worker.isAlive)
  }
}
