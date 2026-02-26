package ai.openclaw.android.node

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import ai.openclaw.android.gateway.GatewaySession

class BatteryHandler(private val appContext: Context) {
  fun handleBatteryGet(): GatewaySession.InvokeResult {
    return try {
      val intent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
      val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1

      val percent = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else -1
      val charging =
        status == BatteryManager.BATTERY_STATUS_CHARGING ||
          status == BatteryManager.BATTERY_STATUS_FULL

      GatewaySession.InvokeResult.ok(
        """{"percent":${if (percent >= 0) percent else "null"},"charging":$charging,"status":$status,"level":$level,"scale":$scale}"""
      )
    } catch (e: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "BATTERY_UNAVAILABLE",
        message = "BATTERY_UNAVAILABLE: ${e.message ?: "unable to read battery"}",
      )
    }
  }
}
