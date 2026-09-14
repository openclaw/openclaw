package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class CloudflareAccessClient(
  private val request: suspend (Request, Int, Long) -> Reply = ::send,
) {
  class Reply(
    val url: String,
    val code: Int,
    val headers: Headers,
    val body: ByteArray,
  )

  /** A metadata 200 proves protection, not that the current WARP/manual-header session needs login. */
  suspend fun discover(
    gatewayUrl: String,
    session: CloudflareAccessSession? = null,
    customHeaders: Map<String, String> = emptyMap(),
  ): CloudflareAccessApplication? {
    val origin = CloudflareAccessOrigin.from(gatewayUrl)
    val url = gatewayUrl.replaceFirst(Regex("^wss:", RegexOption.IGNORE_CASE), "https:")
    val probe = Request.Builder().url(url)
    GatewayCustomHeaders.sanitized(customHeaders).forEach { (name, value) -> probe.header(name, value) }
    session?.authorizationHeader(url)?.let { probe.header("Cf-Access-Token", it) }
    val response = request(probe.build(), 0, 15)
    if (!isChallenge(response, origin)) return null
    try {
      val metadata =
        request(
          Request
            .Builder()
            .url(url)
            .head()
            .header("Cf-Access-Metadata-Request", "true")
            .header("User-Agent", userAgent)
            .build(),
          0,
          15,
        )
      val token = metadata.headers["Cf-Access-Metadata"]
      if (metadata.code != 200 || token == null) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidApplication)
      val application = CloudflareAccessJWT.application(token, origin)
      CloudflareAccessJWT.verify(token, keys(application))
      return application
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidApplication)
    }
  }

  suspend fun verifiedSession(
    token: String,
    application: CloudflareAccessApplication,
  ): CloudflareAccessSession {
    CloudflareAccessJWT.verify(token, keys(application))
    val claims = CloudflareAccessJWT.appClaims(token, application)
    // get-identity consumes the Access cookie. Only this exact no-redirect request receives it;
    // native Gateway traffic projects Cf-Access-Token instead and never uses a cookie jar.
    val identity =
      request(
        Request
          .Builder()
          .url(
            application.origin.uri
              .resolve("/cdn-cgi/access/get-identity")
              .toString(),
          ).header("Cookie", "CF_Authorization=$token")
          .build(),
        maximumResponseBytes,
        15,
      )
    val subject =
      runCatching {
        (Json.parseToJsonElement(identity.body.decodeToString()).jsonObject["user_uuid"] as? JsonPrimitive)
          ?.takeIf(JsonPrimitive::isString)
          ?.content
      }.getOrNull()
    if (identity.code != 200 || subject != claims.subject) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
    kotlin.coroutines.coroutineContext.ensureActive()
    return CloudflareAccessSession(application, claims.subject, claims.expiresAt, token)
  }

  private suspend fun keys(application: CloudflareAccessApplication): ByteArray {
    if (CloudflareAccessJWT.issuer(application.issuer.host.orEmpty()) != application.issuer) {
      throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidApplication)
    }
    val response = request(Request.Builder().url(application.issuer.resolve("/cdn-cgi/access/certs").toString()).build(), maximumResponseBytes, 15)
    if (response.code != 200) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidApplication)
    return response.body
  }

  companion object {
    const val userAgent = "OpenClaw CloudflareAccess (cloudflared/2026.8.3)"
    const val maximumResponseBytes = 1_048_576
    private val client =
      OkHttpClient
        .Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .build()

    fun isChallenge(
      response: Reply,
      origin: CloudflareAccessOrigin,
    ): Boolean {
      if (response.code !in setOf(301, 302, 303, 307, 308, 401, 403) || !origin.contains(response.url)) return false
      val header = response.headers["WWW-Authenticate"] ?: return false
      if (header.length > 8192) return false
      val parts = header.split(Regex("\\s+"), limit = 2)
      if (parts.size != 2 || parts[0].lowercase() !in setOf("cloudflare-access", "bearer")) return false
      val metadata = Regex("(?:^|[,\\s])resource_metadata\\s*=\\s*\"([^\"]+)\"").find(parts[1])?.groupValues?.get(1) ?: return false
      if (!origin.contains(metadata)) return false
      val uri = java.net.URI(metadata)
      // RFC 9728 appends resource paths to the namespace. This only admits the
      // challenge; signed metadata is still requested from the original URL.
      val namespace = "/.well-known/cloudflare-access-protected-resource"
      return uri.scheme.equals("https", ignoreCase = true) && uri.rawQuery == null &&
        (uri.path == namespace || uri.path.startsWith("$namespace/"))
    }

    suspend fun send(
      request: Request,
      maximumBytes: Int,
      timeoutSeconds: Long,
    ): Reply =
      suspendCancellableCoroutine { continuation ->
        val call =
          client
            .newBuilder()
            .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .build()
            .newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(
          object : Callback {
            override fun onFailure(
              call: Call,
              e: IOException,
            ) {
              if (continuation.isActive) continuation.resumeWithException(CloudflareAccessException(CloudflareAccessException.Kind.ConnectionFailed))
            }

            override fun onResponse(
              call: Call,
              response: Response,
            ) {
              try {
                response.use {
                  if (response.request.url != request.url) throw IOException("Unexpected redirect")
                  val bytes =
                    if (maximumBytes == 0) {
                      byteArrayOf()
                    } else {
                      val source = response.body.source()
                      source.request(maximumBytes.toLong() + 1)
                      if (source.buffer.size > maximumBytes) throw IOException("Response exceeds limit")
                      source.readByteArray()
                    }
                  continuation.resume(Reply(response.request.url.toString(), response.code, response.headers, bytes))
                }
              } catch (_: Exception) {
                if (continuation.isActive) continuation.resumeWithException(CloudflareAccessException(CloudflareAccessException.Kind.ConnectionFailed))
              }
            }
          },
        )
      }
  }
}
