package ai.openclaw.app.voice

import android.os.Bundle
import android.speech.RecognitionListener

/** Leaves unused telemetry callbacks empty while requiring each recognition lifecycle handler. */
internal abstract class SpeechRecognitionListenerAdapter : RecognitionListener {
  override fun onRmsChanged(rmsdB: Float) = Unit

  override fun onBufferReceived(buffer: ByteArray?) = Unit

  override fun onEvent(
    eventType: Int,
    params: Bundle?,
  ) = Unit
}
