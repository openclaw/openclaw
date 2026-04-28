package ai.openclaw.android.gateway

/**
 * URL formatting helpers for gateway endpoint addresses,
 * including IPv6 bracket wrapping.
 */
object GatewayUrlHelpers {
  fun normalizeGatewayHost(host: String): String {
    return host.trim().removePrefix("[").removeSuffix("]")
  }

  fun formatHostForUrlAuthority(host: String): String {
    val trimmedHost = normalizeGatewayHost(host)
    if (trimmedHost.isEmpty()) return trimmedHost
    return if (':' in trimmedHost) {
      "[$trimmedHost]"
    } else {
      trimmedHost
    }
  }

  fun buildGatewayUrl(scheme: String, host: String, port: Int, defaultPort: Int? = null): String {
    val authority = formatHostForUrlAuthority(host)
    return if (defaultPort != null && port == defaultPort) {
      "$scheme://$authority"
    } else {
      "$scheme://$authority:$port"
    }
  }
}
