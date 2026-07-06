package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Read-only agent workspace browser models for the `agents.workspace.*` gateway
// RPCs (#100705). Parsing stays here so it is unit-testable without a runtime.

data class GatewayWorkspaceEntry(
  val path: String,
  val name: String,
  val isDirectory: Boolean,
  val size: Long?,
  val updatedAtMs: Long?,
)

data class GatewayWorkspaceListing(
  val path: String,
  val parentPath: String?,
  val entries: List<GatewayWorkspaceEntry>,
  val truncated: Boolean,
)

data class GatewayWorkspaceFilePreview(
  val path: String,
  val name: String,
  val size: Long,
  val mimeType: String?,
  val isBase64: Boolean,
  val content: String,
)

sealed interface GatewayWorkspaceFilesState {
  data object Idle : GatewayWorkspaceFilesState

  data class Loading(
    val path: String,
  ) : GatewayWorkspaceFilesState

  data class Loaded(
    val listing: GatewayWorkspaceListing,
  ) : GatewayWorkspaceFilesState

  data class Error(
    val path: String,
    val message: String,
  ) : GatewayWorkspaceFilesState
}

sealed interface GatewayWorkspaceFilePreviewState {
  data object Idle : GatewayWorkspaceFilePreviewState

  data class Loading(
    val path: String,
  ) : GatewayWorkspaceFilePreviewState

  data class Loaded(
    val file: GatewayWorkspaceFilePreview,
  ) : GatewayWorkspaceFilePreviewState

  data class Error(
    val path: String,
    val message: String,
  ) : GatewayWorkspaceFilePreviewState
}

internal fun workspaceListParams(
  agentId: String,
  path: String,
  offset: Int? = null,
): String =
  buildJsonObject {
    put("agentId", JsonPrimitive(agentId))
    if (path.isNotEmpty()) put("path", JsonPrimitive(path))
    if (offset != null && offset > 0) put("offset", JsonPrimitive(offset))
  }.toString()

internal fun workspaceReadParams(
  agentId: String,
  path: String,
): String =
  buildJsonObject {
    put("agentId", JsonPrimitive(agentId))
    put("path", JsonPrimitive(path))
  }.toString()

internal fun parseGatewayWorkspaceListing(root: JsonObject?): GatewayWorkspaceListing? {
  val value = root ?: return null
  val path = value["path"].asStringOrNull() ?: return null
  val entries =
    (value["entries"] as? JsonArray)?.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val entryPath = obj["path"].asStringOrNull()?.trim().orEmpty()
      val name = obj["name"].asStringOrNull()?.trim().orEmpty()
      if (entryPath.isEmpty() || name.isEmpty()) return@mapNotNull null
      GatewayWorkspaceEntry(
        path = entryPath,
        name = name,
        isDirectory = obj["kind"].asStringOrNull() == "directory",
        size = obj.long("size"),
        updatedAtMs = obj.long("updatedAtMs"),
      )
    } ?: return null
  return GatewayWorkspaceListing(
    path = path,
    parentPath = value["parentPath"].asStringOrNull(),
    entries = entries,
    truncated = (value["truncated"] as? JsonPrimitive)?.content == "true",
  )
}

internal fun parseGatewayWorkspaceFilePreview(root: JsonObject?): GatewayWorkspaceFilePreview? {
  val file = root?.get("file").asObjectOrNull() ?: return null
  val path = file["path"].asStringOrNull()?.trim().orEmpty()
  val name = file["name"].asStringOrNull()?.trim().orEmpty()
  val content = file["content"].asStringOrNull()
  if (path.isEmpty() || name.isEmpty() || content == null) return null
  return GatewayWorkspaceFilePreview(
    path = path,
    name = name,
    size = file.long("size") ?: 0L,
    mimeType = file["mimeType"].asStringOrNull(),
    isBase64 = file["encoding"].asStringOrNull() == "base64",
    content = content,
  )
}

private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.content?.trim()?.toLongOrNull()
