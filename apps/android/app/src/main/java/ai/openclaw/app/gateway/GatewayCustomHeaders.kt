package ai.openclaw.app.gateway

/**
 * Operator-defined HTTP headers attached to gateway connections so gateways fronted by
 * authenticating reverse proxies (Cloudflare Access-style service tokens) stay reachable.
 * Header values are credentials: persist them only in SecurePrefs and never log them.
 */
object GatewayCustomHeaders {
  // Connection-management headers the WebSocket upgrade owns. Operator overrides here would
  // corrupt the handshake or duplicate fields OkHttp sets itself.
  private val reservedNames =
    setOf("connection", "content-length", "host", "proxy-connection", "upgrade")
  private const val RESERVED_PREFIX = "sec-websocket-"
  private const val TOKEN_PUNCTUATION = "!#$%&'*+-.^_`|~"

  enum class Rejection { INVALID_NAME, RESERVED_NAME, INVALID_VALUE }

  private fun isReservedName(name: String): Boolean {
    val normalized = name.trim().lowercase()
    return normalized in reservedNames || normalized.startsWith(RESERVED_PREFIX)
  }

  /**
   * Rejects entries that cannot travel as a single well-formed header: empty, reserved, or
   * non-token names, and values outside printable ASCII. Editors show the reason; [sanitized]
   * drops the entry.
   */
  fun rejection(
    name: String,
    value: String,
  ): Rejection? {
    val trimmed = name.trim()
    return when {
      trimmed.isEmpty() -> Rejection.INVALID_NAME
      isReservedName(trimmed) -> Rejection.RESERVED_NAME
      !trimmed.all(::isTokenCharacter) -> Rejection.INVALID_NAME
      !value.all { it in ' '..'~' } -> Rejection.INVALID_VALUE
      else -> null
    }
  }

  /**
   * Keeps only entries [rejection] accepts. Dropping invalid entries keeps one bad stored value
   * from wedging every reconnect or being interpreted differently by a proxy.
   */
  fun sanitized(headers: Map<String, String>): Map<String, String> {
    val result = LinkedHashMap<String, String>()
    for ((rawName, value) in headers) {
      if (rejection(rawName, value) != null) continue
      result[rawName.trim()] = value
    }
    return result
  }

  enum class CredentialShape { CLIENT_ID, SECRET }

  // Cloudflare Access service token values. Secrets are 64 hex characters, or cfast_ for tokens
  // created since 2026-08-26.
  private val clientIdName = Regex("[0-9a-f]{32}\\.access", RegexOption.IGNORE_CASE)
  private val legacySecretName = Regex("[0-9a-f]{64}", RegexOption.IGNORE_CASE)

  /**
   * Recognizes a credential typed where a header name belongs. Such names pass [rejection] and
   * would be stored and shown unmasked, so editors refuse them while [sanitized] keeps existing
   * entries visible for removal.
   */
  fun credentialShape(name: String): CredentialShape? {
    // Quotes, backticks, and sentence periods copied with a token are legal name characters.
    val trimmed = name.trim().trim { it in TOKEN_PUNCTUATION }
    return when {
      clientIdName.matches(trimmed) -> CredentialShape.CLIENT_ID
      legacySecretName.matches(trimmed) || trimmed.startsWith("cfast_", ignoreCase = true) -> CredentialShape.SECRET
      else -> null
    }
  }

  private fun isTokenCharacter(character: Char): Boolean =
    character in '0'..'9' ||
      character in 'A'..'Z' ||
      character in 'a'..'z' ||
      character in TOKEN_PUNCTUATION
}
