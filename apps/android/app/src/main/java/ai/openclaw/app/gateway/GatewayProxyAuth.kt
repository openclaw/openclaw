package ai.openclaw.app.gateway

import kotlinx.serialization.Serializable
import okhttp3.Credentials
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.Response

/** Proxy secrets never participate in Gateway protocol authentication or pairing. */
class GatewayProxyCredentials(
  val username: String,
  val password: String,
) {
  init {
    require(username.isNotBlank() && ':' !in username && username.none(::isProxyControlCharacter)) { "Enter a proxy username without colons or control characters." }
    require(password.isNotEmpty() && password.none(::isProxyControlCharacter)) { "Enter a proxy password without control characters." }
  }

  override fun toString(): String = "GatewayProxyCredentials([redacted])"
}

private fun isProxyControlCharacter(value: Char): Boolean = value.code < 0x20 || value.code == 0x7f

/**
 * A record without a password is a removed login that still binds the Gateway's proxy account.
 * [forgetPending] marks a Forget that has retired Gateway auth but not yet purged local data.
 */
@Serializable
internal class StoredGatewayProxyCredentials(
  val destination: String,
  val username: String,
  val password: String? = null,
  val version: Int = 1,
  val forgetPending: Boolean = false,
) {
  override fun toString(): String = "StoredGatewayProxyCredentials([redacted])"
}

/**
 * Proxy account a saved Gateway is bound to; once [locked], only Forget Gateway can switch accounts.
 * A null [username] is an unreadable binding, which a locked Gateway can only leave through Forget.
 */
internal class GatewayProxyPrincipal(
  val username: String?,
  val locked: Boolean,
) {
  fun admits(credentials: GatewayProxyCredentials?): Boolean = !locked || (username != null && (credentials == null || credentials.username == username))
}

internal enum class GatewayProxySaveResult { SAVED, ACCOUNT_LOCKED, FAILED }

/** Canonical HTTPS authority and exact mount; stable IDs alone do not encode TLS. */
internal fun gatewayProxyDestination(endpoint: GatewayEndpoint): HttpUrl {
  require(endpoint.tlsEnabled) { "Proxy login requires HTTPS with a verified certificate and hostname." }
  val path = endpoint.contextPath.ifEmpty { "/" }
  require(
    !path.contains('\\') && !path.contains("//") &&
      path.split('/').none { it == "." || it == ".." } &&
      !Regex("%(?:2e|2f|5c|25|00|0a|0d)", RegexOption.IGNORE_CASE).containsMatchIn(path),
  ) { "Confirm an unambiguous Gateway destination before configuring proxy login." }
  val destination =
    HttpUrl
      .Builder()
      .scheme("https")
      .host(endpoint.host)
      .port(endpoint.port)
      .encodedPath(path)
      .build()
  require(destination.encodedPath == path && destination.username.isEmpty() && destination.password.isEmpty()) { "Confirm the Gateway destination." }
  return destination
}

internal class GatewayBasicProxyAuthorization(
  endpoint: GatewayEndpoint,
  credentials: GatewayProxyCredentials,
  private val isCurrent: () -> Boolean,
) : GatewayIngressAuthorization {
  override val isProxyBasic: Boolean = true
  private val destination = gatewayProxyDestination(endpoint)
  private val mount = destination.encodedPath.trimEnd('/')
  private val authorization = Credentials.basic(credentials.username, credentials.password, Charsets.UTF_8)

  override suspend fun authorizeUpgrade(request: Request): Request {
    requireCurrent(request)
    if (request.header("Authorization") != null) {
      throw GatewayExternalAuthorizationException("Proxy login conflicts with an existing Authorization header.", "PROXY_AUTH_CONFLICT")
    }
    return request.newBuilder().header("Authorization", authorization).build()
  }

  override fun requireCurrent(request: Request) {
    val url = request.url
    val safePath = !Regex("%(?:2e|2f|5c|25|00|0a|0d)", RegexOption.IGNORE_CASE).containsMatchIn(url.encodedPath)
    if (!isCurrent() || !url.isHttps || url.host != destination.host || url.port != destination.port ||
      url.username.isNotEmpty() || url.password.isNotEmpty() || !safePath ||
      (url.encodedPath != mount && !url.encodedPath.startsWith("$mount/"))
    ) {
      throw GatewayExternalAuthorizationException("Proxy login destination or saved credentials changed. Reconnect to continue.", "PROXY_AUTH_RETIRED")
    }
  }

  override fun rejection(response: Response): GatewayExternalAuthorizationException? =
    when {
      response.code in 300..399 -> {
        GatewayExternalAuthorizationException("This address redirects. Confirm the Gateway address with its administrator.", "PROXY_REDIRECT")
      }

      response.code == 401 && response.challenges().any { it.scheme.equals("Basic", ignoreCase = true) } -> {
        GatewayExternalAuthorizationException("Proxy login was not accepted. Edit your proxy login, then retry.", "PROXY_AUTH_REQUIRED")
      }

      response.code == 401 || response.code == 403 -> {
        GatewayExternalAuthorizationException("Access was rejected before the Gateway connected (HTTP ${response.code}).", "HTTP_UPGRADE_REJECTED")
      }

      response.code == 407 -> {
        GatewayExternalAuthorizationException("This proxy authentication method is not supported.", "PROXY_AUTH_UNSUPPORTED")
      }

      else -> {
        null
      }
    }

  override fun toString(): String = "GatewayBasicProxyAuthorization([redacted])"
}
