package ai.openclaw.app.buddy

object BuddyStateDisplayPolicy {
  fun minVisibleMs(state: BuddyState): Long =
    when (state) {
      BuddyState.Thinking -> 1_200L
      BuddyState.Executing -> 1_600L
      BuddyState.Recording,
      BuddyState.VisionScanning,
      BuddyState.Speaking,
      BuddyState.Error,
      -> 900L
      else -> 0L
    }

  fun shouldHoldBeforeLeaving(current: BuddyState, next: BuddyState): Boolean {
    if (minVisibleMs(current) <= 0L) return false
    return next == BuddyState.Idle || next == BuddyState.Listening
  }
}
