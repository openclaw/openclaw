package ai.openclaw.app.voice

/** An append unanswered this long means the relay stopped making progress, as in browser and Apple Talk. */
internal const val REALTIME_AUDIO_APPEND_LIVENESS_TIMEOUT_MS = 30_000L

/**
 * Bounds PCM16 microphone audio in flight to the Gateway by audio time (3 s), like browser and
 * Apple relay Talk. A slow relay costs the frames past the budget and one repeat-the-last-part
 * notice, not the call. One budget serves one capture; a new capture starts a new budget.
 */
internal class RealtimeInputAudioBudget(
  sampleRateHz: Int,
  private val onNotice: (Notice) -> Unit,
) {
  enum class Notice { FellBehind, Recovered }

  private val maxPendingBytes = sampleRateHz * 2 * MAX_PENDING_INPUT_AUDIO_MS / 1000
  private var pendingBytes = 0
  private var behind = false

  /** False drops the frame; the first drop of a backlog announces it. */
  fun admit(bytes: Int): Boolean {
    synchronized(this) {
      if (pendingBytes + bytes <= maxPendingBytes) {
        pendingBytes += bytes
        return true
      }
      if (behind) return false
      behind = true
    }
    onNotice(Notice.FellBehind)
    return false
  }

  /** Releases an admitted frame; the first acknowledgment after a backlog announces recovery. */
  fun settle(
    bytes: Int,
    acknowledged: Boolean,
  ) {
    synchronized(this) {
      pendingBytes -= bytes
      if (!acknowledged || !behind) return
      behind = false
    }
    onNotice(Notice.Recovered)
  }

  private companion object {
    const val MAX_PENDING_INPUT_AUDIO_MS = 3_000
  }
}
