package com.clawdis.android.ui

import androidx.compose.runtime.Composable
import com.clawdis.android.MainViewModel
import com.clawdis.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
