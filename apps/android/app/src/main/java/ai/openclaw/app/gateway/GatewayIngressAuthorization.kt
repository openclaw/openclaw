package ai.openclaw.app.gateway

import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/** One immutable grant owned by a physical upgrade transaction and its media capabilities. */
interface GatewayIngressAuthorization {
  /** Internal same-request upgrade retries retain this grant; its owner cancels and drains the socket on retirement. */
  suspend fun authorizeUpgrade(request: Request): Request

  /** Synchronous check at upgrade admission and each HTTP/media exchange, including range retries. */
  fun requireCurrent(request: Request)

  /** Recognizes only an explicit ingress challenge; ordinary Gateway failures remain separate. */
  fun rejection(response: Response): GatewayExternalAuthorizationException?
}

class GatewayExternalAuthorizationException(
  message: String = "Sign in to the gateway's access provider to reconnect.",
) : IOException(message)
