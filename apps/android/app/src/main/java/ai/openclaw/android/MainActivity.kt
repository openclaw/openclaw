package ai.openclaw.android

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import ai.openclaw.android.ui.RootScreen
import ai.openclaw.android.ui.OpenClawTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  private val viewModel: MainViewModel by viewModels()
  private lateinit var permissionRequester: PermissionRequester
  private lateinit var screenCaptureRequester: ScreenCaptureRequester

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    WebView.setWebContentsDebuggingEnabled(isDebuggable)
    applyImmersiveMode()
    NodeForegroundService.start(this)
    permissionRequester = PermissionRequester(this)
    screenCaptureRequester = ScreenCaptureRequester(this)
    viewModel.camera.attachLifecycleOwner(this)
    viewModel.camera.attachPermissionRequester(permissionRequester)
    viewModel.sms.attachPermissionRequester(permissionRequester)
    viewModel.screenRecorder.attachScreenCaptureRequester(screenCaptureRequester)
    viewModel.screenRecorder.attachPermissionRequester(permissionRequester)

    lifecycleScope.launch {
      repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.preventSleep.collect { enabled ->
          if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          }
        }
      }
    }

    setContent {
      OpenClawTheme {
        Surface(modifier = Modifier) {
          RootScreen(viewModel = viewModel)
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    applyImmersiveMode()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      applyImmersiveMode()
    }
  }

  override fun onStart() {
    super.onStart()
    viewModel.setForeground(true)
  }

  override fun onStop() {
    viewModel.setForeground(false)
    super.onStop()
  }

  private fun applyImmersiveMode() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }
}
