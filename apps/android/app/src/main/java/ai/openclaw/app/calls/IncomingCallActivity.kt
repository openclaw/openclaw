package ai.openclaw.app.calls

import ai.openclaw.app.NodeApp
import ai.openclaw.app.ui.OpenClawTheme
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** Internal call surface. Intent extras select only an already-authorized local call. */
class IncomingCallActivity : ComponentActivity() {
  private val calls get() = (application as NodeApp).ensureBackgroundRuntime().incomingCalls
  private var pendingAction: String? = null
  private var callId by mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    readIntent(intent)
    setContent {
      val call by calls.state.collectAsState()
      val muted by calls.muted.collectAsState()
      val routes by calls.audioRoutes.collectAsState()
      val output by calls.audioOutput.collectAsState()
      val current = call?.takeIf { it.invite.callId == callId }
      OpenClawTheme {
        if (current != null) {
          IncomingCallScreen(
            call = current,
            muted = muted,
            routes = routes,
            output = output,
            onAnswer = { calls.answer(current.invite.callId) },
            onEnd = {
              when (current.status) {
                IncomingCallStatus.Ringing -> calls.decline(current.invite.callId)
                IncomingCallStatus.Connecting, IncomingCallStatus.Active -> calls.end(current.invite.callId)
                else -> finish()
              }
            },
            onMute = { calls.toggleMute(current.invite.callId) },
            onRoute = { calls.selectAudioRoute(current.invite.callId, it) },
          )
        }
      }
    }
    lifecycleScope.launch {
      calls.state.collect { call ->
        if (call == null || call.invite.callId != callId) {
          finish()
        } else if (call.status.isTerminal) {
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    readIntent(intent)
  }

  private fun readIntent(intent: Intent) {
    callId = intent.getStringExtra(IncomingCallController.CALL_ID)
    pendingAction = intent.getStringExtra(IncomingCallController.ACTION)
    if (callId == null || calls.state.value
        ?.invite
        ?.callId != callId
    ) {
      finish()
    }
    if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) applyAction()
  }

  override fun onResume() {
    super.onResume()
    applyAction()
  }

  private fun applyAction() {
    val action = pendingAction
    pendingAction = null
    val id = callId ?: return
    when (action) {
      "answer" -> {
        calls.answer(id)
      }

      "decline" -> {
        calls.decline(id)
        finish()
      }

      "end" -> {
        calls.end(id)
        finish()
      }
    }
  }
}
