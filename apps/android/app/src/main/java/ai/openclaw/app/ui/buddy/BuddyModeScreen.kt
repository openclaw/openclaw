package ai.openclaw.app.ui.buddy

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import ai.openclaw.app.MainViewModel

@Composable
fun BuddyModeScreen(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val snapshot by viewModel.buddySnapshot.collectAsState()
  val cameraConfirmation by viewModel.buddyCameraConfirmation.collectAsState()
  val activity = LocalContext.current.findActivity()

  DisposableEffect(activity) {
    if (activity == null) {
      onDispose {}
    } else {
      val previousOrientation = activity.requestedOrientation
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      onDispose {
        activity.requestedOrientation = previousOrientation
      }
    }
  }

  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color(0xFF030507)),
  ) {
    NemoFace(state = snapshot.state, modifier = Modifier.fillMaxSize())
    BuddyTouchLayer(
      onAction = viewModel::handleBuddyAction,
      modifier = Modifier.fillMaxSize(),
    )
    BuddyOverlay(
      snapshot = snapshot,
      showConfirmationActions = cameraConfirmation != null,
      onConfirm = { viewModel.respondBuddyCameraConfirmation(true) },
      onCancel = { viewModel.respondBuddyCameraConfirmation(false) },
      modifier =
        Modifier
          .align(Alignment.BottomCenter)
          .padding(bottom = 28.dp, start = 24.dp, end = 24.dp),
    )
  }
}

private tailrec fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }
