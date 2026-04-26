package ai.openclaw.app.ui.buddy

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ai.openclaw.app.MainViewModel

@Composable
fun BuddyModeScreen(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val snapshot by viewModel.buddySnapshot.collectAsState()

  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color(0xFF030507)),
  ) {
    NemoFace(state = snapshot.state, modifier = Modifier.fillMaxSize())
    BuddyOverlay(
      snapshot = snapshot,
      modifier =
        Modifier
          .align(Alignment.BottomCenter)
          .padding(bottom = 28.dp, start = 24.dp, end = 24.dp),
    )
  }
}
