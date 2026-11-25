package ai.openclaw.app.voice

import kotlin.math.log10
import kotlin.math.max

/**
 * Kotlin port of OpenClawKit's `TalkAudioLevel`: the shared 0..1 UI level scale
 * (dB full scale over a 50 dB window) used by every talk waveform surface, so
 * Android levels read identically to iOS/macOS. Change the Swift original in
 * `TalkPlaybackLevelMeters.swift` first; every constant mirrors it.
 */
internal object TalkAudioLevel {
  fun normalized(rms: Double): Float = normalizedDecibels(20.0 * log10(max(rms, 1e-7)))

  fun normalizedDecibels(decibels: Double): Float = ((decibels + 50.0) / 50.0).coerceIn(0.0, 1.0).toFloat()

  /** iOS-parity level smoothing (new = old*0.8 + raw*0.2) for waveform meters. */
  fun smoothed(
    previous: Float,
    raw: Float,
  ): Float = previous * 0.8f + raw * 0.2f
}
