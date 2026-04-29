package ai.openclaw.app.buddy

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

data class BuddyFaceMotion(
  val eyeOpen: Float,
  val pupilShift: Float,
  val verticalBob: Float,
) {
  companion object {
    fun forState(state: BuddyState, elapsedMillis: Long): BuddyFaceMotion {
      val loopMillis = positiveModulo(elapsedMillis, 4_800L)
      val idleBlink = blinkOpenAmount(loopMillis)
      val idleLook = wave(elapsedMillis, periodMillis = 3_600L) * 0.045f
      val idleBob = wave(elapsedMillis, periodMillis = 2_800L) * 0.014f

      return when (state) {
        BuddyState.Disconnected, BuddyState.PowerSaving ->
          BuddyFaceMotion(
            eyeOpen = 0.18f,
            pupilShift = 0f,
            verticalBob = wave(elapsedMillis, periodMillis = 3_600L) * 0.006f,
          )
        BuddyState.Thinking, BuddyState.Executing ->
          BuddyFaceMotion(
            eyeOpen = 0.72f,
            pupilShift = wave(elapsedMillis, periodMillis = 1_900L) * 0.035f,
            verticalBob = wave(elapsedMillis, periodMillis = 2_400L) * 0.008f,
          )
        BuddyState.VisionScanning ->
          BuddyFaceMotion(
            eyeOpen = 1f,
            pupilShift = 0.09f + wave(elapsedMillis, periodMillis = 1_400L) * 0.025f,
            verticalBob = wave(elapsedMillis, periodMillis = 2_200L) * 0.01f,
          )
        BuddyState.Speaking ->
          BuddyFaceMotion(
            eyeOpen = 0.92f,
            pupilShift = wave(elapsedMillis, periodMillis = 2_100L) * 0.035f,
            verticalBob = wave(elapsedMillis, periodMillis = 1_600L) * 0.012f,
          )
        else ->
          BuddyFaceMotion(
            eyeOpen = idleBlink,
            pupilShift = idleLook,
            verticalBob = idleBob,
          )
      }
    }

    private fun blinkOpenAmount(loopMillis: Long): Float {
      val blinkCenter = 4_050L
      val blinkHalfWidth = 130L
      val distance = abs(loopMillis - blinkCenter)
      if (distance >= blinkHalfWidth) return 1f
      return (0.08f + (distance.toFloat() / blinkHalfWidth.toFloat()) * 0.92f).coerceIn(0.08f, 1f)
    }

    private fun wave(elapsedMillis: Long, periodMillis: Long): Float {
      val radians = (positiveModulo(elapsedMillis, periodMillis).toDouble() / periodMillis.toDouble()) * PI * 2.0
      return sin(radians).toFloat()
    }

    private fun positiveModulo(value: Long, modulo: Long): Long = ((value % modulo) + modulo) % modulo
  }
}
