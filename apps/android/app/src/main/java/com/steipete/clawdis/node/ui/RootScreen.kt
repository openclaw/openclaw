package com.steipete.clawdis.node.ui

import android.annotation.SuppressLint
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebSettings
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import androidx.core.content.ContextCompat
import com.steipete.clawdis.node.CameraHudKind
import com.steipete.clawdis.node.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RootScreen(viewModel: MainViewModel) {
  var sheet by remember { mutableStateOf<Sheet?>(null) }
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val safeOverlayInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
  val context = LocalContext.current
  val serverName by viewModel.serverName.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val cameraHud by viewModel.cameraHud.collectAsState()
  val cameraFlashToken by viewModel.cameraFlashToken.collectAsState()
  val activity =
    remember(cameraHud) {
      cameraHud?.let { hud ->
        when (hud.kind) {
          CameraHudKind.Photo ->
            StatusActivity(
              title = hud.message,
              icon = Icons.Default.PhotoCamera,
              contentDescription = "Taking photo",
            )
          CameraHudKind.Recording ->
            StatusActivity(
              title = hud.message,
              icon = Icons.Default.FiberManualRecord,
              contentDescription = "Recording",
              tint = androidx.compose.ui.graphics.Color.Red,
            )
          CameraHudKind.Success ->
            StatusActivity(
              title = hud.message,
              icon = Icons.Default.CheckCircle,
              contentDescription = "Capture finished",
            )
          CameraHudKind.Error ->
            StatusActivity(
              title = hud.message,
              icon = Icons.Default.Error,
              contentDescription = "Capture failed",
              tint = androidx.compose.ui.graphics.Color.Red,
            )
        }
      }
    }

  val bridgeState =
    remember(serverName, statusText) {
      when {
        serverName != null -> BridgeState.Connected
        statusText.contains("connecting", ignoreCase = true) ||
          statusText.contains("reconnecting", ignoreCase = true) -> BridgeState.Connecting
        statusText.contains("error", ignoreCase = true) -> BridgeState.Error
        else -> BridgeState.Disconnected
      }
    }

  val voiceEnabled =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  Box(modifier = Modifier.fillMaxSize()) {
    CanvasView(viewModel = viewModel, modifier = Modifier.fillMaxSize())
  }

  // Camera flash must be in a Popup to render above the WebView.
  Popup(alignment = Alignment.Center, properties = PopupProperties(focusable = false)) {
    CameraFlashOverlay(token = cameraFlashToken, modifier = Modifier.fillMaxSize())
  }

  // Keep the overlay buttons above the WebView canvas (AndroidView), otherwise they may not receive touches.
  Popup(alignment = Alignment.TopStart, properties = PopupProperties(focusable = false)) {
    StatusPill(
      bridge = bridgeState,
      voiceEnabled = voiceEnabled,
      activity = activity,
      onClick = { sheet = Sheet.Settings },
      modifier = Modifier.windowInsetsPadding(safeOverlayInsets).padding(start = 12.dp, top = 12.dp),
    )
  }

  Popup(alignment = Alignment.TopEnd, properties = PopupProperties(focusable = false)) {
    Column(
      modifier = Modifier.windowInsetsPadding(safeOverlayInsets).padding(end = 12.dp, top = 12.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
      horizontalAlignment = Alignment.End,
    ) {
      OverlayIconButton(
        onClick = { sheet = Sheet.Chat },
        icon = { Icon(Icons.Default.ChatBubble, contentDescription = "Chat") },
      )

      OverlayIconButton(
        onClick = { sheet = Sheet.Settings },
        icon = { Icon(Icons.Default.Settings, contentDescription = "Settings") },
      )
    }
  }

  val currentSheet = sheet
  if (currentSheet != null) {
    ModalBottomSheet(
      onDismissRequest = { sheet = null },
      sheetState = sheetState,
    ) {
      when (currentSheet) {
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

@Composable
private fun OverlayIconButton(
  onClick: () -> Unit,
  icon: @Composable () -> Unit,
) {
  FilledTonalIconButton(
    onClick = onClick,
    modifier = Modifier.size(44.dp),
    colors =
      IconButtonDefaults.filledTonalIconButtonColors(
        containerColor = overlayContainerColor(),
        contentColor = overlayIconColor(),
      ),
  ) {
    icon()
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CanvasView(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  val isDebuggable = (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
  AndroidView(
    modifier = modifier,
    factory = {
      WebView(context).apply {
        settings.javaScriptEnabled = true
        // Some embedded web UIs (incl. the "background website") use localStorage/sessionStorage.
        settings.domStorageEnabled = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        isScrollContainer = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        isVerticalScrollBarEnabled = true
        isHorizontalScrollBarEnabled = true
        webViewClient =
          object : WebViewClient() {
            override fun onReceivedError(
              view: WebView,
              request: WebResourceRequest,
              error: WebResourceError,
            ) {
              if (!isDebuggable) return
              if (!request.isForMainFrame) return
              Log.e("ClawdisWebView", "onReceivedError: ${error.errorCode} ${error.description} ${request.url}")
            }

            override fun onReceivedHttpError(
              view: WebView,
              request: WebResourceRequest,
              errorResponse: WebResourceResponse,
            ) {
              if (!isDebuggable) return
              if (!request.isForMainFrame) return
              Log.e(
                "ClawdisWebView",
                "onReceivedHttpError: ${errorResponse.statusCode} ${errorResponse.reasonPhrase} ${request.url}",
              )
            }

            override fun onPageFinished(view: WebView, url: String?) {
              viewModel.canvas.onPageFinished()
            }
          }
        setBackgroundColor(Color.BLACK)
        setLayerType(View.LAYER_TYPE_HARDWARE, null)

        val a2uiBridge =
          CanvasA2UIActionBridge { payload ->
            viewModel.handleCanvasA2UIActionFromWebView(payload)
          }
        addJavascriptInterface(a2uiBridge, CanvasA2UIActionBridge.interfaceName)
        addJavascriptInterface(
          CanvasA2UIActionLegacyBridge(a2uiBridge),
          CanvasA2UIActionLegacyBridge.interfaceName,
        )
        viewModel.canvas.attach(this)
      }
    },
  )
}

private class CanvasA2UIActionBridge(private val onMessage: (String) -> Unit) {
  @JavascriptInterface
  fun postMessage(payload: String?) {
    val msg = payload?.trim().orEmpty()
    if (msg.isEmpty()) return
    onMessage(msg)
  }

  companion object {
    const val interfaceName: String = "clawdisCanvasA2UIAction"
  }
}

private class CanvasA2UIActionLegacyBridge(private val bridge: CanvasA2UIActionBridge) {
  @JavascriptInterface
  fun canvasAction(payload: String?) {
    bridge.postMessage(payload)
  }

  @JavascriptInterface
  fun postMessage(payload: String?) {
    bridge.postMessage(payload)
  }

  companion object {
    const val interfaceName: String = "Android"
  }
}
