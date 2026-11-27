package ai.openclaw.app.node

import ai.openclaw.app.gateway.InvokeResult
import android.content.Context

class CallLogHandler(
  @Suppress("unused") appContext: Context,
) {
  fun handleCallLogSearch(
    @Suppress("unused") paramsJson: String?,
  ): InvokeResult = nodeInvokeError("CALL_LOG_UNAVAILABLE", "call log not available on this build")
}
