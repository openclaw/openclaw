package ai.openclaw.app.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileText
import androidx.compose.ui.graphics.vector.ImageVector

private const val CLIPBOARD_LABEL = "OpenClaw Message"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatContextMenu(
  isVisible: Boolean,
  onDismiss: () -> Unit,
  message: ChatMessage,
  onSelectCopy: (String) -> Unit,
  onReply: (ChatMessage) -> Unit,
) {
  if (!isVisible) return

  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val context = LocalContext.current
  val fullText = message.content.filter { it.type == "text" }.joinToString("\n") { it.text ?: "" }

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    dragHandle = { BottomSheetDefaults.DragHandle() },
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(bottom = 16.dp)
    ) {
      ContextMenuItem(
        icon = Icons.AutoMirrored.Filled.Reply,
        label = "Reply",
        onClick = {
          onReply(message)
          onDismiss()
        }
      )
      ContextMenuItem(
        icon = Icons.Default.ContentCopy,
        label = "Copy",
        onClick = {
          copyToClipboard(context, fullText)
          onDismiss()
        }
      )
      ContextMenuItem(
        icon = Icons.Default.SelectAll,
        label = "Select Copy",
        onClick = {
          onSelectCopy(fullText)
          onDismiss()
        }
      )
      ContextMenuItem(
        icon = Icons.Default.Share,
        label = "Share",
        onClick = {
          shareText(context, fullText)
          onDismiss()
        }
      )
    }
  }
}

@Composable
private fun ContextMenuItem(
  icon: ImageVector,
  label: String,
  onClick: () -> Unit
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 24.dp, vertical = 16.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Icon(
      imageVector = icon,
      contentDescription = null,
      tint = mobileText,
      modifier = Modifier.size(24.dp)
    )
    Spacer(modifier = Modifier.width(20.dp))
    Text(
      text = label,
      style = mobileCallout.copy(fontWeight = FontWeight.Medium, fontSize = 16.sp),
      color = mobileText
    )
  }
}

private fun copyToClipboard(context: Context, text: String) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  val clip = ClipData.newPlainText(CLIPBOARD_LABEL, text)
  clipboard.setPrimaryClip(clip)
}

private fun shareText(context: Context, text: String) {
  val sendIntent = Intent().apply {
    action = Intent.ACTION_SEND
    putExtra(Intent.EXTRA_TEXT, text)
    type = "text/plain"
  }
  val shareIntent = Intent.createChooser(sendIntent, null)
  context.startActivity(shareIntent)
}
