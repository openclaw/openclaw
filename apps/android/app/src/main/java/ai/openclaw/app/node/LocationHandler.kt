package ai.openclaw.app.node

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat
import ai.openclaw.app.LocationMode
import ai.openclaw.app.NodeForegroundService
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

internal interface LocationDataSource {
  fun hasFinePermission(context: Context): Boolean

  fun hasCoarsePermission(context: Context): Boolean

  fun hasBackgroundPermission(context: Context): Boolean

  suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload
}

private class DefaultLocationDataSource(
  private val capture: LocationCaptureManager,
) : LocationDataSource {
  override fun hasFinePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override fun hasCoarsePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override fun hasBackgroundPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload =
    capture.getLocation(
      desiredProviders = desiredProviders,
      maxAgeMs = maxAgeMs,
      timeoutMs = timeoutMs,
      isPrecise = isPrecise,
    )
}

class LocationHandler private constructor(
  private val appContext: Context,
  private val dataSource: LocationDataSource,
  private val json: Json,
  private val isForeground: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val locationPreciseEnabled: () -> Boolean,
) {
  constructor(
    appContext: Context,
    location: LocationCaptureManager,
    json: Json,
    isForeground: () -> Boolean,
    locationMode: () -> LocationMode,
    locationPreciseEnabled: () -> Boolean,
  ) : this(
    appContext = appContext,
    dataSource = DefaultLocationDataSource(location),
    json = json,
    isForeground = isForeground,
    locationMode = locationMode,
    locationPreciseEnabled = locationPreciseEnabled,
  )

  fun hasFineLocationPermission(): Boolean = dataSource.hasFinePermission(appContext)

  fun hasCoarseLocationPermission(): Boolean = dataSource.hasCoarsePermission(appContext)

  companion object {
    internal fun forTesting(
      appContext: Context,
      dataSource: LocationDataSource,
      json: Json = Json { ignoreUnknownKeys = true },
      isForeground: () -> Boolean = { true },
      locationMode: () -> LocationMode = { LocationMode.WhileUsing },
      locationPreciseEnabled: () -> Boolean = { true },
    ): LocationHandler =
      LocationHandler(
        appContext = appContext,
        dataSource = dataSource,
        json = json,
        isForeground = isForeground,
        locationMode = locationMode,
        locationPreciseEnabled = locationPreciseEnabled,
      )
  }

  suspend fun handleLocationGet(paramsJson: String?): GatewaySession.InvokeResult {
    if (!isForeground() && !allowsBackgroundLocation()) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_BACKGROUND_UNAVAILABLE",
        message =
          "LOCATION_BACKGROUND_UNAVAILABLE: set Location to Always and grant Background location",
      )
    }
    if (!isForeground() && allowsBackgroundLocation()) {
      NodeForegroundService.refresh(appContext)
    }
    if (!dataSource.hasFinePermission(appContext) && !dataSource.hasCoarsePermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_PERMISSION_REQUIRED",
        message = "LOCATION_PERMISSION_REQUIRED: grant Location permission",
      )
    }
    val (maxAgeMs, timeoutMs, desiredAccuracy) = parseLocationParams(paramsJson)
    val preciseEnabled = locationPreciseEnabled()
    val accuracy =
      when (desiredAccuracy) {
        "precise" -> if (preciseEnabled && dataSource.hasFinePermission(appContext)) "precise" else "balanced"
        "coarse" -> "coarse"
        else -> if (preciseEnabled && dataSource.hasFinePermission(appContext)) "precise" else "balanced"
      }
    val providers =
      when (accuracy) {
        "precise" -> listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        "coarse" -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        else -> listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
      }
    try {
      val payload =
        dataSource.fetchLocation(
          desiredProviders = providers,
          maxAgeMs = maxAgeMs,
          timeoutMs = timeoutMs,
          isPrecise = accuracy == "precise",
        )
      return GatewaySession.InvokeResult.ok(payload.payloadJson)
    } catch (err: TimeoutCancellationException) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_TIMEOUT",
        message = "LOCATION_TIMEOUT: no fix in time",
      )
    } catch (err: Throwable) {
      val message = err.message ?: "LOCATION_UNAVAILABLE: no fix"
      return GatewaySession.InvokeResult.error(code = "LOCATION_UNAVAILABLE", message = message)
    }
  }

  private fun allowsBackgroundLocation(): Boolean =
    locationMode() == LocationMode.Always && dataSource.hasBackgroundPermission(appContext)

  private fun parseLocationParams(paramsJson: String?): Triple<Long?, Long, String?> {
    if (paramsJson.isNullOrBlank()) {
      return Triple(null, 10_000L, null)
    }
    val root =
      try {
        json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      }
    val maxAgeMs = (root?.get("maxAgeMs") as? JsonPrimitive)?.content?.toLongOrNull()
    val timeoutMs =
      (root?.get("timeoutMs") as? JsonPrimitive)?.content?.toLongOrNull()?.coerceIn(1_000L, 60_000L)
        ?: 10_000L
    val desiredAccuracy =
      (root?.get("desiredAccuracy") as? JsonPrimitive)?.content?.trim()?.lowercase()
    return Triple(maxAgeMs, timeoutMs, desiredAccuracy)
  }
}
