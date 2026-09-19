package ai.openclaw.app.auto

import ai.openclaw.app.NodeApp
import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

class OpenClawCarSession(
  private val app: NodeApp,
) : Session() {

  private val audioController by lazy { CarAudioController(carContext) }

  init {
    lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        override fun onDestroy(owner: LifecycleOwner) {
          audioController.abandonCarFocus()
        }
      },
    )
  }

  override fun onCreateScreen(intent: Intent): Screen {
    return OpenClawCarScreen(carContext, app)
  }
}

