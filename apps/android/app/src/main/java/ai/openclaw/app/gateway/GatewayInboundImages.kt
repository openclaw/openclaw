package ai.openclaw.app.gateway

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.TimeUnit

private val INBOUND_MEDIA_SOURCE_REGEX = Regex("^media://inbound/([^/?#]+)$", RegexOption.IGNORE_CASE)

/** The canonical one-segment reference chat history projects for a sent upload. */
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

/**
 * Sent images are Gateway-owned uploads, not artifacts: history keeps only their inbound reference,
 * and the Gateway's authenticated assistant-media route serves the bytes to the paired client.
 */
internal class GatewayInboundImageLoader(
  client: OkHttpClient,
) {
  private val client =
    client
      .newBuilder()
      .followRedirects(false)
      .followSslRedirects(false)
      .build()

  suspend fun load(
    gatewayUrl: String,
    basePath: String,
    source: String,
    sessionKey: String,
    agentId: String?,
    headers: Map<String, String>,
    credentials: List<String>,
  ): GatewayLoadedImage? =
    withContext(Dispatchers.IO) {
      if (!isInboundMediaSource(source)) return@withContext null
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
          ?.build() ?: return@withContext null
      val baseRequest =
        Request
          .Builder()
          .url(url)
          .header("Accept", "image/*")
          .apply { headers.forEach { (name, value) -> header(name, value) } }
          .build()
      val authorizations =
        buildList<String?> {
          // Match source favicons: a trusted proxy may authorize HTTP before Gateway credentials.
          baseRequest.header("Authorization")?.let(::add)
          credentials.forEach { add("Bearer $it") }
          if (isEmpty()) add(null)
        }.distinct()
      for (authorization in authorizations) {
        val request = baseRequest.newBuilder()
        authorization?.let { request.header("Authorization", it) }
        val call = client.newCall(request.build())
        call.timeout().timeout(20, TimeUnit.SECONDS)
        val (code, image) = runCatching { call.execute().use { response -> response.code to readImage(response) } }.getOrElse { return@withContext null }
        if (code == 401 || code == 403) continue
        return@withContext image
      }
      null
    }

  private fun readImage(response: okhttp3.Response): GatewayLoadedImage? {
    if (!response.isSuccessful) return null
    val body = response.body
    val mimeType = body.contentType()?.let { "${it.type}/${it.subtype}".lowercase(Locale.ROOT) } ?: return null
    if (!mimeType.startsWith("image/")) return null
    val maximumBytes = GatewayMediaKind.Image.maximumBufferedBytes
    if (body.contentLength() > maximumBytes) return null
    val buffer = Buffer()
    val source = body.source()
    while (true) {
      if (source.read(buffer, minOf(8_192L, maximumBytes + 1L - buffer.size)) == -1L) break
      if (buffer.size > maximumBytes) return null
    }
    return GatewayLoadedImage(buffer.readByteArray(), mimeType)
  }
}
