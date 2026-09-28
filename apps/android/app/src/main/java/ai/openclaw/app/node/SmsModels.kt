package ai.openclaw.app.node

import kotlinx.serialization.Serializable

data class SmsSendResult(
  val ok: Boolean,
  val to: String,
  val message: String?,
  val error: String? = null,
  val payloadJson: String,
)

@Serializable
data class SmsMessage(
  val id: Long,
  val threadId: Long,
  val address: String?,
  val person: String?,
  val date: Long,
  val dateSent: Long,
  val read: Boolean,
  val type: Int,
  val body: String?,
  val status: Int,
  val transportType: String? = null,
)

data class SmsSearchResult(
  val ok: Boolean,
  val messages: List<SmsMessage>,
  val error: String? = null,
  val payloadJson: String,
)
