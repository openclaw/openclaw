package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WearProtocol
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class WearProxyService : WearableListenerService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val requestHandler by lazy {
    WearProxyRequestHandler(
      source = NodeRuntimeWearProxySource(application as NodeApp),
    )
  }

  override fun onRequest(
    nodeId: String,
    path: String,
    request: ByteArray,
  ): Task<ByteArray>? =
    when (path) {
      WearProtocol.REQUEST_PATH -> {
        val task = TaskCompletionSource<ByteArray>()
        scope.launch {
          task.setResult(requestHandler.handle(request))
        }
        task.task
      }
      else -> null
    }

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }
}
