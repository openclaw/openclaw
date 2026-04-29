package ai.openclaw.app.ui.buddy

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import ai.openclaw.app.buddy.BuddyState
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.rememberLottieComposition

@Composable
fun NemoFace(state: BuddyState, modifier: Modifier = Modifier) {
  BoxWithConstraints(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color(0xFF030507)),
  ) {
    val isPortrait = maxHeight > maxWidth
    val assetName = if (isPortrait) "nemo/nemo_portrait.json" else "nemo/nemo_landscape.json"
    val composition by rememberLottieComposition(LottieCompositionSpec.Asset(assetName))

    LottieAnimation(
      composition = composition,
      iterations = LottieConstants.IterateForever,
      speed = animationSpeedFor(state),
      modifier = Modifier.fillMaxSize(),
    )
  }
}

private fun animationSpeedFor(state: BuddyState): Float =
  when (state) {
    BuddyState.Thinking, BuddyState.Executing, BuddyState.VisionScanning -> 1.25f
    BuddyState.Speaking -> 1.15f
    BuddyState.Disconnected, BuddyState.PowerSaving -> 0.55f
    else -> 1f
  }
