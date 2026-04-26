package ai.openclaw.app.ui.buddy

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import ai.openclaw.app.buddy.BuddyAction

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BuddyTouchLayer(onAction: (BuddyAction) -> Unit, modifier: Modifier = Modifier) {
  BoxWithConstraints(
    modifier =
      modifier
        .fillMaxSize()
        .combinedClickable(
          interactionSource = remember { MutableInteractionSource() },
          indication = null,
          onClick = { onAction(BuddyAction.Play) },
          onLongClick = { onAction(BuddyAction.OpenSettings) },
        ),
  ) {
    TouchRegion(
      modifier =
        Modifier
          .offset(x = maxWidth * 0.16f, y = maxHeight * 0.18f)
          .size(width = maxWidth * 0.26f, height = maxHeight * 0.40f),
      onClick = { onAction(BuddyAction.StartVisionScan) },
    )
    TouchRegion(
      modifier =
        Modifier
          .offset(x = maxWidth * 0.58f, y = maxHeight * 0.18f)
          .size(width = maxWidth * 0.26f, height = maxHeight * 0.40f),
      onClick = { onAction(BuddyAction.StartVisionScan) },
    )
    TouchRegion(
      modifier =
        Modifier
          .offset(x = maxWidth * 0.38f, y = maxHeight * 0.50f)
          .size(width = maxWidth * 0.24f, height = maxHeight * 0.24f),
      onClick = { onAction(BuddyAction.RepeatLastResponse) },
    )
  }
}

@Composable
private fun TouchRegion(modifier: Modifier, onClick: () -> Unit) {
  Box(
    modifier =
      modifier.clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClick = onClick,
      ),
  )
}
