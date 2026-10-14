package ai.openclaw.wear

import android.content.Context
import android.media.AudioManager
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
      val engine = speaker.talkTestField("engine") as TextToSpeech
      shadowOf(engine).onInitListener.onInit(TextToSpeech.SUCCESS)
      speaker.speak("Controlled reply")
      shadowOf(Looper.getMainLooper()).idle()
      assertNull("focus denial must not submit text to TTS", shadowOf(engine).lastSpokenText)
      assertTrue(speaker.failed.value)
      assertFalse(speaker.isSpeaking.value)
    } finally {
      speaker.shutdown()
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
      val engine = speaker.talkTestField("engine") as TextToSpeech
      shadowOf(engine).onInitListener.onInit(TextToSpeech.SUCCESS)
      assertTrue(speaker.failed.value)
      assertNull(shadowOf(engine).lastSpokenText)
      assertFalse(speaker.isSpeaking.value)
    } finally {
      speaker.shutdown()
    }
  }

  @Test
  fun stopAndShutdownInvalidatePendingInitializationAndUtteranceCallbacks() {
    val speaker = WearReplySpeaker(RuntimeEnvironment.getApplication())
    val engine = speaker.talkTestField("engine") as TextToSpeech
    val shadow = shadowOf(engine)
    try {
      speaker.speak("Obsolete pending reply")
      speaker.stop()
      shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
      assertNull(shadow.lastSpokenText)
      speaker.speak("First")
      val first = speaker.talkTestField("activeUtterance") as String
      speaker.speak("Replacement")
      val second = speaker.talkTestField("activeUtterance") as String
      shadow.utteranceProgressListener.onStart(second)
      shadow.utteranceProgressListener.onError(first, TextToSpeech.ERROR)
      shadow.utteranceProgressListener.onDone(first)
      assertTrue(speaker.isSpeaking.value)
      assertFalse(speaker.failed.value)
      shadow.utteranceProgressListener.onError(second, TextToSpeech.ERROR)
      assertTrue(speaker.failed.value)
      assertFalse(speaker.isSpeaking.value)
      speaker.shutdown()
      shadow.utteranceProgressListener.onStart(second)
      shadow.onInitListener.onInit(TextToSpeech.SUCCESS)
      assertFalse(speaker.isSpeaking.value)
      assertFalse(speaker.failed.value)
    } finally {
      speaker.shutdown()
    }
  }
}
