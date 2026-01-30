package ai.openclaw.android.ui

import androidx.compose.runtime.Composable
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
