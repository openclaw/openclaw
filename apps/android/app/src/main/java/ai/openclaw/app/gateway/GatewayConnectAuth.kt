package ai.openclaw.app.gateway

data class GatewayConnectAuth(
  val token: String?,
  val bootstrapToken: String?,
  val password: String?,
)

data class GatewayTrustPrompt(
  val endpoint: GatewayEndpoint,
  val fingerprintSha256: String,
  val auth: GatewayConnectAuth,
)

internal fun resolveOperatorSessionConnectAuth(
  auth: GatewayConnectAuth,
  storedOperatorToken: String?,
): GatewayConnectAuth? {
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitToken != null) {
    return GatewayConnectAuth(
      token = explicitToken,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitPassword != null) {
    return GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = explicitPassword,
    )
  }

  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken != null) {
    // Bootstrap can seed the operator token, but operator should reconnect
    // through the stored device-token path rather than bootstrap auth itself.
    return GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitBootstrapToken = auth.bootstrapToken?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitBootstrapToken != null) {
    return GatewayConnectAuth(
      token = null,
      bootstrapToken = explicitBootstrapToken,
      password = null,
    )
  }

  return null
}

internal fun shouldConnectOperatorSession(
  auth: GatewayConnectAuth,
  storedOperatorToken: String?,
): Boolean {
  return resolveOperatorSessionConnectAuth(auth, storedOperatorToken) != null
}
