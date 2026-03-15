package ai.openclaw.app.assistant

import android.os.Bundle
import android.speech.RecognitionService

/**
 * Stub RecognitionService required by VoiceInteractionService to be considered
 * "qualified" by the Android system. OpenClaw handles speech capture internally.
 */
class AssistantRecognitionService : RecognitionService() {
  override fun onStartListening(recognizerIntent: android.content.Intent, listener: Callback) {}
  override fun onCancel(listener: Callback) {}
  override fun onStopListening(listener: Callback) {}
}
