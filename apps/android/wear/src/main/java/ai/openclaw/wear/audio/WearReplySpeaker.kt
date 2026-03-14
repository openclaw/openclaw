package ai.openclaw.wear.audio

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale
import java.util.UUID

class WearReplySpeaker(context: Context) {
  private var engineReady = false
  private var pendingText: String? = null
  private var tts: TextToSpeech? = null

  init {
    tts = TextToSpeech(context.applicationContext) { status ->
    engineReady = status == TextToSpeech.SUCCESS
    if (!engineReady) return@TextToSpeech
    tts?.language = Locale.getDefault()
    pendingText?.let {
      pendingText = null
      speak(it)
    }
  }
  }

  fun speak(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    if (!engineReady) {
      pendingText = trimmed
      return
    }
    tts?.stop()
    tts?.speak(trimmed, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString())
  }

  fun shutdown() {
    tts?.stop()
    tts?.shutdown()
  }
}
