package ai.openclaw.app.ui

import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.normalizeGatewayContextPath
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.node.parseJsonParamsObject
import ai.openclaw.app.nonBlankString
import java.net.URI
import java.util.Base64
import java.util.Locale

/** Parsed endpoint fields after URL validation and cleartext-safety checks. */
internal data class GatewayEndpointConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
  val contextPath: String = "",
)

internal data class GatewayManualTransportPresentation(
  val requiresTls: Boolean,
  val effectiveTls: Boolean,
  val helperText: String? =
    when {
      requiresTls -> nativeString("Secure connection is required for this host.")
      effectiveTls -> null
      else -> nativeString("Use only on a trusted private network.")
    },
)

/** Decoded setup-code payload; only one credential family is expected to be populated. */
internal data class GatewaySetupCode(
  val url: String,
  val bootstrapToken: String?,
  val token: String?,
  val password: String?,
)

/** Final gateway connection fields selected from setup-code or manual UI input. */
internal data class GatewayConnectConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val bootstrapToken: String,
  val token: String,
  val password: String,
  val contextPath: String = "",
)

/** How a connection attempt may update credentials already owned by the runtime. */
internal enum class GatewaySavedAuthAction {
  PRESERVE,
  REPLACE_CREDENTIALS,
  REPLACE_ENDPOINT,
  REPLACE_SETUP,
}

/** Endpoint plus the credential ownership decision applied by MainViewModel. */
internal data class GatewayConnectPlan(
  val config: GatewayConnectConfig,
  val savedAuthAction: GatewaySavedAuthAction,
)

/** Validation reason used by setup, QR, and manual endpoint copy. */
internal enum class GatewayEndpointValidationError {
  INVALID_URL,
  INSECURE_REMOTE_URL,
  IPV6_ZONE_ID_UNSUPPORTED,
}

internal enum class GatewayEndpointInputSource(
  val insecureRemoteText: NativeText,
  val ipv6ZoneIdText: NativeText,
  val invalidUrlText: NativeText,
) {
  SETUP_CODE(
    nativeText(
      "Setup code points to an insecure remote gateway. \$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
      remoteGatewaySecurityRuleText(),
      remoteGatewaySecurityFixText(),
    ),
    nativeText("Setup code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname."),
    nativeText("Setup code has invalid gateway URL."),
  ),
  MANUAL(
    nativeText(
      "\$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
      remoteGatewaySecurityRuleText(),
      remoteGatewaySecurityFixText(),
    ),
    nativeText("IPv6 zone IDs are not supported. Use an unscoped IPv6 address or a LAN hostname."),
    nativeText("Enter a valid manual endpoint to connect."),
  ),
  QR_SCAN(
    nativeText(
      "QR code points to an insecure remote gateway. \$remoteGatewaySecurityRule \$remoteGatewaySecurityFix",
      remoteGatewaySecurityRuleText(),
      remoteGatewaySecurityFixText(),
    ),
    nativeText("QR code uses an IPv6 zone ID. Use an unscoped IPv6 address or a LAN hostname."),
    nativeText("QR code did not contain a valid setup code."),
  ),
}

internal data class GatewayEndpointParseResult(
  val config: GatewayEndpointConfig? = null,
  val error: GatewayEndpointValidationError? = null,
)

internal data class GatewayScannedSetupCodeResult(
  val setupCode: String? = null,
  val error: GatewayEndpointValidationError? = null,
)

private fun remoteGatewaySecurityRuleText(): NativeText =
  nativeText(
    "Public gateways require wss:// or Tailscale Serve. ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs.",
  )

private fun remoteGatewaySecurityFixText(): NativeText =
  nativeText(
    "Use a private LAN IP for local setup, or enable Tailscale Serve / expose a wss:// gateway URL for remote access.",
  )

/** Resolves setup-code or manual UI fields without reading stored credentials. */
internal fun resolveGatewayConnectConfig(
  useSetupCode: Boolean,
  setupCode: String,
  manualHostInput: String,
  manualPortInput: String,
  manualTlsInput: Boolean,
  bootstrapTokenInput: String,
  tokenInput: String,
  passwordInput: String,
): GatewayConnectConfig? {
  val setup =
    if (useSetupCode) {
      resolveSetupCodeCandidate(setupCode)?.let(::decodeGatewaySetupCode) ?: return null
    } else {
      null
    }
  val url = setup?.url ?: composeGatewayManualUrl(manualHostInput, manualPortInput, manualTlsInput) ?: return null
  val parsed = parseGatewayEndpointResult(url).config ?: return null
  val bootstrapToken: String
  val token: String
  val password: String
  if (setup != null) {
    bootstrapToken =
      setup.bootstrapToken
        ?.trim()
        .orEmpty()
        .ifEmpty { bootstrapTokenInput.trim() }
    // Bootstrap setup codes intentionally suppress stale shared credentials;
    // the bootstrap token owns the first authenticated pairing exchange.
    token =
      when {
        !setup.token.isNullOrBlank() -> setup.token.trim()
        bootstrapToken.isNotEmpty() -> ""
        else -> tokenInput.trim()
      }
    password =
      when {
        !setup.password.isNullOrBlank() -> setup.password.trim()
        bootstrapToken.isNotEmpty() || token.isNotEmpty() -> ""
        else -> passwordInput.trim()
      }
  } else {
    token = tokenInput.trim()
    bootstrapToken = bootstrapTokenInput.trim().takeIf { token.isEmpty() }.orEmpty()
    password = passwordInput.trim().takeIf { token.isEmpty() && bootstrapToken.isEmpty() }.orEmpty()
  }
  return GatewayConnectConfig(
    host = parsed.host,
    port = parsed.port,
    tls = parsed.tls,
    contextPath = parsed.contextPath,
    bootstrapToken = bootstrapToken,
    token = token,
    password = password,
  )
}

/**
 * Produces one closed endpoint/auth plan. Blank auth fields preserve secrets
 * only for the saved endpoint; neither Compose nor this resolver reads them.
 */
internal fun resolveGatewayConnectPlan(
  useSetupCode: Boolean,
  setupCode: String,
  savedManualHost: String,
  savedManualPort: String,
  savedManualTls: Boolean,
  manualHostInput: String,
  manualPortInput: String,
  manualTlsInput: Boolean,
  tokenInput: String,
  bootstrapTokenInput: String,
  passwordInput: String,
): GatewayConnectPlan? {
  val config =
    resolveGatewayConnectConfig(
      useSetupCode = useSetupCode,
      setupCode = setupCode,
      manualHostInput = manualHostInput,
      manualPortInput = manualPortInput,
      manualTlsInput = manualTlsInput,
      tokenInput = tokenInput,
      bootstrapTokenInput = bootstrapTokenInput,
      passwordInput = passwordInput,
    ) ?: return null
  if (useSetupCode || config.bootstrapToken.isNotEmpty()) {
    // Bootstrap auth requests a fresh pairing exchange. Retained role tokens
    // would otherwise win before the bootstrap credential is attempted.
    return GatewayConnectPlan(config, GatewaySavedAuthAction.REPLACE_SETUP)
  }

  val savedManualEndpoint =
    composeGatewayManualUrl(savedManualHost, savedManualPort, savedManualTls)
      ?.let { parseGatewayEndpointResult(it).config }
  val action =
    when {
      savedManualEndpoint?.sameEndpoint(config) != true -> GatewaySavedAuthAction.REPLACE_ENDPOINT
      config.token.isNotEmpty() || config.password.isNotEmpty() -> GatewaySavedAuthAction.REPLACE_CREDENTIALS
      else -> GatewaySavedAuthAction.PRESERVE
    }
  return GatewayConnectPlan(config, action)
}

private fun GatewayEndpointConfig.sameEndpoint(config: GatewayConnectConfig): Boolean =
  host.equals(config.host, ignoreCase = true) &&
    port == config.port &&
    tls == config.tls &&
    contextPath == config.contextPath

internal fun parseGatewayEndpoint(rawInput: String): GatewayEndpointConfig? = parseGatewayEndpointResult(rawInput).config

internal fun parseGatewayEndpointResult(rawInput: String): GatewayEndpointParseResult {
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
  val port = gatewayPort(uri.port, defaultPort) ?: return GatewayEndpointParseResult(error = GatewayEndpointValidationError.INVALID_URL)
  val contextPath = normalizeGatewayContextPath(uri.rawPath)
  val displayHost = if (host.contains(":")) "[$host]" else host
  val displayPortSuffix = if (tls && port == defaultPort) "" else ":$port"
  val displayUrl = "${if (tls) "https" else "http"}://$displayHost$displayPortSuffix$contextPath"

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

internal fun decodeGatewaySetupCode(rawInput: String): GatewaySetupCode? {
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
    val obj = parseJsonParamsObject(decoded) ?: return null
    val url = obj.nonBlankString("url").orEmpty()
    if (url.isEmpty()) return null
    val bootstrapToken = obj.nonBlankString("bootstrapToken")
    val token = obj.nonBlankString("token")
    val password = obj.nonBlankString("password")
    GatewaySetupCode(url = url, bootstrapToken = bootstrapToken, token = token, password = password)
  } catch (_: IllegalArgumentException) {
    null
  }
}

internal fun manualTokenLooksLikeSetupCode(rawInput: String): Boolean = resolveSetupCodeCandidate(rawInput)?.let(::decodeGatewaySetupCode) != null

internal fun resolveScannedSetupCodeResult(rawInput: String): GatewayScannedSetupCodeResult {
  val setupCode =
    resolveSetupCodeCandidate(rawInput)
      ?: return GatewayScannedSetupCodeResult(error = GatewayEndpointValidationError.INVALID_URL)
  val decoded =
    decodeGatewaySetupCode(setupCode)
      ?: return GatewayScannedSetupCodeResult(error = GatewayEndpointValidationError.INVALID_URL)
  val parsed = parseGatewayEndpointResult(decoded.url)
  if (parsed.config == null) {
    return GatewayScannedSetupCodeResult(error = parsed.error)
  }
  return GatewayScannedSetupCodeResult(setupCode = setupCode)
}

internal fun gatewayEndpointValidationMessage(
  error: GatewayEndpointValidationError,
  source: GatewayEndpointInputSource,
): String = gatewayEndpointValidationText(error, source).resolveNativeText()

internal fun gatewayEndpointValidationText(
  error: GatewayEndpointValidationError,
  source: GatewayEndpointInputSource,
): NativeText =
  when (error) {
    GatewayEndpointValidationError.INSECURE_REMOTE_URL -> source.insecureRemoteText
    GatewayEndpointValidationError.IPV6_ZONE_ID_UNSUPPORTED -> source.ipv6ZoneIdText
    GatewayEndpointValidationError.INVALID_URL -> source.invalidUrlText
  }

private const val defaultManualGatewayPort = 18789
private const val tailnetTlsGatewayPort = 443

private fun gatewayPort(
  port: Int,
  defaultPort: Int,
): Int? =
  when {
    port == -1 -> defaultPort
    port in 1..65535 -> port
    else -> null
  }

/** Resolves the manual port default shared by onboarding, settings, and the Connect tab. */
internal fun resolveDefaultManualGatewayPort(
  hostInput: String,
  tls: Boolean,
): Int {
  val host =
    hostInput
      .trim()
      .trimEnd('/')
      .removeSuffix(".")
      .lowercase(Locale.US)
  return if (tls && host.endsWith(".ts.net")) tailnetTlsGatewayPort else defaultManualGatewayPort
}

/** Parses manual authorities before formatting so host:port is not mistaken for IPv6. */
private fun resolveGatewayManualAuthority(hostInput: String): URI? {
  val authority = hostInput.trim().trimEnd('/')
  if (authority.isEmpty() || authority.contains('/')) return null

  val normalizedAuthority =
    if (!authority.startsWith("[") && authority.count { it == ':' } > 1) {
      "[$authority]"
    } else {
      authority
    }
  val uri = runCatching { URI("http://$normalizedAuthority") }.getOrNull() ?: return null
  // This field owns only a host and optional port. Dropping user-info or
  // query/fragment components could quietly connect credentials to another host.
  if (
    uri.host.isNullOrEmpty() ||
    uri.rawUserInfo != null ||
    uri.rawQuery != null ||
    uri.rawFragment != null ||
    uri.rawPath.isNotEmpty()
  ) {
    return null
  }

  val hasExplicitPort =
    if (normalizedAuthority.startsWith("[")) {
      normalizedAuthority.substringAfter(']', "").startsWith(':')
    } else {
      normalizedAuthority.contains(':')
    }
  if (hasExplicitPort && uri.port !in 1..65535) return null
  return uri
}

/** Builds a URL from manual host/port/tls fields for shared endpoint parsing. */
internal fun composeGatewayManualUrl(
  hostInput: String,
  portInput: String,
  tls: Boolean,
): String? {
  val host = hostInput.trim()
  if (host.isEmpty()) return null
  // A pasted endpoint is already a complete authority; its scheme and port
  // must not be silently replaced by stale values from the separate controls.
  if (host.contains("://")) {
    val parsed = parseGatewayEndpointResult(host)
    return host.takeUnless { parsed.error == GatewayEndpointValidationError.INVALID_URL }
  }
  val authority = resolveGatewayManualAuthority(host) ?: return null
  val bareHost = authority.host.trim('[', ']')
  val port =
    if (authority.port != -1) {
      authority.port
    } else {
      val portTrimmed = portInput.trim()
      if (portTrimmed.isEmpty()) {
        resolveDefaultManualGatewayPort(bareHost, tls)
      } else {
        portTrimmed.toIntOrNull() ?: return null
      }
    }
  if (port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://${ai.openclaw.app.gateway.formatGatewayAuthority(bareHost, port)}"
}

/** Keeps manual transport controls aligned with the runtime's remote-host TLS policy. */
internal fun gatewayManualTransportPresentation(
  hostInput: String,
  requestedTls: Boolean,
): GatewayManualTransportPresentation {
  val host = hostInput.trim()
  if (host.isEmpty()) {
    return GatewayManualTransportPresentation(
      requiresTls = false,
      effectiveTls = requestedTls,
    )
  }

  if (host.contains("://")) {
    val config = parseGatewayEndpointResult(host).config
    if (config != null) {
      return GatewayManualTransportPresentation(
        requiresTls = !isLocalCleartextGatewayHost(config.host),
        effectiveTls = config.tls,
      )
    }
  }

  val normalizedHost =
    resolveGatewayManualAuthority(host)?.host?.trim('[', ']')
      ?: host.trimEnd('/')
  val requiresTls = !isLocalCleartextGatewayHost(normalizedHost)
  return GatewayManualTransportPresentation(
    requiresTls = requiresTls,
    effectiveTls = requestedTls || requiresTls,
  )
}

private fun resolveSetupCodeCandidate(rawInput: String): String? {
  val trimmed = rawInput.trim()
  if (trimmed.isEmpty()) return null
  val qrSetupCode = parseJsonParamsObject(trimmed).nonBlankString("setupCode")
  return qrSetupCode ?: trimmed
}

private const val PAIRING_SETUP_URL_PREFIX = "oc-pair://"

private fun stripPairingSetupUrlPrefix(raw: String): String =
  if (raw.startsWith(PAIRING_SETUP_URL_PREFIX, ignoreCase = true)) {
    raw.substring(PAIRING_SETUP_URL_PREFIX.length)
  } else {
    raw
  }
