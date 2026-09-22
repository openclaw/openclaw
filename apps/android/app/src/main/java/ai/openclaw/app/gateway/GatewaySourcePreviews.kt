package ai.openclaw.app.gateway

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.io.IOException
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
    (controlUi?.get("basePath") as? JsonPrimitive)
      ?.takeIf { it.isString }
      ?.content
      .orEmpty()
      .trim()
      .trim('/')
  // The native Control UI URL owns the mount; explicit prefixes share its encoded representation.
  val location = controlUiUrl.toHttpUrlOrNull()?.newBuilder() ?: return null
  if (basePath.isNotEmpty()) location.encodedPath("/$basePath")
  val publicOrigin = (gateway?.get("publicOrigin") as? JsonPrimitive)?.takeIf { it.isString }?.content
  return GatewaySourcePreviewConfig(
    gatewayUrl = controlUiUrl,
    basePath = location.build().encodedPath.trimEnd('/'),
    publicOrigin = publicOrigin,
    automaticallyFetchFavicons = controlUi?.get("automaticallyFetchFavicons") != JsonPrimitive(false),
    generation = generation,
  )
}

/** The Gateway owns remote favicon fetching; this client only reads its authenticated image route. */
internal class GatewaySourceFaviconLoader(
  client: OkHttpClient,
) {
  private val client =
    client
      .newBuilder()
      .followRedirects(false)
      .followSslRedirects(false)
      .build()
  private val cache =
    object : LinkedHashMap<String, GatewayLoadedImage?>(32, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GatewayLoadedImage?>?): Boolean = size > 32
    }
  private val mutex = kotlinx.coroutines.sync.Mutex()

  suspend fun load(
    gatewayUrl: String,
    basePath: String,
    hostname: String,
    headers: Map<String, String>,
    credentials: List<String>,
    withEnqueue: (() -> Unit) -> Unit,
  ): GatewayLoadedImage? {
    val origin = gatewayUrl.toHttpUrlOrNull() ?: return null
    val host = "https://$hostname/".toHttpUrlOrNull()?.takeIf { it.host == hostname && it.username.isEmpty() && it.password.isEmpty() && it.encodedPath == "/" }?.host ?: return null
    val path = "$basePath/__openclaw__/link-favicon/$host"
    val url =
      origin
        .newBuilder()
        .encodedPath(path)
        .query(null)
        .fragment(null)
        .build()
    val key = url.toString()
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
        // A trusted proxy can authorize HTTP itself, even when hello also issued a device token.
        baseRequest.header("Authorization")?.let(::add)
        credentials.forEach { add("Bearer $it") }
        if (isEmpty()) add(null)
      }.distinct()
    mutex.lock()
    try {
      if (cache.containsKey(key)) return cache[key]
      for (authorization in authorizations) {
        val request = baseRequest.newBuilder()
        authorization?.let { request.header("Authorization", it) }
        val response = fetch(request.build(), withEnqueue)
        if (response.first == 401 || response.first == 403) continue
        cache[key] = response.second
        return response.second
      }
      cache[key] = null
      return null
    } finally {
      mutex.unlock()
    }
  }

  private suspend fun fetch(
    request: Request,
    withEnqueue: (() -> Unit) -> Unit,
  ): Pair<Int, GatewayLoadedImage?> =
    suspendCancellableCoroutine { continuation ->
      val call = client.newCall(request)
      call.timeout().timeout(8, TimeUnit.SECONDS)
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
                      val mime = body.contentType()?.let { "${it.type}/${it.subtype}" } ?: return@runCatching null
                      if (mime !in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon")) return@runCatching null
                      if (body.contentLength() > 65_536) return@runCatching null
                      val buffer = Buffer()
                      val source = body.source()
                      while (continuation.isActive && buffer.size <= 65_536) {
                        if (source.read(buffer, minOf(8_192, 65_537 - buffer.size)) == -1L) break
                      }
                      if (!continuation.isActive || buffer.size > 65_536) null else GatewayLoadedImage(buffer.readByteArray(), mime)
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
