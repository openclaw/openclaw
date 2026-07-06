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

  fun isReservedName(name: String): Boolean {
    val normalized = name.trim().lowercase()
    return normalized in reservedNames || normalized.startsWith(RESERVED_PREFIX)
  }

  /**
   * Drops entries that cannot travel as a single well-formed header: empty or reserved names,
   * and names/values outside printable ASCII. OkHttp throws IllegalArgumentException on such
   * characters, so dropping here keeps one bad stored entry from wedging every reconnect.
   */
  fun sanitized(headers: Map<String, String>): Map<String, String> {
    val result = LinkedHashMap<String, String>()
    for ((rawName, value) in headers) {
      val name = rawName.trim()
      if (name.isEmpty() || isReservedName(name)) continue
      if (!name.all { it in '!'..'~' }) continue
      if (!value.all { it in ' '..'~' }) continue
      result[name] = value
    }
    return result
  }
}
