package ai.openclaw.wear

internal data class WearReplyTarget(
  val phoneNodeId: String,
  val sessionKey: String,
  val agentId: String?,
  val entryId: String,
  val attemptId: String? = null,
)
