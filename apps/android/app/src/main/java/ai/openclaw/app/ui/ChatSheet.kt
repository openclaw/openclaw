package ai.openclaw.app.ui

import androidx.compose.runtime.Composable
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatSheetContent
import androidx.compose.ui.unit.Dp

@Composable
fun ChatSheet(viewModel: MainViewModel, bottomPadding: Dp) {
  ChatSheetContent(viewModel = viewModel, bottomPadding = bottomPadding)
}
