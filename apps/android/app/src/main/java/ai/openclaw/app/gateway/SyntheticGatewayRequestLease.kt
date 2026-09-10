package ai.openclaw.app.gateway

/** Adapts phone replay/screenshot transports that do not own a physical gateway socket. */
internal fun syntheticGatewayRequestLease(
  endpointStableId: String,
  isCurrentImpl: () -> Boolean = { true },
  commitIfCurrentImpl: ((block: () -> Unit) -> Boolean)? = null,
  requestImpl: suspend (method: String, paramsJson: String?, timeoutMs: Long, withEnqueue: (() -> Unit) -> Unit) -> String,
): GatewaySession.RequestLease =
  object : GatewaySession.RequestLease {
    override val endpointStableId = endpointStableId

    override fun isCurrent(): Boolean = isCurrentImpl()

    override fun commitIfCurrent(block: () -> Unit): Boolean {
      commitIfCurrentImpl?.let { return it(block) }
      if (!isCurrentImpl()) return false
      block()
      return true
    }

    override suspend fun request(
      method: String,
      paramsJson: String?,
      timeoutMs: Long,
      withEnqueue: (() -> Unit) -> Unit,
    ): String = requestImpl(method, paramsJson, timeoutMs, withEnqueue)
  }
