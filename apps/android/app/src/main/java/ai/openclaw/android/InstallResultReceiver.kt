package ai.openclaw.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        // System needs user confirmation — launch the confirmation activity
        @Suppress("DEPRECATION")
        val confirmIntent = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        if (confirmIntent != null) {
          confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(confirmIntent)
          Log.w("openclaw", "app.update: user confirmation requested, launching install dialog")
        }
      }
      PackageInstaller.STATUS_SUCCESS -> {
        Log.w("openclaw", "app.update: install SUCCESS")
      }
      else -> {
        Log.e("openclaw", "app.update: install FAILED status=$status message=$message")
      }
    }
  }
}
