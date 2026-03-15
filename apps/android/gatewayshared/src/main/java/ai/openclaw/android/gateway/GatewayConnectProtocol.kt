package ai.openclaw.android.gateway

import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

const val GATEWAY_PROTOCOL_VERSION = 3

data class GatewayClientInfo(
  val id: String,
  val displayName: String? = null,
  val version: String,
  val platform: String,
  val mode: String,
  val instanceId: String? = null,
  val deviceFamily: String? = null,
  val modelIdentifier: String? = null,
)

data class GatewayConnectOptions(
  val role: String,
  val scopes: List<String>,
  val caps: List<String>,
  val commands: List<String>,
  val permissions: Map<String, Boolean>,
  val client: GatewayClientInfo,
  val userAgent: String? = null,
)

/**
 * Standard connect-option profiles and JSON serialization helpers
 * for the gateway `connect` RPC.
 */
object GatewayConnectBuilder {
  val OperatorScopes: List<String> = listOf(
    "operator.read",
    "operator.write",
    "operator.talk.secrets",
  )

  /** Builds a standard operator [GatewayConnectOptions] (no node capabilities). */
  fun buildOperatorConnectOptions(
    client: GatewayClientInfo,
    userAgent: String? = null,
  ): GatewayConnectOptions {
    return GatewayConnectOptions(
      role = "operator",
      scopes = OperatorScopes,
      caps = emptyList(),
      commands = emptyList(),
      permissions = emptyMap(),
      client = client,
      userAgent = userAgent,
    )
  }

  /**
   * Builds [GatewayClientInfo] for Wear OS operator connections.
   */
  fun buildWearClientInfo(
    deviceId: String,
    versionName: String,
    displayName: String? = null,
    modelIdentifier: String? = null,
  ): GatewayClientInfo {
    return GatewayClientInfo(
      id = GatewayClientProfiles.AndroidClientId,
      displayName = displayName ?: GatewayClientProfiles.resolveWearDisplayName(),
      version = versionName,
      platform = GatewayClientProfiles.WearOsPlatform,
      mode = GatewayClientProfiles.UiMode,
      instanceId = deviceId,
      deviceFamily = GatewayClientProfiles.WatchDeviceFamily,
      modelIdentifier = modelIdentifier ?: GatewayClientProfiles.resolveModelIdentifier(),
    )
  }

  /**
   * Builds a standard Wear OS operator [GatewayConnectOptions].
   */
  fun buildWearOperatorConnectOptions(
    deviceId: String,
    versionName: String,
    displayName: String? = null,
    modelIdentifier: String? = null,
    userAgent: String? = null,
  ): GatewayConnectOptions {
    return buildOperatorConnectOptions(
      client =
        buildWearClientInfo(
          deviceId = deviceId,
          versionName = versionName,
          displayName = displayName,
          modelIdentifier = modelIdentifier,
        ),
      userAgent = userAgent,
    )
  }

  fun buildClientInfoJson(client: GatewayClientInfo): JsonObject {
    return buildJsonObject {
      put("id", JsonPrimitive(client.id))
      client.displayName?.let { put("displayName", JsonPrimitive(it)) }
      put("version", JsonPrimitive(client.version))
      put("platform", JsonPrimitive(client.platform))
      put("mode", JsonPrimitive(client.mode))
      client.instanceId?.let { put("instanceId", JsonPrimitive(it)) }
      client.deviceFamily?.let { put("deviceFamily", JsonPrimitive(it)) }
      client.modelIdentifier?.let { put("modelIdentifier", JsonPrimitive(it)) }
    }
  }

  /**
   * Serializes [options] into the JSON payload expected by the gateway
   * `connect` RPC.
   *
   * @param locale BCP-47 locale tag. Defaults to the device locale at call
   *   time ([Locale.getDefault]), so each invocation captures the current
   *   locale rather than a fixed value.
   */
  fun buildConnectParamsJson(
    options: GatewayConnectOptions,
    locale: String = Locale.getDefault().toLanguageTag(),
    authJson: JsonObject? = null,
    deviceJson: JsonObject? = null,
    protocolVersion: Int = GATEWAY_PROTOCOL_VERSION,
  ): JsonObject {
    return buildJsonObject {
      put("minProtocol", JsonPrimitive(protocolVersion))
      put("maxProtocol", JsonPrimitive(protocolVersion))
      put("client", buildClientInfoJson(options.client))
      if (options.caps.isNotEmpty()) put("caps", JsonArray(options.caps.map(::JsonPrimitive)))
      if (options.commands.isNotEmpty()) put("commands", JsonArray(options.commands.map(::JsonPrimitive)))
      if (options.permissions.isNotEmpty()) {
        put(
          "permissions",
          buildJsonObject {
            options.permissions.forEach { (key, value) ->
              put(key, JsonPrimitive(value))
            }
          },
        )
      }
      put("role", JsonPrimitive(options.role))
      if (options.scopes.isNotEmpty()) put("scopes", JsonArray(options.scopes.map(::JsonPrimitive)))
      authJson?.let { put("auth", it) }
      deviceJson?.let { put("device", it) }
      put("locale", JsonPrimitive(locale))
      options.userAgent?.trim()?.takeIf { it.isNotEmpty() }?.let {
        put("userAgent", JsonPrimitive(it))
      }
    }
  }
}
