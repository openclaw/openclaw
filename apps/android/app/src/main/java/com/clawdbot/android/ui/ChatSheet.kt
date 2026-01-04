package com.clawdbot.android.ui

import androidx.compose.runtime.Composable
import com.clawdbot.android.MainViewModel
import com.clawdbot.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
