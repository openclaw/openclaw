package ai.openclaw.app.ui

import androidx.compose.runtime.Composable
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(
  viewModel: MainViewModel,
  hideCronSessions: Boolean = true,
  onHideCronSessionsChange: (Boolean) -> Unit = {},
) {
  ChatSheetContent(
    viewModel = viewModel,
    hideCronSessions = hideCronSessions,
    onHideCronSessionsChange = onHideCronSessionsChange,
  )
}
