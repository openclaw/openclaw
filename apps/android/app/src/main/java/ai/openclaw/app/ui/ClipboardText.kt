package ai.openclaw.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast

internal fun ClipboardManager.copyTextWithConfirmation(
  context: Context,
  label: String,
  value: String,
  confirmation: String,
) {
  setPrimaryClip(ClipData.newPlainText(label, value))
  Toast.makeText(context, confirmation, Toast.LENGTH_SHORT).show()
}
