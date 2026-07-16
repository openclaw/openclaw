package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WEAR_STATUS_PATH
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.WearableListenerService

class WearStatusBridgeService : WearableListenerService() {
  private val handler by lazy {
    WearStatusRequestHandler(
      source = NodeRuntimeWearStatusSource(application as NodeApp),
    )
  }

  override fun onRequest(
    nodeId: String,
    path: String,
    request: ByteArray,
  ): Task<ByteArray>? =
    if (path == WEAR_STATUS_PATH) {
      Tasks.forResult(handler.handle(request))
    } else {
      null
    }
}
