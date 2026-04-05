package ai.mullusi.app.ui

import androidx.compose.runtime.Composable
import ai.mullusi.app.MainViewModel
import ai.mullusi.app.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
