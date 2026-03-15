package ai.openclaw.app.assistant

import android.service.voice.VoiceInteractionService

/**
 * Registers OpenClaw as an Android System Assistant (digital assistant).
 *
 * Users can select this via: Settings → Apps → Default apps → Digital assistant app.
 * Once set, pressing and holding the home button (or the assistant gesture on Android 16+)
 * will trigger [AssistantSession.onShow], which launches MainActivity in voice mode.
 */
class AssistantService : VoiceInteractionService() {
  override fun onReady() {
    super.onReady()
  }
}
