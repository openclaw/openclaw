package ai.openclaw.app.gateway

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** A retry hint, not authentication proof. Callback/auth paths must finish before native retry. */
internal fun isBrowserGatewayReturn(
  target: HttpUrl,
  rawUrl: String,
): Boolean {
  val url = rawUrl.toHttpUrlOrNull() ?: return false
  return url.scheme == "https" && url.username.isEmpty() && url.password.isEmpty() &&
    url.browserSessionOrigin() == target.browserSessionOrigin() &&
    url.encodedPath.trimEnd('/') == target.encodedPath.trimEnd('/')
}
