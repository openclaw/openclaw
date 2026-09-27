package ai.openclaw.app.calls

import ai.openclaw.app.NodeApp
import ai.openclaw.app.i18n.nativeString
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** Internal, user-visible call surface. Intent extras select only an already-authorized local call. */
class IncomingCallActivity : ComponentActivity() {
  private val calls get() = (application as NodeApp).ensureBackgroundRuntime().incomingCalls
  private lateinit var caller: TextView
  private lateinit var status: TextView
  private lateinit var answer: Button
  private lateinit var end: Button
  private lateinit var mute: Button
  private lateinit var route: Button
  private var pendingAction: String? = null
  private var callId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val density = resources.displayMetrics.density
    val content =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding((28 * density).toInt(), 48, (28 * density).toInt(), 48)
        setBackgroundColor(0xff101418.toInt())
      }

    fun label(size: Float) =
      TextView(this).apply {
        textSize = size
        gravity = Gravity.CENTER
        setTextColor(0xfff2f5f7.toInt())
        setPadding(0, 20, 0, 20)
        content.addView(this)
      }
    label(15f).text = nativeString("OPENCLAW · DATA CALL")
    caller = label(32f)
    status = label(18f)
    answer =
      Button(this).apply {
        text = nativeString("Answer")
        setOnClickListener { callId?.let(calls::answer) }
        content.addView(this, LinearLayout.LayoutParams(-1, (60 * density).toInt()))
      }
    end =
      Button(this).apply {
        text = nativeString("Decline")
        setOnClickListener {
          val id = callId ?: return@setOnClickListener
          when (calls.state.value?.status) {
            IncomingCallStatus.Ringing -> calls.decline(id)
            IncomingCallStatus.Connecting, IncomingCallStatus.Active -> calls.end(id)
            else -> finish()
          }
        }
        content.addView(this, LinearLayout.LayoutParams(-1, (60 * density).toInt()))
      }
    mute =
      Button(this).apply {
        text = nativeString("Mute microphone")
        setOnClickListener { callId?.let(calls::toggleMute) }
        content.addView(this, LinearLayout.LayoutParams(-1, (56 * density).toInt()))
      }
    route =
      Button(this).apply {
        text = nativeString("Audio output")
        setOnClickListener {
          val id = callId ?: return@setOnClickListener
          val routes = calls.audioRoutes.value
          android.app.AlertDialog
            .Builder(this@IncomingCallActivity)
            .setTitle(nativeString("Audio output"))
            .setItems(routes.map { it.second }.toTypedArray()) { _, which -> calls.selectAudioRoute(id, routes[which].first) }
            .setNegativeButton(nativeString("Cancel"), null)
            .show()
        }
        content.addView(this, LinearLayout.LayoutParams(-1, (56 * density).toInt()))
      }
    setContentView(content)
    readIntent(intent)
    lifecycleScope.launch {
      calls.state.collect { call ->
        if (call == null || call.invite.callId != callId) {
          finish()
          return@collect
        }
        caller.text = call.invite.callerName
        // No dossier/topic is shown above the lockscreen.
        status.text = call.detail ?: when (call.status) {
          IncomingCallStatus.Ringing -> nativeString("Incoming call over your private Gateway connection")
          IncomingCallStatus.Connecting -> nativeString("Connecting live voice…")
          IncomingCallStatus.Active -> if (calls.muted.value) nativeString("Connected · microphone muted") else nativeString("Connected · microphone on")
          else -> call.status.name
        }
        answer.visibility = if (call.status == IncomingCallStatus.Ringing) android.view.View.VISIBLE else android.view.View.GONE
        end.text =
          if (call.status == IncomingCallStatus.Ringing) {
            nativeString("Decline")
          } else if (call.status.isTerminal) {
            nativeString("Close")
          } else {
            nativeString("End call")
          }
        val inCall = call.status == IncomingCallStatus.Active || call.status == IncomingCallStatus.Connecting
        mute.visibility = if (inCall) android.view.View.VISIBLE else android.view.View.GONE
        route.visibility = if (inCall) android.view.View.VISIBLE else android.view.View.GONE
        if (call.status.isTerminal) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
    lifecycleScope.launch {
      calls.muted.collect {
        mute.text = if (it) nativeString("Unmute microphone") else nativeString("Mute microphone")
        if (calls.state.value?.status == IncomingCallStatus.Active && calls.state.value?.detail == null) status.text = if (it) nativeString("Connected · microphone muted") else nativeString("Connected · microphone on")
      }
    }
    lifecycleScope.launch { calls.audioRoutes.collect { route.isEnabled = it.isNotEmpty() } }
    lifecycleScope.launch { calls.audioOutput.collect { route.text = nativeString("Audio output: \$output", it) } }
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
