package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.normalizeGatewayContextPath
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.util.Base64
import java.util.Locale

/** Parsed endpoint fields after URL validation and cleartext-safety checks. */
data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
  val contextPath: String = "",
)

/** Decoded setup-code payload; only one credential family is expected to be populated. */
data class GatewaySetupCode(
  val url: String,
  val bootstrapToken: String?,
  val token: String?,
  val password: String?,
)

/** Validation reason used by setup, QR, and manual endpoint copy. */
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
    runCatching { URI(normalized) }
      .getOrNull()
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
  // OkHttp rejects scoped IPv6 hosts after URI decoding, so fail before saving an endpoint that can never dial.
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
  val port = gatewayPort(uri.port, defaultPort) ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val contextPath = normalizeGatewayContextPath(uri.rawPath)
  val displayHost = if (host.contains(":")) "[$host]" else host
  val displayUrl =
    if (port == displayPort && defaultPort == displayPort) {
      "${if (tls) "https" else "http"}://$displayHost$contextPath"
    } else {
      "${if (tls) "https" else "http"}://$displayHost:$port$contextPath"
    }

  return GatewayEndpointParseResult(
    config =
      GatewayEndpointConfig(
        host = host,
        port = port,
        tls = tls,
        displayUrl = displayUrl,
        contextPath = contextPath,
      ),
  )
}

fun decodeGatewaySetupCode(rawInput: String): GatewaySetupCode? {
  val trimmed = stripPairingSetupUrlPrefix(rawInput.trim())
  if (trimmed.isEmpty()) return null

  val padded =
    trimmed
      .replace('-', '+')
      .replace('_', '/')
      .let { normalized ->
        val remainder = normalized.length % 4
        if (remainder == 0) normalized else normalized + "=".repeat(4 - remainder)
      }

  return try {
    val decoded = String(Base64.getDecoder().decode(padded), Charsets.UTF_8)
    val obj = runCatching { Json.parseToJsonElement(decoded) as? JsonObject }.getOrNull() ?: return null
    val url =
      obj["url"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        .orEmpty()
    if (url.isEmpty()) return null
    val bootstrapToken = obj["bootstrapToken"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
    val token = obj["token"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
    val password = obj["password"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
    GatewaySetupCode(url = url, bootstrapToken = bootstrapToken, token = token, password = password)
  } catch (_: IllegalArgumentException) {
    null
  }
}

private fun gatewayPort(
  port: Int,
  defaultPort: Int,
): Int? =
  when {
    port == -1 -> defaultPort
    port in 1..65535 -> port
    else -> null
  }

private const val PAIRING_SETUP_URL_PREFIX = "oc-pair://"

private fun stripPairingSetupUrlPrefix(raw: String): String =
  if (raw.startsWith(PAIRING_SETUP_URL_PREFIX, ignoreCase = true)) {
    raw.substring(PAIRING_SETUP_URL_PREFIX.length)
  } else {
    raw
  }
