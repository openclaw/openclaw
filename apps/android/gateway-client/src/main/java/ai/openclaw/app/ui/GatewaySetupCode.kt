package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.normalizeGatewayContextPath
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI
import java.util.Base64
import java.util.Locale

data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
  val contextPath: String = "",
)

data class GatewaySetupCode(
  val url: String,
  val bootstrapToken: String?,
  val token: String?,
  val password: String?,
)

enum class GatewayEndpointValidationError {
  INVALID_URL,
  INSECURE_REMOTE_URL,
  IPV6_ZONE_ID_UNSUPPORTED,
}

data class GatewayEndpointParseResult(
  val config: GatewayEndpointConfig? = null,
  val error: GatewayEndpointValidationError? = null,
)

fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? = parseGatewayEndpointResult(rawInput).config

fun parseGatewayEndpointResult(rawInput: String): GatewayEndpointParseResult {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri =
    runCatching { URI(normalized) }.getOrNull()
      ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  }
  val host =
    uri.host
      ?.trim()
      ?.trim('[', ']')
      .orEmpty()
  if (host.isEmpty()) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  if (host.contains(':') && host.contains('%')) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED)
  }
  val scheme =
    uri.scheme
      ?.trim()
      ?.lowercase(Locale.US)
      .orEmpty()
  if (scheme !in setOf("ws", "wss", "http", "https")) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  }
  val tls = scheme == "wss" || scheme == "https"
  if (!tls && !isLocalCleartextGatewayHost(host)) {
    return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INSECURE_REMOTE_URL)
  }
  val defaultPort = if (tls) 443 else 18789
  val displayPort = if (tls) 443 else 80
  val port = if (uri.port == -1) defaultPort else uri.port
  if (port !in 1..65535) return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val contextPath = normalizeGatewayContextPath(uri.rawPath)
  val displayHost = if (host.contains(":")) "[$host]" else host
  val displayUrl =
    if (port == displayPort && defaultPort == displayPort) {
      "${if (tls) "https" else "http"}://$displayHost$contextPath"
    } else {
      "${if (tls) "https" else "http"}://$displayHost:$port$contextPath"
    }
  return GatewayEndpointParseResult(GatewayEndpointConfig(host, port, tls, displayUrl, contextPath))
}

/** Decodes the existing mobile bootstrap payload, without selecting an authority profile. */
fun decodeGatewaySetupCode(rawInput: String): GatewaySetupCode? {
  val raw = rawInput.trim()
  val trimmed = if (raw.startsWith("oc-pair://", ignoreCase = true)) raw.substring(10) else raw
  if (trimmed.isEmpty()) return null
  val padded =
    trimmed.replace('-', '+').replace('_', '/').let {
      val remainder = it.length % 4
      if (remainder == 0) it else it + "=".repeat(4 - remainder)
    }
  return try {
    val decoded = String(Base64.getDecoder().decode(padded), Charsets.UTF_8)
    val obj = runCatching { Json.parseToJsonElement(decoded) as? JsonObject }.getOrNull() ?: return null

    fun field(key: String): String? = (obj[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
    GatewaySetupCode(field("url") ?: return null, field("bootstrapToken"), field("token"), field("password"))
  } catch (_: IllegalArgumentException) {
    null
  }
}
