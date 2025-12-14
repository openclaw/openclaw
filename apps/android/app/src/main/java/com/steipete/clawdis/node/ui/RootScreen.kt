package com.steipete.clawdis.node.ui

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.steipete.clawdis.node.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RootScreen(viewModel: MainViewModel) {
  var sheet by remember { mutableStateOf<Sheet?>(null) }
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val safeButtonInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

  Box(modifier = Modifier.fillMaxSize()) {
    CanvasView(viewModel = viewModel, modifier = Modifier.fillMaxSize())
  }

  // Keep the overlay buttons above the WebView canvas (AndroidView), otherwise they may not receive touches.
  Popup(alignment = Alignment.TopCenter, properties = PopupProperties(focusable = false)) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .windowInsetsPadding(safeButtonInsets)
          .padding(12.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Button(onClick = { sheet = Sheet.Chat }) { Text("Chat") }
      Button(onClick = { sheet = Sheet.Settings }) { Text("Settings") }
    }
  }

  if (sheet != null) {
    ModalBottomSheet(
      onDismissRequest = { sheet = null },
      sheetState = sheetState,
    ) {
      when (sheet) {
        Sheet.Chat -> ChatSheet(viewModel = viewModel)
        Sheet.Settings -> SettingsSheet(viewModel = viewModel)
      }
    }
  }
}

private enum class Sheet {
  Chat,
  Settings,
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CanvasView(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  AndroidView(
    modifier = modifier,
    factory = {
      WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        webViewClient = WebViewClient()
        setBackgroundColor(0x00000000)
        viewModel.canvas.attach(this)
      }
    },
  )
}
