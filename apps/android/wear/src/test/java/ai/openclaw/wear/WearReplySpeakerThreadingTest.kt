package ai.openclaw.wear

import android.content.Context
import android.os.Looper
import android.speech.tts.TextToSpeech
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowTextToSpeech
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [BlockingWearTextToSpeech::class])
class WearReplySpeakerThreadingTest {
  @Test
  fun blockedEngineDoesNotBlockUiSpeechStopOrShutdown() {
    val speaker = WearReplySpeaker(RuntimeEnvironment.getApplication())
    assertTrue(BlockingWearTextToSpeech.created.await(5, TimeUnit.SECONDS))
    val engine = ShadowTextToSpeech.getLastTextToSpeechInstance()
    val shadow = Shadow.extract<BlockingWearTextToSpeech>(engine)
    val returned = CountDownLatch(1)
    val responsive = AtomicBoolean(false)
    val release =
      Thread {
        try {
          if (shadow.entered.await(5, TimeUnit.SECONDS)) {
            responsive.set(returned.await(1, TimeUnit.SECONDS))
          }
        } finally {
          shadow.release.countDown()
        }
      }.apply { start() }
    try {
      // Like the reported initialization-lock wait, stop stays blocked until
      // another thread releases it. The UI must still admit all three actions.
      speaker.speak("Pending reply")
      speaker.stop()
      speaker.shutdown()
      returned.countDown()
      release.join(5_000)
      assertTrue("UI waited for a blocked TTS call", responsive.get())
      assertFalse("TTS stop must not run on the UI thread", shadow.stopOnMain)
      assertTrue(shadow.closed.await(5, TimeUnit.SECONDS))
    } finally {
      shadow.release.countDown()
      speaker.shutdown()
      release.join(5_000)
    }
  }
}

@Implements(TextToSpeech::class)
class BlockingWearTextToSpeech : ShadowTextToSpeech() {
  val entered = CountDownLatch(1)
  val release = CountDownLatch(1)
  val closed = CountDownLatch(1)

  @Volatile var stopOnMain = false

  @Implementation
  override fun __constructor__(
    context: Context,
    listener: TextToSpeech.OnInitListener,
    engine: String?,
    packageName: String?,
    useFallback: Boolean,
  ) {
    super.__constructor__(context, listener, engine, packageName, useFallback)
    created.countDown()
  }

  @Implementation
  override fun stop(): Int {
    stopOnMain = stopOnMain || Looper.myLooper() == Looper.getMainLooper()
    entered.countDown()
    check(release.await(5, TimeUnit.SECONDS)) { "blocked TTS fixture was not released" }
    return super.stop()
  }

  @Implementation
  override fun shutdown() {
    super.shutdown()
    closed.countDown()
  }

  companion object {
    val created = CountDownLatch(1)
  }
}
