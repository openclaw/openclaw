package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearRpcMethod
import android.animation.ValueAnimator
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.os.Parcel
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.android.gms.wearable.ChannelClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowValueAnimator
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.time.Duration
import kotlin.coroutines.EmptyCoroutineContext

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WearTalkAvatarTest {
  @Test
  fun stopClosesLocalAudioBeforeStalledRpcWithoutTerminalEvent() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      fixture.activate()
      // Exercise the real playback owner and capture teardown without a live microphone.
      client.invokePrivate("writeOutput", fixture.attempt, pcm16Le(samplesForFrames(2), 20_000))
      @Suppress("UNCHECKED_CAST")
      val capture = client.talkTestField("_isCapturing") as MutableStateFlow<Boolean>
      capture.value = true
      val captureJob = Job()
      client.setTalkTestField("captureJob", captureJob)
      val stop = async(start = CoroutineStart.UNDISPATCHED) { client.stop() }
      try {
        assertTrue(fixture.rpcEntered.isCompleted)
        assertFalse(stop.isCompleted)
        fixture.mark("assert-local-stopped")
        assertFalse("capture must stop before RPC reply", client.isCapturing.value)
        assertFalse("playback must stop before RPC reply", client.isPlaying.value)
        assertEquals(0f, client.mouthLevel.value, 0f)
        assertFalse(captureJob.isActive)
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.output.closes.get())
        assertEquals(1, fixture.channelCloses.get())
        assertTrue(fixture.events.indexOfFirst { it.endsWith("channel-close") } < fixture.events.indexOfFirst { it.endsWith("rpc-enter") })
        fixture.rpcReply.complete(Unit)
        stop.await()
        client.shutdown()
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.channelCloses.get())
      } finally {
        println(fixture.events.joinToString("\n"))
        stop.cancel()
        client.shutdown()
      }
    }

  @Test
  fun stopReleasesRecorderBeforeRpcEvenWhenCaptureJobHasNotRun() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      (client.talkTestField("scope") as CoroutineScope).cancel()
      client.setTalkTestField("scope", CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))
      fixture.activate()
      client.invokePrivate("startCapture", fixture.attempt)
      val recorder = client.talkTestField("audioRecord") as android.media.AudioRecord
      assertTrue(client.isCapturing.value)
      val stop = async(start = CoroutineStart.UNDISPATCHED) { client.stop() }
      try {
        assertTrue(fixture.rpcEntered.isCompleted)
        assertFalse(stop.isCompleted)
        assertFalse(client.isCapturing.value)
        assertEquals(android.media.AudioRecord.STATE_UNINITIALIZED, recorder.state)
        assertEquals(null, client.talkTestField("audioRecord"))
        testScheduler.runCurrent()
        assertEquals(1, fixture.input.closes.get())
      } finally {
        stop.cancel()
        client.shutdown()
      }
    }

  @Test
  fun shutdownClosesStreamsAndChannelBeforeQueuedScopeWorkCanRun() =
    runTest {
      val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
      val client = fixture.client
      (client.talkTestField("scope") as CoroutineScope).cancel()
      val cleanupScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
      client.setTalkTestField("scope", cleanupScope)
      fixture.activate()
      client.shutdown()
      try {
        assertFalse(cleanupScope.coroutineContext[Job]!!.isActive)
        assertEquals("input close cannot be queued in a cancelled scope", 1, fixture.input.closes.get())
        assertEquals(1, fixture.output.closes.get())
        assertEquals(1, fixture.channelCloses.get())
        client.shutdown()
        client.disconnectLocal()
        testScheduler.runCurrent()
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.channelCloses.get())
      } finally {
        println(fixture.events.joinToString("\n"))
      }
    }

  @Test
  fun shutdownWaitsForConcurrentLocalStreamClosureBeforeCancellingScope() {
    val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
    val client = fixture.client
    val closing = java.util.concurrent.CountDownLatch(1)
    val releaseClose = java.util.concurrent.CountDownLatch(1)
    val shutdownStarted = java.util.concurrent.CountDownLatch(1)
    val shutdownFinished = java.util.concurrent.CountDownLatch(1)
    val input =
      object : java.io.InputStream() {
        override fun read(): Int = -1

        override fun close() {
          closing.countDown()
          check(releaseClose.await(2, java.util.concurrent.TimeUnit.SECONDS))
          fixture.input.close()
        }
      }
    client.invokePrivate("activate", fixture.attempt.copy(resources = fixture.attempt.resources.copy(input = input)))
    val disconnect = kotlin.concurrent.thread { client.disconnectLocal() }
    var shutdown: Thread? = null
    try {
      assertTrue(closing.await(2, java.util.concurrent.TimeUnit.SECONDS))
      shutdown =
        kotlin.concurrent.thread {
          shutdownStarted.countDown()
          client.shutdown()
          shutdownFinished.countDown()
        }
      assertTrue(shutdownStarted.await(2, java.util.concurrent.TimeUnit.SECONDS))
      assertFalse(shutdownFinished.await(100, java.util.concurrent.TimeUnit.MILLISECONDS))
      assertTrue((client.talkTestField("scope") as CoroutineScope).coroutineContext[Job]!!.isActive)
      releaseClose.countDown()
      assertTrue(shutdownFinished.await(2, java.util.concurrent.TimeUnit.SECONDS))
      assertEquals(1, fixture.input.closes.get())
      assertEquals(1, fixture.output.closes.get())
      assertEquals(1, fixture.channelCloses.get())
    } finally {
      releaseClose.countDown()
      disconnect.join(2_000)
      shutdown?.join(2_000)
      client.shutdown()
    }
  }

  @Test
  fun shutdownReleasesBlockedReaderAndStaleCallbacksCannotReopenAudio() {
    val fixture = WearTalkTestFixture(RuntimeEnvironment.getApplication())
    val client = fixture.client
    fixture.activate()
    client.invokePrivate("startReader", fixture.attempt)
    try {
      assertTrue(fixture.input.entered.await(2, java.util.concurrent.TimeUnit.SECONDS))
      client.shutdown()
      assertTrue(fixture.input.released.await(2, java.util.concurrent.TimeUnit.SECONDS))
      client.invokePrivate("writeOutput", fixture.attempt, pcm16Le(samplesForFrames(1), 20_000))
      client.invokePrivate("handleChannelFailure", fixture.attempt)
      assertFalse(client.isPlaying.value)
      assertFalse(client.channelFailed.value)
      assertEquals(1, fixture.input.closes.get())
      assertEquals(1, fixture.channelCloses.get())
    } finally {
      // Release the controlled blocking read even when the original regression fails.
      fixture.input.released.countDown()
      client.shutdown()
    }
  }

  @Test
  fun silenceKeepsTheAvatarMouthClosed() {
    val pcm = ByteArray(samplesForFrames(2) * 2)

    assertEquals(listOf(0f, 0f), pcm16LeMouthLevels(pcm))
  }

  @Test
  fun outputPcmProducesOneBoundedMouthLevelPerPlaybackFrame() {
    val pcm = pcm16Le(samplesForFrames(2), sample = 24_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.all { level -> level in 0f..1f })
    assertTrue(levels.all { level -> level > 0.9f })
  }

  @Test
  fun finalPartialPlaybackFrameStillMovesTheMouth() {
    val pcm = pcm16Le(samplesForFrames(1) + 12, sample = 12_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.last() > 0f)
  }

  @Test
  fun consecutiveMaximumSizeChunksPreserveCumulativeWindowsAndFlushTheFinalPartial() {
    val chunks =
      listOf(
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 4_000),
        pcm16Le(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES / 2, sample = 20_000),
        pcm16Le(100, sample = 12_000),
      )
    val client = realtimeTalkClient()
    val queuedLevels = Channel<Float>(Channel.UNLIMITED)
    val attempt = realtimeAttempt(generation = 1L)
    client.setTalkTestField("activeAttempt", attempt)
    client.setTalkTestField("mouthFrames", queuedLevels)

    try {
      val writeOutput =
        WearRealtimeTalkClient::class.java.getDeclaredMethod(
          "writeOutput",
          WearRealtimeTalkClient.ActiveAttempt::class.java,
          ByteArray::class.java,
        )
      writeOutput.isAccessible = true
      chunks.forEach { chunk -> writeOutput.invoke(client, attempt, chunk) }
      awaitPlaybackTeardown(client)

      val actualLevels =
        buildList {
          while (true) add(queuedLevels.tryReceive().getOrNull() ?: break)
        }
      assertEquals(pcm16LeMouthLevels(chunks.reduce(ByteArray::plus)), actualLevels)
    } finally {
      client.shutdown()
    }
  }

  @Test
  fun staleAttemptCallbacksCannotMutateReplacement() {
    val client = realtimeTalkClient()
    val stale = realtimeAttempt(generation = 1L)
    val replacement = realtimeAttempt(generation = 2L)

    try {
      client.invokePrivate("activate", stale)
      client.invokePrivate("handleChannelFailure", stale)
      assertTrue(client.channelFailed.value)
      assertEquals(null, client.talkTestField("activeAttempt"))

      client.invokePrivate("activate", replacement)
      val replacementReader = Job()
      client.setTalkTestField("readJob", replacementReader)
      assertFalse(client.channelFailed.value)
      client.invokePrivate("writeOutput", stale, pcm16Le(samplesForFrames(1), sample = 20_000))
      client.invokePrivate("handleChannelFailure", stale)
      client.invokePrivate("closeLocal", stale, false)

      assertFalse(client.isPlaying.value)
      assertFalse(client.channelFailed.value)
      assertTrue(replacementReader.isActive)
      assertSame(replacement, client.talkTestField("activeAttempt"))
    } finally {
      client.shutdown()
    }
  }

  @Test
  fun realtimeAudioPathUsesNegotiatedAttemptScope() {
    assertEquals(
      WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH,
      wearRealtimeAudioChannelPath("attempt-7", attemptScopedAudio = false),
    )
    assertEquals(
      WearProtocol.realtimeAudioChannelPath("attempt-7"),
      wearRealtimeAudioChannelPath("attempt-7", attemptScopedAudio = true),
    )
  }

  @Test
  fun mouthEnvelopeUsesFastAttackAndSoftReleaseWithoutOvershoot() {
    val attack = smoothAvatarMouth(current = 0f, target = 1f, deltaSeconds = 0.02f)
    val release = smoothAvatarMouth(current = 1f, target = 0f, deltaSeconds = 0.02f)

    assertTrue(attack in 0f..1f)
    assertTrue(release in 0f..1f)
    assertTrue(attack > 0f)
    assertTrue(release > attack)
  }

  @Test
  fun mouthEnvelopeConvergesAcrossDisplayFrames() {
    var level = 0f
    repeat(30) { level = smoothAvatarMouth(level, target = 1f, deltaSeconds = 1f / 60f) }

    assertTrue(level > 0.99f)

    repeat(60) { level = smoothAvatarMouth(level, target = 0f, deltaSeconds = 1f / 60f) }

    assertTrue(level < 0.001f)
  }

  @Test
  fun avatarFrameDeltaHonorsAnimatorDurationScale() {
    val frameDelta = 1f / 60f

    assertEquals(1f / 30f, scaledAvatarDeltaSeconds(frameDelta, durationScale = 0.5f), 0.000_001f)
    assertEquals(frameDelta, scaledAvatarDeltaSeconds(frameDelta, durationScale = 1f), 0.000_001f)
    assertEquals(1f / 120f, scaledAvatarDeltaSeconds(frameDelta, durationScale = 2f), 0.000_001f)
  }

  @Test
  fun zeroAnimatorDurationScaleStopsAvatarTime() {
    assertEquals(0f, scaledAvatarDeltaSeconds(deltaSeconds = 1f / 60f, durationScale = 0f), 0f)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun effectiveScaleTransitionsStopAndRestartTheClockWhileComposed() {
    val scaleSource = FakeWearAnimatorScaleSource(initialScale = 1f)
    val motionScale = FakeMotionDurationScale(initialScale = 1f)
    AvatarFixture(scaleSource, motionScale).use { avatar ->
      assertEquals(1, scaleSource.subscriptionCount)
      assertTrue(avatar.hasAnimationFrames)
      val initial = avatar.pixels()
      avatar.frame(1_016_000_000L)
      assertFalse(initial.contentEquals(avatar.pixels()))

      scaleSource.emit(0f)
      avatar.settle()
      assertFalse(avatar.hasAnimationFrames)
      val disabled = avatar.pixels()
      avatar.recompose()
      assertFalse(avatar.hasAnimationFrames)
      assertTrue(disabled.contentEquals(avatar.pixels()))
      AvatarFixture(FakeWearAnimatorScaleSource(initialScale = 0f), motionScale).use { cold ->
        assertTrue(disabled.contentEquals(cold.pixels()))
      }

      scaleSource.emit(1f)
      avatar.settle()
      assertTrue(avatar.hasAnimationFrames)
      avatar.frame(2_000_000_000L)
      avatar.frame(2_016_000_000L)
      assertFalse(disabled.contentEquals(avatar.pixels()))
    }
    assertEquals(1, scaleSource.disposeCount)
    assertEquals(0, scaleSource.activeSubscriptionCount)
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun canonicalScaleChangesTheRenderedAnimationRate() {
    fun animatedPixels(
      scale: Float,
      secondFrame: Long,
    ): IntArray =
      AvatarFixture(FakeWearAnimatorScaleSource(1f), FakeMotionDurationScale(scale)).use { avatar ->
        val initial = avatar.pixels()
        avatar.frame(secondFrame)
        avatar.pixels().also { assertFalse(initial.contentEquals(it)) }
      }

    assertTrue(animatedPixels(1f, 1_016_000_000L).contentEquals(animatedPixels(2f, 1_032_000_000L)))
  }

  @Test
  @Config(sdk = [32])
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun api31And32CanonicalScaleRestartsClockWithoutEffectiveScaleCallback() {
    val lifecycleOwner = TestLifecycleOwner()
    val scaleSource = AndroidWearAnimatorScaleSource(RuntimeEnvironment.getApplication(), lifecycleOwner)
    val motionScale = FakeMotionDurationScale(initialScale = 0f)
    setRobolectricAnimatorDurationScale(0f)
    try {
      assertFalse(ValueAnimator.areAnimatorsEnabled())
      AvatarFixture(scaleSource, motionScale).use { avatar ->
        assertFalse(avatar.hasAnimationFrames)
        val initial = avatar.pixels()
        motionScale.scaleFactor = 1f
        avatar.settle()
        assertTrue(avatar.hasAnimationFrames)
        avatar.frame(1_016_000_000L)
        assertFalse(initial.contentEquals(avatar.pixels()))
      }
    } finally {
      setRobolectricAnimatorDurationScale(1f)
    }
  }

  @Test
  @Config(sdk = [33])
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun zeroSystemScaleColdStartUsesTheComposeMotionScaleWithoutCrashing() {
    val context = RuntimeEnvironment.getApplication()
    val originalScale =
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    setRobolectricAnimatorDurationScale(0f)
    try {
      AvatarFixture(FakeWearAnimatorScaleSource(initialScale = 1f)).use { avatar ->
        assertFalse(avatar.hasAnimationFrames)
        val initial = avatar.pixels()
        avatar.recompose()
        assertFalse(avatar.hasAnimationFrames)
        assertTrue(initial.contentEquals(avatar.pixels()))
      }
    } finally {
      Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
      setRobolectricAnimatorDurationScale(originalScale)
    }
  }

  @Test
  @Config(sdk = [32])
  fun api31And32RefreshEffectiveScaleOnLifecycleAndPowerChangesAndCleanUp() {
    val context = RuntimeEnvironment.getApplication()
    val lifecycleOwner = TestLifecycleOwner()
    val source = AndroidWearAnimatorScaleSource(context, lifecycleOwner)
    val observedScales = mutableListOf<Float>()
    val subscription = source.subscribe(observedScales::add)
    val countAfterSubscribe = observedScales.size

    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    assertTrue(observedScales.size > countAfterSubscribe)
    val countAfterStart = observedScales.size

    context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    idleMainLooper()
    assertTrue(observedScales.size > countAfterStart)

    subscription.dispose()
    val countAfterDispose = observedScales.size
    lifecycleOwner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    idleMainLooper()
    assertEquals(countAfterDispose, observedScales.size)
  }

  @Test
  fun zeroMotionKeepsEveryVoiceStateStaticAndVisuallyDistinct() {
    val poses =
      RealtimeVoiceButtonState.entries.map { state ->
        avatarPoseAt(
          state = state,
          animationSeconds = 0f,
          mouthLevel = 0f,
        )
      }

    assertEquals(RealtimeVoiceButtonState.entries.size, poses.distinct().size)
    assertEquals(0f, poses.first().floatOffset, 0f)
    assertTrue(poses.last().antennaDroop > 0f)
  }

  @Test
  fun disabledAnimationsSuppressClockAndAudioMotionInputs() {
    val inputs =
      avatarMotionInputs(
        animationsEnabled = false,
        animationSeconds = 12.5f,
        mouthLevel = 1f,
      )

    assertEquals(WearAvatarMotionInputs(animationSeconds = 0f, mouthLevel = 0f), inputs)
  }

  @Test
  fun enabledAnimationsPreserveClockAndBoundAudioMotionInput() {
    val inputs =
      avatarMotionInputs(
        animationsEnabled = true,
        animationSeconds = 12.5f,
        mouthLevel = 1.5f,
      )

    assertEquals(WearAvatarMotionInputs(animationSeconds = 12.5f, mouthLevel = 1f), inputs)
  }

  private fun pcm16LeMouthLevels(
    pcm: ByteArray,
  ): List<Float> =
    Pcm16MouthLevelAccumulator().run {
      append(pcm) + flush()
    }

  private fun samplesForFrames(frameCount: Int): Int = WEAR_REALTIME_SAMPLE_RATE_HZ * MOUTH_FRAME_MILLIS / 1_000 * frameCount

  private fun pcm16Le(
    sampleCount: Int,
    sample: Int,
  ): ByteArray =
    ByteArray(sampleCount * 2).also { bytes ->
      repeat(sampleCount) { index ->
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[(index * 2) + 1] = ((sample shr 8) and 0xff).toByte()
      }
    }

  private fun realtimeTalkClient(): WearRealtimeTalkClient {
    val requester =
      object : WearRpcRequester {
        override suspend fun request(
          method: WearRpcMethod,
          params: JsonObject,
          expectedNodeId: String?,
          requirePreferredNode: Boolean,
        ): WearRpcResult = error("Unexpected request: $method $params $expectedNodeId $requirePreferredNode")
      }
    return WearRealtimeTalkClient(RuntimeEnvironment.getApplication(), WearGatewayRepository(requester))
  }

  private fun realtimeAttempt(generation: Long): WearRealtimeTalkClient.ActiveAttempt =
    WearRealtimeTalkClient.ActiveAttempt(
      nodeId = "watch-a",
      attemptId = "attempt-$generation",
      resources =
        WearRealtimeTalkClient.ChannelResources(
          channel = FakeRealtimeChannel("watch-a", "channel-$generation"),
          input = ByteArrayInputStream(byteArrayOf()),
          output = ByteArrayOutputStream(),
        ),
    )

  private fun awaitPlaybackTeardown(client: WearRealtimeTalkClient) {
    ShadowSystemClock.advanceBy(Duration.ofSeconds(1L))
    val deadlineNanos = System.nanoTime() + 2_000_000_000L
    while (client.isPlaying.value && System.nanoTime() < deadlineNanos) Thread.sleep(10L)
    assertEquals(false, client.isPlaying.value)
  }

  private fun idleMainLooper(duration: Duration = Duration.ZERO) {
    shadowOf(Looper.getMainLooper()).idleFor(duration)
  }

  private fun setRobolectricAnimatorDurationScale(scale: Float) {
    ShadowValueAnimator::class.java
      .getDeclaredMethod("setDurationScale", java.lang.Float.TYPE)
      .apply { isAccessible = true }
      .invoke(null, scale)
  }

  private fun WearRealtimeTalkClient.invokePrivate(
    name: String,
    vararg args: Any,
  ) {
    javaClass.declaredMethods
      .single { method ->
        method.name == name &&
          method.parameterTypes.size == args.size &&
          method.parameterTypes.zip(args).all { (type, arg) ->
            type.isAssignableFrom(arg.javaClass) ||
              (type == Boolean::class.javaPrimitiveType && arg is Boolean)
          }
      }.apply { isAccessible = true }
      .invoke(this, *args)
  }

  private companion object {
    const val WEAR_REALTIME_SAMPLE_RATE_HZ = 24_000
  }

  private class FakeMotionDurationScale(
    initialScale: Float,
  ) : MotionDurationScale {
    override var scaleFactor by mutableFloatStateOf(initialScale)
  }

  private class FakeWearAnimatorScaleSource(
    initialScale: Float,
  ) : WearAnimatorScaleSource {
    private var scale = initialScale
    private var listener: ((Float) -> Unit)? = null
    var subscriptionCount = 0
      private set
    var disposeCount = 0
      private set
    val activeSubscriptionCount: Int
      get() = if (listener == null) 0 else 1

    override fun currentScale(): Float = scale

    override fun subscribe(onScaleChanged: (Float) -> Unit): WearAnimatorScaleSubscription {
      subscriptionCount += 1
      listener = onScaleChanged
      return WearAnimatorScaleSubscription {
        if (listener === onScaleChanged) listener = null
        disposeCount += 1
      }
    }

    fun emit(newScale: Float) {
      scale = newScale
      listener?.invoke(newScale)
    }
  }

  private inner class AvatarFixture(
    scaleSource: WearAnimatorScaleSource,
    motionScale: MotionDurationScale? = null,
  ) : AutoCloseable {
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    private val driverClock = BroadcastFrameClock()
    private val view = ComposeView(controller.get())
    private val recomposer =
      view.createLifecycleAwareWindowRecomposer(
        coroutineContext = driverClock + (motionScale ?: EmptyCoroutineContext),
        lifecycle = controller.get().lifecycle,
      )
    private val effectClock = checkNotNull(recomposer.effectCoroutineContext[MonotonicFrameClock]) as BroadcastFrameClock
    private var revision by mutableIntStateOf(0)
    private var frameTime = 999_999_999L

    val hasAnimationFrames: Boolean
      get() = effectClock.hasAwaiters

    init {
      view.setParentCompositionContext(recomposer)
      controller.get().setContentView(view)
      view.setContent {
        WearTalkAvatar(
          state = RealtimeVoiceButtonState.SPEAKING,
          mouthLevel = 1f,
          syntheticSpeech = false,
          accent = Color.Cyan,
          danger = Color.Red,
          modifier = Modifier.size(200.dp).testTag("avatar-$revision"),
          animatorScaleSource = scaleSource,
        )
      }
      settle()
    }

    fun settle() {
      idleMainLooper()
      frame(frameTime + 1)
      val size = View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY)
      view.measure(size, size)
      view.layout(0, 0, 200, 200)
    }

    fun frame(timeNanos: Long) {
      check(timeNanos > frameTime)
      driverClock.sendFrame(timeNanos)
      idleMainLooper()
      // Render the animation invalidation on the next strictly increasing frame.
      frameTime = timeNanos + 1
      driverClock.sendFrame(frameTime)
      idleMainLooper()
    }

    fun recompose() {
      revision += 1
      settle()
    }

    fun pixels(): IntArray {
      val bitmap = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(bitmap))
      return IntArray(200 * 200).also { pixels ->
        bitmap.getPixels(pixels, 0, 200, 0, 0, 200, 200)
        bitmap.recycle()
        assertTrue("avatar must render nonblank pixels", pixels.any { it != 0 })
      }
    }

    override fun close() {
      view.disposeComposition()
      recomposer.cancel()
      controller.pause().stop().destroy()
      idleMainLooper()
    }
  }

  private class TestLifecycleOwner : LifecycleOwner {
    val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle = registry
  }
}

private data class FakeRealtimeChannel(
  private val nodeId: String,
  private val label: String,
) : ChannelClient.Channel {
  override fun getNodeId(): String = nodeId

  override fun getPath(): String = WearProtocol.realtimeAudioChannelPath("attempt-$label")

  override fun describeContents(): Int = 0

  override fun writeToParcel(
    dest: Parcel,
    flags: Int,
  ) {
    dest.writeString(label)
  }
}
