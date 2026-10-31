package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Looper
import kotlinx.coroutines.CancellationException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RealtimeCommunicationAudioTest {
  private val manager = RuntimeEnvironment.getApplication().getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val sessions = mutableListOf<RealtimeCommunicationAudio>()

  private fun open() = RealtimeCommunicationAudio.open(manager).also { sessions += it }

  @After
  fun cleanup() {
    sessions.forEach { it.close() }
    shadowOf(manager).lockMode(false)
    manager.mode = AudioManager.MODE_NORMAL
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun communicationEligibilityFollowsFocusAndModeCallbacks() {
    val session = open()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(session.eligible)
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    assertFalse(session.eligible)
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertTrue(session.eligible)
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(session.eligible)
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(session.eligible)
  }

  @Test
  fun refusedFocusDoesNotChangeTheDeviceMode() {
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    assertThrows(IllegalStateException::class.java) { open() }
    assertEquals(AudioManager.MODE_IN_CALL, manager.mode)
    assertEquals(shadowOf(manager).lastAudioFocusRequest.audioFocusRequest, shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  fun modeRefusalDoesNotGrantDuplex() {
    shadowOf(manager).lockMode(true)
    assertFalse(open().eligible)
  }

  @Test
  fun staleCloseAndFocusCallbacksCannotRevokeAReplacement() {
    val old = open()
    val oldListener = shadowOf(manager).lastAudioFocusRequest.listener
    val replacement = open()
    old.close()
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(old.eligible)
    assertTrue(replacement.eligible)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
  }

  @Test
  fun closeWithdrawsOwnRequestInsteadOfReassertingThePreviousGlobalMode() {
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    val session = open()
    val request = shadowOf(manager).lastAudioFocusRequest
    session.close()
    request.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertFalse(session.eligible)
    assertEquals(AudioManager.MODE_NORMAL, manager.mode)
    assertEquals(request.audioFocusRequest, shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  fun cancelledOpenerCannotAcquireOverTheReplacement() {
    val replacement = open()
    val request = shadowOf(manager).lastAudioFocusRequest
    assertThrows(CancellationException::class.java) {
      RealtimeCommunicationAudio.open(manager, isCurrent = { false })
    }
    assertTrue(replacement.eligible)
    assertEquals(request, shadowOf(manager).lastAudioFocusRequest)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
  }

  @Test
  fun focusLossReportsToTheCurrentCaptureOwnerOnly() {
    var current = true
    var losses = 0
    val session = RealtimeCommunicationAudio.open(manager, { current }, { losses++ }).also { sessions += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    assertFalse(session.eligible)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    current = false
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
  }

  @Test
  fun transientFocusLossOutsideACallInterruptsWithoutEndingTalk() {
    var losses = 0
    val session = RealtimeCommunicationAudio.open(manager, onFocusLost = { losses++ }).also { sessions += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    for (change in listOf(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)) {
      listener.onAudioFocusChange(change)
      shadowOf(Looper.getMainLooper()).idle()
      assertTrue(session.interrupted)
      assertFalse(session.eligible)
      assertEquals(0, losses)
      listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
      assertFalse(session.interrupted)
      assertTrue(session.eligible)
    }
  }

  @Test
  fun callModeBeforeTheFocusLossAlsoEndsTalk() {
    var losses = 0
    RealtimeCommunicationAudio.open(manager, onFocusLost = { losses++ }).also { sessions += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(0, losses)
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
  }

  @Test
  fun transientFocusLossToAPhoneCallEndsTalkOnce() {
    var losses = 0
    RealtimeCommunicationAudio.open(manager, onFocusLost = { losses++ }).also { sessions += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    manager.mode = AudioManager.MODE_RINGTONE
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
    manager.mode = AudioManager.MODE_IN_CALL
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
  }

  @Test
  fun aVoipCallEndsTalkWhenItsRingtoneOrCaptureStarts() {
    for (signal in listOf("ringtone", "capture")) {
      var losses = 0
      val session = RealtimeCommunicationAudio.open(manager, onFocusLost = { losses++ }).also { sessions += it }
      session.ownCaptureSessionId = 7
      val audio = shadowOf(manager)
      // Talk's own capture alone is not a call.
      audio.setActiveRecordingConfigurations(
        listOf(audio.createActiveRecordingConfiguration(7, MediaRecorder.AudioSource.VOICE_COMMUNICATION, "self")),
        true,
      )
      audio.lastAudioFocusRequest.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(0, losses)
      when (signal) {
        "ringtone" -> {
          audio.setActivePlaybackConfigurationsFor(
            listOf(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()),
            true,
          )
        }

        "capture" -> {
          audio.setActiveRecordingConfigurations(
            listOf(audio.createActiveRecordingConfiguration(9, MediaRecorder.AudioSource.VOICE_COMMUNICATION, "voip")),
            true,
          )
        }
      }
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals("VoIP $signal must end Talk once", 1, losses)
      audio.setActivePlaybackConfigurationsFor(emptyList(), false)
      audio.setActiveRecordingConfigurations(emptyList(), false)
    }
  }
}
