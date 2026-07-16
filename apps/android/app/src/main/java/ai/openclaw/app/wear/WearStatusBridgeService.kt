package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WEAR_CONVERSATION_PATH
import ai.openclaw.wear.shared.WEAR_STATUS_PATH
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class WearStatusBridgeService : WearableListenerService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val statusHandler by lazy {
    WearStatusRequestHandler(
      source = NodeRuntimeWearStatusSource(application as NodeApp),
    )
  }
  private val conversationHandler by lazy {
    WearConversationRequestHandler(
      source = NodeRuntimeWearConversationSource(application as NodeApp),
    )
  }

  override fun onRequest(
    nodeId: String,
    path: String,
    request: ByteArray,
  ): Task<ByteArray>? =
    when (path) {
      WEAR_STATUS_PATH -> Tasks.forResult(statusHandler.handle(request))
      WEAR_CONVERSATION_PATH -> {
        val task = TaskCompletionSource<ByteArray>()
        scope.launch {
          task.setResult(conversationHandler.handle(request))
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
