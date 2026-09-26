package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context

class CallLogHandler(
  @Suppress("unused") appContext: Context,
) {
  fun handleCallLogSearch(
    @Suppress("unused") paramsJson: String?,
  ): GatewaySession.InvokeResult =
    GatewaySession.InvokeResult.error(
      code = "CALL_LOG_UNAVAILABLE",
      message = "CALL_LOG_UNAVAILABLE: call log not available on this build",
    )
}
