package ai.openclaw.app.node

import ai.openclaw.app.gateway.InvokeResult

class SmsHandler(
  private val sms: SmsManager,
) {
  suspend fun handleSmsSend(paramsJson: String?): InvokeResult = sms.send(paramsJson).toInvokeResult(defaultCode = "SMS_SEND_FAILED")

  suspend fun handleSmsSearch(paramsJson: String?): InvokeResult = sms.search(paramsJson).toInvokeResult(defaultCode = "SMS_SEARCH_FAILED")

  private fun SmsResult.toInvokeResult(defaultCode: String): InvokeResult {
    if (ok) return InvokeResult.ok(payloadJson)
    val rawMessage = error ?: defaultCode
    val idx = rawMessage.indexOf(':')
    val code = if (idx > 0) rawMessage.substring(0, idx).trim() else defaultCode
    val message =
      if (idx > 0) {
        rawMessage.substring(idx + 1).trim().ifEmpty { rawMessage }
      } else {
        rawMessage
      }
    return InvokeResult.error(code = code, message = message)
  }
}
