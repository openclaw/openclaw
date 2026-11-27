package ai.openclaw.app.gateway

/**
 * Structured gateway error details, preserved for reconnect, authorization, and UI decisions.
 */
data class GatewayErrorDetails(
  val code: String?,
  val canRetryWithDeviceToken: Boolean,
  val recommendedNextStep: String?,
  val pauseReconnect: Boolean? = null,
  val reason: String? = null,
  val method: String? = null,
  val requestId: String? = null,
  val retryable: Boolean = false,
  val clientMinProtocol: Int? = null,
  val clientMaxProtocol: Int? = null,
  val expectedProtocol: Int? = null,
  val minimumProbeProtocol: Int? = null,
  val clawhubWarning: String? = null,
  val missingScope: String? = null,
  val requiredScopes: List<String> = emptyList(),
  val retryAfterMs: Int? = null,
)

data class GatewayMissingScopeErrorDetails(
  val missingScope: String,
  val requiredScopes: List<String>,
)

private val legacyMissingScopePattern = Regex("\\bmissing scope:\\s*([a-z0-9._-]+)", RegexOption.IGNORE_CASE)

data class InvokeResult(
  val ok: Boolean,
  val payloadJson: String?,
  val error: ErrorShape?,
) {
  companion object {
    fun ok(payloadJson: String?) = InvokeResult(ok = true, payloadJson = payloadJson, error = null)

    fun error(
      code: String,
      message: String,
    ) = InvokeResult(ok = false, payloadJson = null, error = ErrorShape(code = code, message = message))
  }
}

data class ErrorShape(
  val code: String,
  val message: String,
  val details: GatewayErrorDetails? = null,
  val retryable: Boolean = false,
  val retryAfterMs: Int? = details?.retryAfterMs,
) {
  /** Only the method-bound startup refusal proves this chat send did no handler work. */
  fun startupRetryDelayMs(method: String): Long? {
    if (
      method != "chat.send" || code != "UNAVAILABLE" || !retryable ||
      details?.reason != "startup-sidecars" || details.method != method
    ) {
      return null
    }
    return (details.retryAfterMs ?: 500).coerceIn(100, 2_000).toLong()
  }

  fun missingScopeDetails(): GatewayMissingScopeErrorDetails? {
    val details = details ?: return null
    val missingScope = details.missingScope?.trim().orEmpty()
    val requiredScopes = details.requiredScopes.map { it.trim() }
    if (details.code != "MISSING_SCOPE" || missingScope.isEmpty() || requiredScopes.any { it.isEmpty() }) {
      return null
    }
    return requiredScopes.takeIf { it.isNotEmpty() }?.let {
      GatewayMissingScopeErrorDetails(missingScope = missingScope, requiredScopes = it)
    }
  }

  fun missingScope(): String? {
    missingScopeDetails()?.let { return it.missingScope }
    if (code != "FORBIDDEN" && code != "INVALID_REQUEST") return null
    return legacyMissingScopePattern.find(message)?.groupValues?.getOrNull(1)
  }
}

/**
 * Structured RPC result used by callers that need error codes without exceptions.
 */
data class RpcResult(
  val ok: Boolean,
  val payloadJson: String?,
  val error: ErrorShape?,
)
