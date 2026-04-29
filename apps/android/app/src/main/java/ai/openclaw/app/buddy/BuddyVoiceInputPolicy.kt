package ai.openclaw.app.buddy

import ai.openclaw.app.VoiceCaptureMode

object BuddyVoiceInputPolicy {
  fun nextMode(current: VoiceCaptureMode): VoiceCaptureMode =
    when (current) {
      VoiceCaptureMode.Off -> VoiceCaptureMode.TalkMode
      VoiceCaptureMode.ManualMic,
      VoiceCaptureMode.TalkMode,
      -> VoiceCaptureMode.Off
    }

  fun shouldRequestPermission(
    current: VoiceCaptureMode,
    hasRecordAudioPermission: Boolean,
  ): Boolean = current == VoiceCaptureMode.Off && !hasRecordAudioPermission
}
