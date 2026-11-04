package ai.openclaw.app.gateway

import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.Response

/** Browser cookies stay in the browser store. Resolve them for each actual request, never a base URL. */
internal class BrowserSessionAuthorization(
  private val origin: HttpUrl,
  private val cookies: (HttpUrl) -> String?,
  private val isCurrent: () -> Boolean,
  private val receiveCookies: (HttpUrl, List<String>) -> Unit = { _, _ -> },
) : GatewayIngressAuthorization {
  override suspend fun authorizeUpgrade(request: Request): Request = authorizeHttp(request)

  override fun authorizeHttp(request: Request): Request {
    requireCurrent(request)
    val cookie =
      cookies(request.url)?.takeIf { it.isNotBlank() }
        ?: throw GatewayExternalAuthorizationException()
    return request
      .newBuilder()
      .removeHeader("Cookie")
      .header("Cookie", cookie)
      .build()
  }

  override fun receiveResponse(response: Response) {
    requireCurrent(response.request)
    receiveCookies(response.request.url, response.headers("Set-Cookie"))
  }

  override fun mediaHeaders(upgradeHeaders: Map<String, String>): Map<String, String> = upgradeHeaders.filterKeys { !it.equals("Cookie", ignoreCase = true) }

  override fun requireCurrent(request: Request) {
    val url = request.url
    if (!isCurrent() || url.scheme != "https" || url.host != origin.host || url.port != origin.port) {
      throw GatewayExternalAuthorizationException()
    }
  }

  override fun rejection(response: Response): GatewayExternalAuthorizationException? {
    // Forward-auth has no universal challenge header. Off-origin login redirects and HTML
    // authentication failures are browser challenges; ordinary Gateway JSON errors are not.
    val redirect = response.header("Location")?.let(response.request.url::resolve)
    val loginRedirect =
      response.code in 300..399 && redirect != null &&
        (redirect.scheme != "https" || redirect.host != origin.host || redirect.port != origin.port)
    val htmlFailure =
      response.code in listOf(401, 403) &&
        response
          .header("Content-Type")
          .orEmpty()
          .substringBefore(';')
          .trim()
          .equals("text/html", true)
    return if (loginRedirect || htmlFailure) GatewayExternalAuthorizationException() else null
  }
}

internal fun HttpUrl.browserSessionOrigin(): String =
  newBuilder()
    .encodedPath("/")
    .query(null)
    .fragment(null)
    .build()
    .toString()
