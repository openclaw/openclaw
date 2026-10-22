package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class GatewayAgentSummary(
  val id: String,
  val name: String?,
  val emoji: String?,
  val avatar: String? = null,
  val avatarUrl: String? = null,
  val workspaceGit: Boolean = false,
  val kind: String? = null,
)

/** Parses validated agents.list rows into the smaller Android display model. */
internal fun parseGatewayAgentSummaries(root: JsonObject): List<GatewayAgentSummary> =
  (root["agents"] as? JsonArray).mapObjects { agent ->
    val id = agent.nonBlankString("id") ?: return@mapObjects null
    val identity = agent["identity"].asObjectOrNull()
    GatewayAgentSummary(
      id = id,
      kind = agent.nonBlankString("kind"),
      name = agent.nonBlankString("name"),
      emoji = identity.nonBlankString("emoji"),
      avatar = identity.nonBlankString("avatar"),
      avatarUrl = identity.nonBlankString("avatarUrl"),
      workspaceGit = (agent["workspaceGit"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() == true,
    )
  }

internal fun List<GatewayAgentSummary>.selectableAgents(): List<GatewayAgentSummary> = filter { it.kind != "system" }
