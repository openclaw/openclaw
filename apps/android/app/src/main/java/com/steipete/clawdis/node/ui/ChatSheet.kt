package com.steipete.clawdis.node.ui

import androidx.compose.runtime.Composable
import com.steipete.clawdis.node.MainViewModel
import com.steipete.clawdis.node.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
