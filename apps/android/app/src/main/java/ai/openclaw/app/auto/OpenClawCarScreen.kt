package ai.openclaw.app.auto

import ai.openclaw.app.NodeApp
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.Header
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

class OpenClawCarScreen(
  carContext: CarContext,
  private val app: NodeApp,
) : Screen(carContext) {

  private var isListening = false

  init {
    lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) {
          invalidate()
        }

        override fun onPause(owner: LifecycleOwner) {
          if (isListening) {
            stopVoiceInteraction()
          }
        }
      },
    )
  }

  override fun onGetTemplate(): Template {
    val runtime = app.ensureRuntime()
    val isConnected = runtime.gatewayConnectionDisplay.value.isConnected
    val messageRes = when {
      !isConnected -> ai.openclaw.app.R.string.native_0303e18246708180 // "Not connected"
      isListening -> ai.openclaw.app.R.string.native_049579fa8efbaa1b // "Listening (PTT)"
      else -> ai.openclaw.app.R.string.native_003aaf9e0a0e6b9f // "Mic off"
    }
    val messageText = carContext.getString(messageRes)

    val pttActionTitle = if (isListening) {
      carContext.getString(ai.openclaw.app.R.string.cancel)
    } else {
      carContext.getString(ai.openclaw.app.R.string.native_0979c6fdbdca1675) // "Open Chat"
    }

    val header = Header.Builder()
      .setTitle(carContext.getString(ai.openclaw.app.R.string.app_name))
      .build()

    return MessageTemplate.Builder(messageText)
      .setHeader(header)
      .addAction(
        Action.Builder()
          .setTitle(pttActionTitle)
          .setOnClickListener {
            toggleVoiceInteraction()
          }
          .build(),
      )
      .build()
  }

  private fun toggleVoiceInteraction() {
    if (isListening) {
      stopVoiceInteraction()
    } else {
      startVoiceInteraction()
    }
  }

  private fun startVoiceInteraction() {
    val runtime = app.ensureRuntime()
    if (!runtime.gatewayConnectionDisplay.value.isConnected) return
    isListening = true
    invalidate()
  }

  private fun stopVoiceInteraction() {
    isListening = false
    invalidate()
  }
}
