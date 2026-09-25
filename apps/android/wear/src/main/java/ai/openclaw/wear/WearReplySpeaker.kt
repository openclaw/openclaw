package ai.openclaw.wear

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.UUID

internal class WearReplySpeaker(
  context: Context,
) {
  private val lock = Any()
  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking.asStateFlow()
  private val _failed = MutableStateFlow(false)
  val failed: StateFlow<Boolean> = _failed.asStateFlow()
  private val audioFocus = WearAudioFocusController(context, ::stop)

  private var engine: TextToSpeech? = null
  private var ready = false
  private var initializationFailed = false
  private var closed = false
  private var pendingText: String? = null
  private var activeUtterance: String? = null

  init {
    val created =
      TextToSpeech(context.applicationContext) { status ->
        synchronized(lock) {
          if (!closed) {
            ready = status == TextToSpeech.SUCCESS
            initializationFailed = !ready
            if (ready) {
              configureEngine()
            } else if (pendingText != null) {
              fail()
            }
          }
        }
      }
    synchronized(lock) {
      engine = created
      created.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String) {
            synchronized(lock) {
              if (activeUtterance == utteranceId) _isSpeaking.value = true
            }
          }

          override fun onDone(utteranceId: String) = finish(utteranceId, failed = false)

          @Suppress("OVERRIDE_DEPRECATION")
          override fun onError(utteranceId: String) = finish(utteranceId, failed = true)

          override fun onError(
            utteranceId: String,
            errorCode: Int,
          ) = finish(utteranceId, failed = true)

          override fun onStop(
            utteranceId: String,
            interrupted: Boolean,
          ) = finish(utteranceId, failed = false)
        },
      )
      if (ready) configureEngine()
    }
  }

  private fun configureEngine() {
    val currentEngine = engine ?: return
    currentEngine.language = Locale.getDefault()
    currentEngine.setAudioAttributes(wearSpeechAudioAttributes)
    pendingText?.let(::speak)
  }

  fun speak(text: String) {
    val normalized = text.trim().takeIf(String::isNotEmpty) ?: return
    synchronized(lock) {
      if (closed) return
      stop()
      if (initializationFailed) {
        fail()
        return
      }
      if (!ready) {
        pendingText = normalized
        return
      }
      if (!audioFocus.request()) {
        fail()
        return
      }
      val utterance = UUID.randomUUID().toString()
      activeUtterance = utterance
      val result = engine?.speak(normalized, TextToSpeech.QUEUE_FLUSH, Bundle(), utterance)
      if (result != TextToSpeech.SUCCESS) finish(utterance, failed = true)
    }
  }

  private fun finish(
    utteranceId: String,
    failed: Boolean,
  ) {
    synchronized(lock) {
      // A flushed/stopped request cannot clear a replacement request's focus or error.
      if (activeUtterance != utteranceId) return
      activeUtterance = null
      _isSpeaking.value = false
      _failed.value = failed
      audioFocus.abandon()
    }
  }

  private fun fail() {
    pendingText = null
    activeUtterance = null
    _isSpeaking.value = false
    _failed.value = true
    audioFocus.abandon()
  }

  fun stop() {
    synchronized(lock) {
      pendingText = null
      activeUtterance = null
      engine?.stop()
      _isSpeaking.value = false
      _failed.value = false
      audioFocus.abandon()
    }
  }

  fun shutdown() {
    synchronized(lock) {
      closed = true
      stop()
      engine?.shutdown()
      engine = null
      ready = false
    }
  }
}
