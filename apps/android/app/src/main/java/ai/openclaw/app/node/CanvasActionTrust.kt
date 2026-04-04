package ai.openclaw.app.node

import java.net.URI

object CanvasActionTrust {
  const val scaffoldAssetUrl: String = "file:///android_asset/CanvasScaffold/scaffold.html"

  fun isTrustedCanvasActionUrl(rawUrl: String?, trustedA2uiUrls: List<String>): Boolean {
    val candidate = rawUrl?.trim().orEmpty()
    if (candidate.isEmpty()) return false
    if (candidate == scaffoldAssetUrl) return true

    val candidateUri = parseUri(candidate) ?: return false
    if (candidateUri.scheme.equals("file", ignoreCase = true)) {
      return false
    }

    return trustedA2uiUrls.any { trusted ->
      isTrustedA2uiPage(candidateUri, trusted)
    }
  }

  private fun isTrustedA2uiPage(candidateUri: URI, trustedUrl: String): Boolean {
    val trustedUri = parseUri(trustedUrl) ?: return false
    if (!candidateUri.scheme.equals(trustedUri.scheme, ignoreCase = true)) return false
    if (candidateUri.host?.equals(trustedUri.host, ignoreCase = true) != true) return false
    if (effectivePort(candidateUri) != effectivePort(trustedUri)) return false

    val trustedPath = trustedUri.rawPath?.takeIf { it.isNotBlank() } ?: return false
    val candidatePath = candidateUri.rawPath?.takeIf { it.isNotBlank() } ?: return false
    val trustedPrefix = if (trustedPath.endsWith("/")) trustedPath else "$trustedPath/"
    return candidatePath == trustedPath || candidatePath.startsWith(trustedPrefix)
  }

  private fun effectivePort(uri: URI): Int {
    if (uri.port >= 0) return uri.port
    return when (uri.scheme?.lowercase()) {
      "https" -> 443
      "http" -> 80
      else -> -1
    }
  }

  private fun parseUri(raw: String): URI? =
    try {
      URI(raw)
    } catch (_: Throwable) {
      null
    }
}
