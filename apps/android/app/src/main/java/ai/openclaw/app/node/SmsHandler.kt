package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession

class SmsHandler(
  private val sms: SmsManager,
) {
  suspend fun handleSmsSend(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.send(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    } else {
      val error = res.error ?: "SMS_SEND_FAILED"
      val idx = error.indexOf(':')
      val code = if (idx > 0) error.substring(0, idx).trim() else "SMS_SEND_FAILED"
      return GatewaySession.InvokeResult.error(code = code, message = error)
    }
  }

  suspend fun handleSmsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    // Check permissions first
    if (!sms.hasReadSmsPermission()) {
      return GatewaySession.InvokeResult.error(
        code = "SMS_PERMISSION_REQUIRED",
        message = "SMS_PERMISSION_REQUIRED: grant SMS permission",
      )
    }

    val res = sms.search(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    } else {
      val error = res.error ?: "SMS_SEARCH_FAILED"
      val idx = error.indexOf(':')
      val code = if (idx > 0) error.substring(0, idx).trim() else "SMS_SEARCH_FAILED"
      return GatewaySession.InvokeResult.error(code = code, message = error)
    }
  }
}
