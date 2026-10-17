package ai.openclaw.app.gateway

import ai.openclaw.app.asJsonStringOrNull
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Base64

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

/** The connected Gateway owns anonymous page-preview fetching; this loader consumes only its icon data. */
internal class GatewaySourceFaviconLoader {
  private val cache =
    object : LinkedHashMap<String, GatewayLoadedImage?>(32, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GatewayLoadedImage?>?): Boolean = size > 32
    }
  private val mutex = kotlinx.coroutines.sync.Mutex()

  suspend fun load(
    hostname: String,
    request: suspend (String) -> JsonObject?,
  ): GatewayLoadedImage? {
    if (hostname.length !in 1..253) return null
    val url =
      "https://$hostname/".toHttpUrlOrNull()?.takeIf {
        it.host == hostname && it.username.isEmpty() && it.password.isEmpty() &&
          it.encodedPath == "/" && it.query == null && it.fragment == null
      } ?: return null
    return mutex.withLock {
      currentCoroutineContext().ensureActive()
      if (cache.containsKey(hostname)) return@withLock cache[hostname]
      val payload = request(url.toString())
      currentCoroutineContext().ensureActive()
      decodeFavicon(payload?.get("faviconDataUrl").asJsonStringOrNull()).also { cache[hostname] = it }
    }
  }

  private fun decodeFavicon(dataUrl: String?): GatewayLoadedImage? {
    // Bound the encoded input before allocation and decoded bytes independently:
    // adjacent byte lengths can have the same padded base64 length.
    val maximumBytes = 65_536
    val maximumEncodedLength = ((maximumBytes + 2) / 3) * 4
    if (dataUrl == null || dataUrl.length > maximumEncodedLength + "data:image/x-icon;base64,".length) return null
    val mimeType =
      when (dataUrl.substringBefore(',')) {
        "data:image/png;base64" -> "image/png"
        "data:image/x-icon;base64" -> "image/x-icon"
        else -> return null
      }
    val encoded = dataUrl.substringAfter(',', "")
    if (encoded.isEmpty() || encoded.length > maximumEncodedLength) return null
    val bytes = runCatching { Base64.getDecoder().decode(encoded) }.getOrNull() ?: return null
    return bytes.takeIf { it.isNotEmpty() && it.size <= maximumBytes }?.let { GatewayLoadedImage(it, mimeType) }
  }
}
