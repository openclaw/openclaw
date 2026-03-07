package ai.openclaw.android.node

import ai.openclaw.android.gateway.GatewaySession

class ScreenHandler(
  private val screenRecorder: ScreenRecordManager,
  private val invokeErrorFromThrowable: (Throwable) -> Pair<String, String>,
) {
  suspend fun handleScreenRecord(paramsJson: String?): GatewaySession.InvokeResult {
    val res =
      try {
        screenRecorder.record(paramsJson)
      } catch (err: Throwable) {
        val (code, message) = invokeErrorFromThrowable(err)
        return GatewaySession.InvokeResult.error(code = code, message = message)
      }
    return GatewaySession.InvokeResult.ok(res.payloadJson)
  }
}
