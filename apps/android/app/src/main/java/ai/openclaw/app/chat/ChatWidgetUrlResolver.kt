package ai.openclaw.app.chat

import java.net.URI
import java.net.URLDecoder

internal object ChatWidgetUrlResolver {
  private const val DOCUMENTS_PATH = "/__openclaw__/canvas/documents"

  fun resolve(
    surfaceUrl: String?,
    target: String,
  ): String? {
    val surface = parseCapabilitySurface(surfaceUrl) ?: return null
    val relative = parseRelativeTarget(target) ?: return null
    val joined =
      buildString {
        append(surface.scheme.lowercase())
        append("://")
        append(surface.rawAuthority)
        append(surface.rawPath.trimEnd('/'))
        append(relative.rawPath)
        relative.rawQuery?.let { append('?').append(it) }
        relative.rawFragment?.let { append('#').append(it) }
      }
    return runCatching { URI(joined) }.getOrNull()?.toASCIIString()
  }

  fun supportsTarget(target: String): Boolean = parseRelativeTarget(target) != null

  fun resolvePreferred(
    surfaces: ChatWidgetSurfaceUrls,
    target: String,
    excluding: String?,
  ): String? =
    sequenceOf(surfaces.node, surfaces.operator)
      .mapNotNull { resolve(it, target) }
      .firstOrNull { it != excluding }

  suspend fun resolveAfterFailure(
    target: String,
    failedUrl: String,
    currentSurfaceUrls: () -> ChatWidgetSurfaceUrls,
    refreshNodeSurfaceUrl: suspend (String?) -> String?,
  ): String? {
    val observed = currentSurfaceUrls()
    resolvePreferred(observed, target, excluding = failedUrl)?.let { return it }
    val refreshed = resolve(refreshNodeSurfaceUrl(observed.node), target)
    if (refreshed != null && refreshed != failedUrl) return refreshed

    // A nil refresh can mean its route lease lost a reconnect race. Re-read
    // both roles so a replacement connection wins over the stale observation.
    return resolvePreferred(currentSurfaceUrls(), target, excluding = failedUrl)
  }

  private fun parseCapabilitySurface(raw: String?): URI? {
    val parsed = raw?.trim()?.takeIf(String::isNotEmpty)?.let { runCatching { URI(it) }.getOrNull() } ?: return null
    val scheme = parsed.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    if (parsed.host.isNullOrBlank() || parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) return null
    val segments = parsed.rawPath.split('/').filter(String::isNotEmpty)
    if (segments.size < 3 || segments[segments.lastIndex - 2] != "__openclaw__" || segments[segments.lastIndex - 1] != "cap") return null
    if (decodeRepeatedly(segments.last())?.isEmpty() != false) return null
    return parsed
  }

  private fun parseRelativeTarget(raw: String): URI? {
    val target = raw.trim()
    if (!target.startsWith('/')) return null
    val parsed = runCatching { URI(target) }.getOrNull() ?: return null
    if (parsed.isAbsolute || parsed.rawAuthority != null || !isCanonicalPath(parsed.rawPath)) return null
    if (!parsed.rawPath.startsWith("$DOCUMENTS_PATH/")) return null
    return parsed
  }

  private fun isCanonicalPath(path: String): Boolean {
    val segments = path.split('/')
    if (segments.firstOrNull()?.isNotEmpty() == true) return false
    return segments.drop(1).all { encoded ->
      if (encoded.isEmpty()) return@all false
      val decoded = decodeRepeatedly(encoded) ?: return@all false
      decoded != "." && decoded != ".." && !decoded.contains('/') && !decoded.contains('\\')
    }
  }

  private fun decodeRepeatedly(raw: String): String? {
    var value = raw
    repeat(8) {
      val decoded =
        runCatching {
          URLDecoder.decode(value.replace("+", "%2B"), Charsets.UTF_8.name())
        }.getOrNull() ?: return null
      if (decoded == value) return decoded
      value = decoded
    }
    return null
  }
}

internal data class ChatWidgetSurfaceUrls(
  val node: String?,
  val operator: String?,
)
