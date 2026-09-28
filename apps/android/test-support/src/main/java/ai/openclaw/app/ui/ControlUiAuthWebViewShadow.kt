package ai.openclaw.app.ui

import android.net.Uri
import android.webkit.WebMessage
import android.webkit.WebView
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowWebView

// Robolectric has real paired message-port fakes but does not implement the
// WebView main-frame transfer. Capture only that platform boundary.
@Implements(WebView::class)
class ControlUiAuthWebViewShadow : ShadowWebView() {
  val transfers = mutableListOf<Pair<WebMessage, Uri>>()

  @Implementation
  fun postWebMessage(
    message: WebMessage,
    targetOrigin: Uri,
  ) {
    transfers.add(message to targetOrigin)
  }
}
