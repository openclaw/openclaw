package ai.openclaw.app.ui.buddy

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.openclaw.app.buddy.BuddySnapshot
import ai.openclaw.app.buddy.BuddyState
import ai.openclaw.app.ui.mobileCallout

@Composable
fun BuddyOverlay(
  snapshot: BuddySnapshot,
  modifier: Modifier = Modifier,
  showConfirmationActions: Boolean = false,
  onConfirm: () -> Unit = {},
  onCancel: () -> Unit = {},
) {
  val text = snapshot.prompt?.text ?: snapshot.agent.message ?: return
  val accent =
    when (snapshot.state) {
      BuddyState.PermissionRequired, BuddyState.Disconnected -> Color(0xFFFF8F8F)
      BuddyState.NeedsConfirmation -> Color(0xFFFFE38A)
      BuddyState.VisionScanning -> Color(0xFF9FD8FF)
      BuddyState.Recording, BuddyState.WakeDetected -> Color(0xFF9DFFD9)
      else -> Color(0xFFE9FFFF)
    }
  Box(
    modifier =
      modifier
        .clip(RoundedCornerShape(8.dp))
        .background(Color(0xCC0C1115))
        .border(BorderStroke(1.dp, accent.copy(alpha = 0.55f)), RoundedCornerShape(8.dp))
        .padding(horizontal = 18.dp, vertical = 10.dp),
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = text,
        color = Color(0xFFF4FBFF),
        style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
        maxLines = 1,
      )
      if (showConfirmationActions) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          TextButton(
            onClick = onCancel,
            colors = ButtonDefaults.textButtonColors(contentColor = Color(0xFFD7E2EA)),
          ) {
            Text("取消")
          }
          Button(
            onClick = onConfirm,
            colors =
              ButtonDefaults.buttonColors(
                containerColor = accent,
                contentColor = Color(0xFF061016),
              ),
          ) {
            Text("确认")
          }
        }
      }
    }
  }
}
