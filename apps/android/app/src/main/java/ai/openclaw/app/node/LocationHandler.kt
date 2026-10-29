package ai.openclaw.app.node

import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPermission
import android.Manifest
import android.content.Context
import android.location.Location
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.format.DateTimeFormatter

class LocationHandler internal constructor(
  appContext: Context,
  capture: suspend (List<String>, Long?, Long) -> Location,
  private val hasFinePermission: () -> Boolean = { appContext.hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) },
  private val hasCoarsePermission: () -> Boolean = { appContext.hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION) },
  private val hasBackgroundPermission: () -> Boolean = { appContext.hasPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) },
  private val isForeground: () -> Boolean = { true },
  private val locationMode: () -> LocationMode = { LocationMode.WhileUsing },
  private val backgroundLocationEnabled: () -> Boolean = { false },
  locationPreciseEnabled: () -> Boolean = { true },
) {
  private val disclosure =
    LocationDisclosure(
      preciseEnabled = locationPreciseEnabled,
      hasFinePermission = hasFinePermission,
      capture = capture,
    )

  constructor(
    appContext: Context,
    location: LocationCaptureManager,
    isForeground: () -> Boolean,
    locationMode: () -> LocationMode,
    backgroundLocationEnabled: () -> Boolean,
    locationPreciseEnabled: () -> Boolean,
  ) : this(
    appContext = appContext,
    capture = location::getLocation,
    isForeground = isForeground,
    locationMode = locationMode,
    backgroundLocationEnabled = backgroundLocationEnabled,
    locationPreciseEnabled = locationPreciseEnabled,
  )

  /** Handles location.get with foreground, permission, and user precision gates applied. */
  suspend fun handleLocationGet(paramsJson: String?): GatewaySession.InvokeResult {
    if (!isForeground() && !allowsBackgroundLocation()) {
      // Android foreground restrictions and user expectation keep live location tied to the visible app.
      return nodeInvokeError("LOCATION_BACKGROUND_UNAVAILABLE", "choose Always and grant background location access")
    }
    if (!hasFinePermission() && !hasCoarsePermission()) {
      return nodeInvokeError("LOCATION_PERMISSION_REQUIRED", "grant Location permission")
    }
    val (maxAgeMs, timeoutMs, desiredAccuracy) = parseLocationParams(paramsJson)
    try {
      val (location, isPrecise) = disclosure.getLocation(maxAgeMs, timeoutMs, allowPrecise = desiredAccuracy != "coarse")
      val payload =
        buildJsonObject {
          put("lat", location.latitude)
          put("lon", location.longitude)
          put("accuracyMeters", location.accuracy.toDouble())
          if (location.hasAltitude()) put("altitudeMeters", location.altitude)
          if (location.hasSpeed()) put("speedMps", location.speed.toDouble())
          if (location.hasBearing()) put("headingDeg", location.bearing.toDouble())
          put("timestamp", DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(location.time)))
          put("isPrecise", isPrecise)
          put("source", location.provider)
        }
      return GatewaySession.InvokeResult.ok(payload.toString())
    } catch (err: TimeoutCancellationException) {
      return nodeInvokeError("LOCATION_TIMEOUT", "no fix in time")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "LOCATION_UNAVAILABLE: no fix"
      return GatewaySession.InvokeResult.error(code = "LOCATION_UNAVAILABLE", message = message)
    }
  }

  private fun allowsBackgroundLocation(): Boolean =
    backgroundLocationEnabled() &&
      locationMode() == LocationMode.Always &&
      hasBackgroundPermission()

  private fun parseLocationParams(paramsJson: String?): Triple<Long?, Long, String?> {
    val root = parseJsonParamsObject(paramsJson)
    val maxAgeMs = (root?.get("maxAgeMs") as? JsonPrimitive)?.content?.toLongOrNull()
    val timeoutMs =
      (root?.get("timeoutMs") as? JsonPrimitive)?.content?.toLongOrNull()?.coerceIn(1_000L, 60_000L)
        ?: 10_000L
    // desiredAccuracy is advisory; invalid values fall through to the default policy.
    val desiredAccuracy =
      (root?.get("desiredAccuracy") as? JsonPrimitive)?.content?.trim()?.lowercase()
    return Triple(maxAgeMs, timeoutMs, desiredAccuracy)
  }
}
