package ai.openclaw.app.gateway

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.util.Locale

/** Access credentials belong to an exact HTTPS authority, independently from Gateway pairing. */
internal data class CloudflareAccessOrigin private constructor(
  val uri: URI,
) {
  fun contains(url: String): Boolean =
    runCatching {
      val resource = URI(url)
      if (resource.rawUserInfo != null || resource.rawFragment != null) return false
      from(URI(resource.scheme, null, resource.host, resource.port, resource.path, null, null).toString()) == this
    }.getOrDefault(false)

  companion object {
    fun from(url: String): CloudflareAccessOrigin {
      val parsed = runCatching { URI(url) }.getOrNull()
      val scheme = parsed?.scheme?.lowercase(Locale.ROOT)
      val host = parsed?.host?.lowercase(Locale.ROOT)
      if (
        url.length > 4096 || parsed == null || scheme !in setOf("https", "wss") || host.isNullOrEmpty() ||
        parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null ||
        (parsed.port != -1 && parsed.port !in 1..65535)
      ) {
        throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidGateway)
      }
      return CloudflareAccessOrigin(URI("https", null, host, if (parsed.port == 443) -1 else parsed.port, null, null, null))
    }
  }
}

internal data class CloudflareAccessApplication(
  val origin: CloudflareAccessOrigin,
  val issuer: URI,
  val audience: String,
)

internal class CloudflareAccessSession(
  val application: CloudflareAccessApplication,
  val subject: String,
  val expiresAt: Double,
  private val token: String,
) {
  fun authorizationHeader(
    url: String,
    now: Double = System.currentTimeMillis() / 1000.0,
  ): String? = token.takeIf { application.origin.contains(url) && expiresAt > now }

  fun validate(now: Double = System.currentTimeMillis() / 1000.0) {
    val claims = CloudflareAccessJWT.appClaims(token, application, now)
    if (claims.subject != subject || claims.expiresAt != expiresAt) {
      throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
    }
  }

  fun encode(): String =
    Json.encodeToString(
      Stored(application.origin.uri.toString(), application.issuer.toString(), application.audience, subject, expiresAt, token),
    )

  override fun toString(): String = "CloudflareAccessSession(<redacted>)"

  @Serializable
  private class Stored(
    val origin: String,
    val issuer: String,
    val audience: String,
    val subject: String,
    val expiresAt: Double,
    val token: String,
  )

  companion object {
    fun decode(value: String): CloudflareAccessSession {
      if (value.length > 65536) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
      val stored = Json.decodeFromString<Stored>(value)
      return CloudflareAccessSession(
        CloudflareAccessApplication(CloudflareAccessOrigin.from(stored.origin), URI(stored.issuer), stored.audience),
        stored.subject,
        stored.expiresAt,
        stored.token,
      )
    }
  }
}

internal class CloudflareAccessException(
  val kind: Kind,
) : Exception(kind.description) {
  enum class Kind(
    val description: String,
  ) {
    InvalidGateway("Enter an HTTPS gateway address without credentials, a query, or a fragment."),
    InvalidApplication("This gateway did not provide valid Cloudflare Access sign-in details. Contact its administrator."),
    ConnectionFailed("Could not reach the gateway’s sign-in service. Check your connection and try again."),
    LoginFailed("Browser sign-in did not complete. Check that your account can access this gateway and try again."),
    TimedOut("Browser sign-in timed out. Start sign-in again to continue."),
    InvalidSession("The Cloudflare Access session could not be verified or has expired. Sign in again."),
    StorageFailed("Could not save the sign-in session securely. Unlock this device and try again."),
  }
}
