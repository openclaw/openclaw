package ai.openclaw.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.BatteryManager
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.android.node.LocationCaptureManager
import java.io.File
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class TelemetryCollector(
  private val appContext: Context,
  private val scope: CoroutineScope,
  private val locationCaptureManager: LocationCaptureManager,
  private val batteryEnabled: () -> Boolean,
  private val locationEnabled: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val locationPreciseEnabled: () -> Boolean,
  private val samplingMode: () -> TelemetrySamplingMode,
  private val retention: () -> TelemetryRetention,
  private val syncEnabled: () -> Boolean,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val telemetryDir: File = File(appContext.filesDir, "telemetry")
  private val batteryHistoryFile = File(telemetryDir, "battery_history.jsonl")
  private val locationHistoryFile = File(telemetryDir, "location_history.jsonl")
  private var job: Job? = null
  private var lastBatteryPercent: Int = -1
  private var lastBatteryCharging: Boolean = false
  private var lastBatterySampleAtMs: Long = 0L

  fun start() {
    if (job?.isActive == true) return
    telemetryDir.mkdirs()
    job =
      scope.launch(Dispatchers.IO) {
        while (isActive) {
          val mode = effectiveSamplingMode()
          try {
            tick(mode)
          } catch (t: Throwable) {
            Log.w("OpenClawTelemetry", "telemetry tick failed", t)
          }
          delay(intervalMs(mode))
        }
      }
  }

  private suspend fun tick(mode: TelemetrySamplingMode) {
    val now = Instant.now().toString()

    if (batteryEnabled()) {
      captureBattery(now, mode)
    }

    if (locationEnabled()) {
      captureLocation(now, mode)
    }

    pruneByRetention(retention())
  }

  private fun captureBattery(nowIso: String, mode: TelemetrySamplingMode) {
    val intent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
    val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging =
      status == BatteryManager.BATTERY_STATUS_CHARGING ||
        status == BatteryManager.BATTERY_STATUS_FULL
    val percent = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else -1

    if (percent < 0) return

    val prevPercent = lastBatteryPercent
    val prevCharging = lastBatteryCharging
    lastBatteryPercent = percent
    lastBatteryCharging = charging

    val nowMs = runCatching { Instant.parse(nowIso).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
    val unchanged = percent == prevPercent && charging == prevCharging
    if (unchanged && lastBatterySampleAtMs > 0L) {
      val ageMs = nowMs - lastBatterySampleAtMs
      if (ageMs in 0 until unchangedBatteryWriteWindowMs(mode)) return
    }

    val line =
      buildString {
        append("{\"capturedAt\":\"").append(nowIso).append("\"")
        append(",\"percent\":").append(percent)
        append(",\"charging\":").append(charging)
        append(",\"source\":\"battery_broadcast\"")
        append(",\"syncEnabled\":").append(syncEnabled())
        append("}")
      }
    appendLine(batteryHistoryFile, line)
    lastBatterySampleAtMs = nowMs
  }

  private suspend fun captureLocation(nowIso: String, mode: TelemetrySamplingMode) {
    if (locationMode() != LocationMode.Always) return

    val fineOk =
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseOk =
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!fineOk && !coarseOk) return

    val backgroundOk =
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!backgroundOk) return

    val manager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER) &&
      !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    ) {
      return
    }

    val isPrecise =
      when (mode) {
        TelemetrySamplingMode.LowPower -> false
        TelemetrySamplingMode.Balanced -> locationPreciseEnabled() && fineOk
        TelemetrySamplingMode.HighDetail -> locationPreciseEnabled() && fineOk
      }

    val desiredProviders =
      when (mode) {
        TelemetrySamplingMode.LowPower -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        TelemetrySamplingMode.Balanced -> {
          if (isPrecise) listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
          else listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        }
        TelemetrySamplingMode.HighDetail -> listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      }

    val payload =
      withContext(Dispatchers.Main) {
        locationCaptureManager.getLocation(
          desiredProviders = desiredProviders,
          maxAgeMs = locationMaxAgeMs(mode),
          timeoutMs = locationTimeoutMs(mode),
          isPrecise = isPrecise,
        )
      }

    val root = json.parseToJsonElement(payload.payloadJson) as? JsonObject ?: return
    val lat = (root["lat"] as? JsonPrimitive)?.content ?: return
    val lon = (root["lon"] as? JsonPrimitive)?.content ?: return
    val accuracy = (root["accuracyMeters"] as? JsonPrimitive)?.content ?: "null"
    val source = (root["source"] as? JsonPrimitive)?.content ?: "unknown"

    val line =
      buildString {
        append("{\"capturedAt\":\"").append(nowIso).append("\"")
        append(",\"lat\":").append(lat)
        append(",\"lon\":").append(lon)
        append(",\"accuracyMeters\":").append(accuracy)
        append(",\"source\":\"").append(source).append("\"")
        append(",\"syncEnabled\":").append(syncEnabled())
        append("}")
      }
    appendLine(locationHistoryFile, line)
  }

  private fun appendLine(file: File, line: String) {
    file.parentFile?.mkdirs()
    file.appendText(line)
    file.appendText("\n")
  }

  private fun pruneByRetention(retention: TelemetryRetention) {
    val cutoffMs = System.currentTimeMillis() - retention.days * 24L * 60L * 60L * 1000L
    pruneFile(batteryHistoryFile, cutoffMs)
    pruneFile(locationHistoryFile, cutoffMs)
  }

  private fun pruneFile(file: File, cutoffMs: Long) {
    if (!file.exists()) return
    val kept =
      file.readLines()
        .filter { it.isNotBlank() }
        .filter { line ->
          val capturedAt =
            runCatching {
              val root = json.parseToJsonElement(line) as JsonObject
              (root["capturedAt"] as? JsonPrimitive)?.content
            }.getOrNull()
          val ts = runCatching { capturedAt?.let { Instant.parse(it).toEpochMilli() } }.getOrNull()
          ts == null || ts >= cutoffMs
        }
    file.writeText(if (kept.isEmpty()) "" else kept.joinToString("\n", postfix = "\n"))
  }

  private fun effectiveSamplingMode(): TelemetrySamplingMode {
    val requested = samplingMode()
    if (requested != TelemetrySamplingMode.Balanced) return requested
    val percent = lastBatteryPercent
    val charging = lastBatteryCharging
    return if (!charging && percent in 0..35) TelemetrySamplingMode.LowPower else requested
  }

  private fun unchangedBatteryWriteWindowMs(mode: TelemetrySamplingMode): Long {
    return when (mode) {
      TelemetrySamplingMode.LowPower -> 30 * 60 * 1000L
      TelemetrySamplingMode.Balanced -> 15 * 60 * 1000L
      TelemetrySamplingMode.HighDetail -> 5 * 60 * 1000L
    }
  }

  private fun locationTimeoutMs(mode: TelemetrySamplingMode): Long {
    return when (mode) {
      TelemetrySamplingMode.LowPower -> 4_000L
      TelemetrySamplingMode.Balanced -> 6_000L
      TelemetrySamplingMode.HighDetail -> 8_000L
    }
  }

  private fun locationMaxAgeMs(mode: TelemetrySamplingMode): Long {
    return when (mode) {
      TelemetrySamplingMode.LowPower -> 20 * 60 * 1000L
      TelemetrySamplingMode.Balanced -> 8 * 60 * 1000L
      TelemetrySamplingMode.HighDetail -> 60 * 1000L
    }
  }

  private fun intervalMs(mode: TelemetrySamplingMode): Long {
    return when (mode) {
      TelemetrySamplingMode.LowPower -> 20 * 60 * 1000L
      TelemetrySamplingMode.Balanced -> 8 * 60 * 1000L
      TelemetrySamplingMode.HighDetail -> 60 * 1000L
    }
  }
}
