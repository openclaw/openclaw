package ai.openclaw.app.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class SessionDiffSnapshot(
  val sessionKey: String,
  val files: List<SessionDiffFile>,
  val additions: Int,
  val deletions: Int,
  val branch: String? = null,
  val truncated: Boolean = false,
  val unavailableReason: String? = null,
)

@Serializable
data class SessionDiffFile(
  val path: String,
  val status: String,
  val additions: Int,
  val deletions: Int,
  val oldPath: String? = null,
  val binary: Boolean = false,
  val patch: String? = null,
  val truncated: Boolean = false,
)

internal fun parseSessionDiff(
  json: Json,
  payload: String,
): SessionDiffSnapshot = json.decodeFromString(payload)
