package ai.openclaw.app.ui.chat

import android.net.Uri

/** Imports only confirmed selections; platform URI grants are issued at selection time. */
internal class EmbeddedGallerySelection(
  private val close: () -> Unit,
) {
  private val granted = linkedSetOf<Uri>()
  private var disposed = false

  fun granted(uris: List<Uri>) {
    if (!disposed) granted.addAll(uris)
  }

  fun revoked(uris: List<Uri>) {
    granted.removeAll(uris.toSet())
  }

  fun complete(accept: (List<Uri>) -> Boolean) {
    if (!disposed) accept(granted.toList())
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    granted.clear()
    // Revocation callbacks are not guaranteed for app-requested deselection. Never
    // retain the remote surface while waiting for an acknowledgement on dismissal.
    close()
  }
}
