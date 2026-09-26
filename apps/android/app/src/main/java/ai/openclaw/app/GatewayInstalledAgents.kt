package ai.openclaw.app

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class GatewayInstalledAgent(
  val id: String,
  val name: String,
  val runtimeId: String,
  val installation: GatewayInstalledAgentInstallation,
  val enabled: Boolean,
)

enum class GatewayInstalledAgentInstallation {
  Installed,
  Missing,
  Unverified,
}

internal fun parseGatewayInstalledAgents(root: JsonObject): List<GatewayInstalledAgent> =
  (root.getValue("agents") as JsonArray).map { entry ->
    val agent = entry.jsonObject
    GatewayInstalledAgent(
      id = agent.getValue("id").jsonPrimitive.content,
      name = agent.getValue("name").jsonPrimitive.content,
      runtimeId = agent.getValue("runtimeId").jsonPrimitive.content,
      installation =
        when (agent.getValue("installation").jsonPrimitive.content) {
          "installed" -> GatewayInstalledAgentInstallation.Installed
          "missing" -> GatewayInstalledAgentInstallation.Missing
          else -> GatewayInstalledAgentInstallation.Unverified
        },
      enabled = agent.getValue("enabled").jsonPrimitive.boolean,
    )
  }
