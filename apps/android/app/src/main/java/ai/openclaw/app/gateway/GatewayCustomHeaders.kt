package ai.openclaw.app.gateway

import ai.openclaw.mobile.core.GatewayCustomHeaders as SharedGatewayCustomHeaders
import ai.openclaw.mobile.core.HeaderValuePolicy

/**
 * Operator-defined HTTP headers attached to gateway connections so gateways fronted by
 * authenticating reverse proxies (Cloudflare Access-style service tokens) stay reachable.
 * Header values are credentials: persist them only in SecurePrefs and never log them.
 */
object GatewayCustomHeaders {
  fun isReservedName(name: String): Boolean = SharedGatewayCustomHeaders.isReservedName(name)

  /**
   * Drops entries that cannot travel as a single well-formed header: empty, reserved, or
   * non-token names, and values outside printable ASCII. Dropping invalid entries keeps one bad
   * stored value from wedging every reconnect or being interpreted differently by a proxy.
   */
  fun sanitized(headers: Map<String, String>): Map<String, String> =
    SharedGatewayCustomHeaders.sanitized(headers, HeaderValuePolicy.ASCII_PRINTABLE)
}
