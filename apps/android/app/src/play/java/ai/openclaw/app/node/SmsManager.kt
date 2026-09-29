package ai.openclaw.app.node

import ai.openclaw.app.PermissionRequester
import android.content.Context

class SmsManager(
  @Suppress("unused") private val context: Context,
) {
  fun attachPermissionRequester(
    @Suppress("unused") requester: PermissionRequester,
  ) {
  }

  fun canSendSms(): Boolean = false

  fun canReadSms(): Boolean = false

  fun hasTelephonyFeature(): Boolean = false

  suspend fun send(paramsJson: String?): SmsSendResult =
    SmsSendResult(
      ok = false,
      to = "",
      message = null,
      error = "SMS_PERMISSION_REQUIRED: grant SMS permission",
      payloadJson = unavailablePayload(paramsJson),
    )

  suspend fun search(paramsJson: String?): SmsSearchResult =
    SmsSearchResult(
      ok = false,
      messages = emptyList(),
      error = "SMS_PERMISSION_REQUIRED: grant READ_SMS permission",
      payloadJson = unavailablePayload(paramsJson),
    )

  private fun unavailablePayload(paramsJson: String?): String = """{"ok":false,"error":"SMS_UNAVAILABLE","paramsProvided":${!paramsJson.isNullOrBlank()}}"""
}
