package ai.openclaw.android.node

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import ai.openclaw.android.BuildConfig
import ai.openclaw.android.gateway.GatewaySession
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class DeviceHandler(
  private val appContext: Context,
) {
  fun handleDeviceStatus(_paramsJson: String?): GatewaySession.InvokeResult {
    return GatewaySession.InvokeResult.ok(statusPayloadJson())
  }

  fun handleDeviceInfo(_paramsJson: String?): GatewaySession.InvokeResult {
    return GatewaySession.InvokeResult.ok(infoPayloadJson())
  }

  private fun statusPayloadJson(): String {
    val batteryIntent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val batteryStatus =
      batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        ?: BatteryManager.BATTERY_STATUS_UNKNOWN
    val batteryLevel = batteryLevelFraction(batteryIntent)
    val powerManager = appContext.getSystemService(PowerManager::class.java)
    val storage = StatFs(Environment.getDataDirectory().absolutePath)
    val totalBytes = storage.totalBytes
    val freeBytes = storage.availableBytes
    val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
    val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
    val activeNetwork = connectivity?.activeNetwork
    val caps = activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
    val uptimeSeconds = SystemClock.elapsedRealtime() / 1_000.0

    return buildJsonObject {
      put(
        "battery",
        buildJsonObject {
          batteryLevel?.let { put("level", JsonPrimitive(it)) }
          put("state", JsonPrimitive(mapBatteryState(batteryStatus)))
          put("lowPowerModeEnabled", JsonPrimitive(powerManager?.isPowerSaveMode == true))
        },
      )
      put(
        "thermal",
        buildJsonObject {
          put("state", JsonPrimitive(mapThermalState(powerManager)))
        },
      )
      put(
        "storage",
        buildJsonObject {
          put("totalBytes", JsonPrimitive(totalBytes))
          put("freeBytes", JsonPrimitive(freeBytes))
          put("usedBytes", JsonPrimitive(usedBytes))
        },
      )
      put(
        "network",
        buildJsonObject {
          put("status", JsonPrimitive(mapNetworkStatus(caps)))
          put(
            "isExpensive",
            JsonPrimitive(
              caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)?.not() ?: false,
            ),
          )
          put(
            "isConstrained",
            JsonPrimitive(
              caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)?.not() ?: false,
            ),
          )
          put("interfaces", networkInterfacesJson(caps))
        },
      )
      put("uptimeSeconds", JsonPrimitive(uptimeSeconds))
    }.toString()
  }

  private fun infoPayloadJson(): String {
    val model = Build.MODEL?.trim().orEmpty()
    val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
    val modelIdentifier = Build.DEVICE?.trim().orEmpty()
    val systemVersion = Build.VERSION.RELEASE?.trim().orEmpty()
    val locale = Locale.getDefault().toLanguageTag().trim()
    val appVersion = BuildConfig.VERSION_NAME.trim()
    val appBuild = BuildConfig.VERSION_CODE.toString()

    return buildJsonObject {
      put("deviceName", JsonPrimitive(model.ifEmpty { "Android" }))
      put("modelIdentifier", JsonPrimitive(modelIdentifier.ifEmpty { listOf(manufacturer, model).filter { it.isNotEmpty() }.joinToString(" ") }))
      put("systemName", JsonPrimitive("Android"))
      put("systemVersion", JsonPrimitive(systemVersion.ifEmpty { Build.VERSION.SDK_INT.toString() }))
      put("appVersion", JsonPrimitive(appVersion.ifEmpty { "dev" }))
      put("appBuild", JsonPrimitive(appBuild.ifEmpty { "0" }))
      put("locale", JsonPrimitive(locale.ifEmpty { Locale.getDefault().toString() }))
    }.toString()
  }

  private fun batteryLevelFraction(intent: Intent?): Double? {
    val rawLevel = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val rawScale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    if (rawLevel < 0 || rawScale <= 0) return null
    return rawLevel.toDouble() / rawScale.toDouble()
  }

  private fun mapBatteryState(status: Int): String {
    return when (status) {
      BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
      BatteryManager.BATTERY_STATUS_FULL -> "full"
      BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
      else -> "unknown"
    }
  }

  private fun mapThermalState(powerManager: PowerManager?): String {
    val thermal = powerManager?.currentThermalStatus ?: return "nominal"
    return when (thermal) {
      PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
      PowerManager.THERMAL_STATUS_MODERATE -> "fair"
      PowerManager.THERMAL_STATUS_SEVERE -> "serious"
      PowerManager.THERMAL_STATUS_CRITICAL,
      PowerManager.THERMAL_STATUS_EMERGENCY,
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
      else -> "nominal"
    }
  }

  private fun mapNetworkStatus(caps: NetworkCapabilities?): String {
    if (caps == null) return "unsatisfied"
    return when {
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "satisfied"
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "requiresConnection"
      else -> "unsatisfied"
    }
  }

  private fun networkInterfacesJson(caps: NetworkCapabilities?) =
    buildJsonArray {
      if (caps == null) return@buildJsonArray
      var hasKnownTransport = false
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        hasKnownTransport = true
        add(JsonPrimitive("wifi"))
      }
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
        hasKnownTransport = true
        add(JsonPrimitive("cellular"))
      }
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
        hasKnownTransport = true
        add(JsonPrimitive("wired"))
      }
      if (!hasKnownTransport) add(JsonPrimitive("other"))
    }
}
