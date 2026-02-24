package ai.openclaw.android.ui

import android.util.Base64
import androidx.core.net.toUri
import java.util.Locale
import org.json.JSONObject

internal data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
)

internal data class GatewaySetupCode(
  val url: String,
  val token: String?,
  val password: String?,
)

internal data class GatewayConnectConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val token: String,
  val password: String,
)

internal fun resolveGatewayConnectConfig(
  useSetupCode: Boolean,
  setupCode: String,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  fallbackToken: String,
  fallbackPassword: String,
): GatewayConnectConfig? {
  if (useSetupCode) {
    val setup = decodeGatewaySetupCode(setupCode) ?: return null
    val parsed = parseGatewayEndpoint(setup.url) ?: return null
    return GatewayConnectConfig(
      host = parsed.host,
      port = parsed.port,
      tls = parsed.tls,
      token = setup.token ?: fallbackToken.trim(),
      password = setup.password ?: fallbackPassword.trim(),
    )
  }

  val manualUrl = composeGatewayManualUrl(manualHost, manualPort, manualTls) ?: return null
  val parsed = parseGatewayEndpoint(manualUrl) ?: return null
  return GatewayConnectConfig(
    host = parsed.host,
    port = parsed.port,
    tls = parsed.tls,
    token = fallbackToken.trim(),
    password = fallbackPassword.trim(),
  )
}

internal fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return null

  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri = normalized.toUri()
  val host = uri.host?.trim().orEmpty()
  if (host.isEmpty()) return null

  val scheme = uri.scheme?.trim()?.lowercase(Locale.US).orEmpty()
  val tls =
    when (scheme) {
      "ws", "http" -> false
      "wss", "https" -> true
      else -> true
    }
  val port = uri.port.takeIf { it in 1..65535 } ?: 18789
  val displayUrl = "${if (tls) "https" else "http"}://$host:$port"

  return GatewayEndpointConfig(host = host, port = port, tls = tls, displayUrl = displayUrl)
}

internal fun decodeGatewaySetupCode(rawInput: String): GatewaySetupCode? {
  val trimmed = rawInput.trim()
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
    val decoded = String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
    val obj = JSONObject(decoded)
    val url = obj.optString("url").trim()
    if (url.isEmpty()) return null
    val token = obj.optString("token").trim().ifEmpty { null }
    val password = obj.optString("password").trim().ifEmpty { null }
    GatewaySetupCode(url = url, token = token, password = password)
  } catch (_: Throwable) {
    null
  }
}

internal fun composeGatewayManualUrl(hostInput: String, portInput: String, tls: Boolean): String? {
  val host = hostInput.trim()
  val port = portInput.trim().toIntOrNull() ?: return null
  if (host.isEmpty() || port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://$host:$port"
}
