package ai.openclaw.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast

internal fun Context.copyTextWithConfirmation(
  label: String,
  value: String,
  confirmation: String,
) {
  val clipboard = getSystemService(ClipboardManager::class.java) ?: return
  clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
  Toast.makeText(this, confirmation, Toast.LENGTH_SHORT).show()
}
