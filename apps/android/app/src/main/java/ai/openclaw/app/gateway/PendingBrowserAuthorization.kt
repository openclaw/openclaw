package ai.openclaw.app.gateway

import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.Response

/** A pending login is usable for a native handshake, never as an HTTP/media login by itself. */
internal class PendingBrowserAuthorization(
  private val target: HttpUrl,
  private val profileName: String,
  private val expectedCookie: String?,
  private val credentialEpoch: String? = null,
  private val current: () -> Boolean,
  private val accepted: () -> Boolean,
  private val cookieHeader: (HttpUrl) -> String?,
  private val receiveCookies: (HttpUrl, List<String>) -> Unit,
  private val acceptOperator: suspend (() -> Boolean) -> Boolean,
) : GatewayIngressAuthorization {
  private val delegate = BrowserSessionAuthorization(target, { url -> if (accepted()) cookieHeader(url) else expectedCookie }, ::isCurrent, receiveCookies)

  override fun deviceCredentialScope(gatewayId: String): String = "$gatewayId.browser.$profileName" + (credentialEpoch?.let { ".$it" } ?: "")

  override suspend fun authorizeUpgrade(request: Request): Request = delegate.authorizeUpgrade(request)

  private fun isCurrent(): Boolean = current() && (accepted() || expectedCookie == cookieHeader(target))

  override suspend fun admitGatewayRole(
    role: String,
    isCurrentNative: () -> Boolean,
  ): Boolean {
    if (!isCurrent() || !isCurrentNative()) return false
    // Node grants can settle in this isolated credential epoch (including bootstrap handoff),
    // but only an operator admission can activate the browser login or finish its UI.
    return if (role == "operator") acceptOperator { isCurrent() && isCurrentNative() } else isCurrent() && isCurrentNative()
  }

  override fun authorizeHttp(request: Request): Request {
    if (!accepted()) throw GatewayExternalAuthorizationException()
    return delegate.authorizeHttp(request)
  }

  override fun requireCurrent(request: Request) = delegate.requireCurrent(request)

  override fun receiveResponse(response: Response) = delegate.receiveResponse(response)

  override fun mediaHeaders(upgradeHeaders: Map<String, String>): Map<String, String> = delegate.mediaHeaders(upgradeHeaders)

  override fun rejection(response: Response): GatewayExternalAuthorizationException? = delegate.rejection(response)
}
