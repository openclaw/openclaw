package ai.smartagentneo.android.ui

import androidx.compose.runtime.Composable
import ai.smartagentneo.android.MainViewModel
import ai.smartagentneo.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
