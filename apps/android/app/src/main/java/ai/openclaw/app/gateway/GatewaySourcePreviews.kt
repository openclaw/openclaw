package ai.openclaw.app.gateway

import ai.openclaw.app.asJsonStringOrNull
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Accepted Gateway config and connection generation; never persisted as a second config owner. */
data class GatewaySourcePreviewConfig(
  val gatewayUrl: String,
  val basePath: String,
  val publicOrigin: String?,
  val automaticallyFetchFavicons: Boolean,
  val generation: Long,
)

internal fun resolveGatewaySourcePreviewConfig(
  config: JsonObject?,
  controlUiUrl: String,
  generation: Long,
): GatewaySourcePreviewConfig? {
  if (config == null) return null
  val gateway = config["gateway"] as? JsonObject
  val controlUi = gateway?.get("controlUi") as? JsonObject
  val basePath =
    controlUi
      ?.get("basePath")
      .asJsonStringOrNull()
      .orEmpty()
      .trim()
      .trim('/')
  // The native Control UI URL owns the mount; explicit prefixes share its encoded representation.
  val location = controlUiUrl.toHttpUrlOrNull()?.newBuilder() ?: return null
  if (basePath.isNotEmpty()) location.encodedPath("/$basePath")
  val publicOrigin = gateway?.get("publicOrigin").asJsonStringOrNull()
  return GatewaySourcePreviewConfig(
    gatewayUrl = controlUiUrl,
    basePath = location.build().encodedPath.trimEnd('/'),
    publicOrigin = publicOrigin,
    automaticallyFetchFavicons = controlUi?.get("automaticallyFetchFavicons") != JsonPrimitive(false),
    generation = generation,
  )
}

/** Reads Gateway-owned image routes with the current connection's HTTP policy and credentials. */
internal class GatewayImageLoader(
  client: OkHttpClient,
) {
  private val client =
    client
      .newBuilder()
      .followRedirects(false)
      .followSslRedirects(false)
      .build()
  private val faviconCache =
    object : LinkedHashMap<String, GatewayLoadedImage?>(32, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GatewayLoadedImage?>?): Boolean = size > 32
    }
  private val mutex = kotlinx.coroutines.sync.Mutex()

  suspend fun loadFavicon(
    gatewayUrl: String,
    basePath: String,
    hostname: String,
    headers: Map<String, String>,
    credentials: List<String>,
    withEnqueue: (() -> Unit) -> Unit,
  ): GatewayLoadedImage? {
    val origin = gatewayUrl.toHttpUrlOrNull() ?: return null
    val host = "https://$hostname/".toHttpUrlOrNull()?.takeIf { it.host == hostname && it.username.isEmpty() && it.password.isEmpty() && it.encodedPath == "/" }?.host ?: return null
    val url =
      origin
        .newBuilder()
        .encodedPath("$basePath/__openclaw__/link-favicon/$host")
        .query(null)
        .fragment(null)
        .build()
    val key = url.toString()
    return mutex.withLock {
      if (faviconCache.containsKey(key)) return@withLock faviconCache[key]
      load(url, headers, credentials, 65_536, 8, withEnqueue) { mime ->
        mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon")
      }.also { faviconCache[key] = it }
    }
  }

  suspend fun loadInboundImage(
    gatewayUrl: String,
    basePath: String,
    source: String,
    sessionKey: String,
    agentId: String?,
    headers: Map<String, String>,
    credentials: List<String>,
    withEnqueue: (() -> Unit) -> Unit,
  ): GatewayLoadedImage? {
    if (!isInboundMediaSource(source)) return null
    val url =
      gatewayUrl
        .toHttpUrlOrNull()
        ?.newBuilder()
        ?.encodedPath("${basePath.trimEnd('/')}/__openclaw__/assistant-media")
        ?.query(null)
        ?.fragment(null)
        ?.addQueryParameter("source", source.trim())
        ?.addQueryParameter("sessionKey", sessionKey)
        ?.apply { agentId?.trim()?.takeIf(String::isNotEmpty)?.let { addQueryParameter("agentId", it) } }
        ?.build() ?: return null
    return load(url, headers, credentials, GatewayMediaKind.Image.maximumBufferedBytes, 20, withEnqueue) { mime ->
      mime.startsWith("image/") && mime != "image/svg+xml"
    }
  }

  private suspend fun load(
    url: HttpUrl,
    headers: Map<String, String>,
    credentials: List<String>,
    maximumBytes: Long,
    timeoutSeconds: Long,
    withEnqueue: (() -> Unit) -> Unit,
    acceptsMimeType: (String) -> Boolean,
  ): GatewayLoadedImage? {
    val baseRequest =
      Request
        .Builder()
        .url(url)
        .header("Accept", "image/*")
        .apply {
          headers.forEach { (name, value) -> header(name, value) }
        }.build()
    val authorizations =
      buildList<String?> {
        baseRequest.header("Authorization")?.let(::add)
        credentials.forEach { add("Bearer $it") }
        if (isEmpty()) add(null)
      }.distinct()
    for (authorization in authorizations) {
      val request = baseRequest.newBuilder()
      authorization?.let { request.header("Authorization", it) }
      val (code, image) = fetch(request.build(), maximumBytes, timeoutSeconds, acceptsMimeType, withEnqueue)
      if (code != 401 && code != 403) return image
    }
    return null
  }

  private suspend fun fetch(
    request: Request,
    maximumBytes: Long,
    timeoutSeconds: Long,
    acceptsMimeType: (String) -> Boolean,
    withEnqueue: (() -> Unit) -> Unit,
  ): Pair<Int, GatewayLoadedImage?> =
    suspendCancellableCoroutine { continuation ->
      val call = client.newCall(request)
      call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
      continuation.invokeOnCancellation { call.cancel() }
      withEnqueue {
        if (!continuation.isActive) return@withEnqueue
        call.enqueue(
          object : Callback {
            override fun onFailure(
              call: Call,
              e: IOException,
            ) {
              if (continuation.isActive) continuation.resume(0 to null)
            }

            override fun onResponse(
              call: Call,
              response: Response,
            ) {
              val result =
                response.use {
                  val image =
                    runCatching {
                      if (!response.isSuccessful) return@runCatching null
                      val body = response.body
                      val mime = body.contentType()?.let { "${it.type}/${it.subtype}".lowercase(Locale.ROOT) } ?: return@runCatching null
                      if (!acceptsMimeType(mime) || body.contentLength() > maximumBytes) return@runCatching null
                      val buffer = Buffer()
                      val source = body.source()
                      while (continuation.isActive && buffer.size <= maximumBytes) {
                        if (source.read(buffer, minOf(8_192, maximumBytes + 1 - buffer.size)) == -1L) break
                      }
                      if (!continuation.isActive || buffer.size > maximumBytes) null else GatewayLoadedImage(buffer.readByteArray(), mime)
                    }.getOrNull()
                  response.code to image
                }
              if (continuation.isActive) continuation.resume(result)
            }
          },
        )
      }
    }
}

private val INBOUND_MEDIA_SOURCE_REGEX = Regex("^media://inbound/([^/?#]+)$", RegexOption.IGNORE_CASE)

/** Only Gateway-projected, single-segment inbound references may reach assistant-media. */
internal fun isInboundMediaSource(source: String?): Boolean {
  val encoded =
    source
      ?.trim()
      ?.let(INBOUND_MEDIA_SOURCE_REGEX::matchEntire)
      ?.groupValues
      ?.get(1) ?: return false
  val id = runCatching { URLDecoder.decode(encoded, Charsets.UTF_8.name()) }.getOrNull() ?: return false
  return id != "." && id != ".." && '/' !in id && '\\' !in id && '\u0000' !in id
}
