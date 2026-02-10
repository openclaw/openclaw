package ai.openclaw.android.node

import ai.openclaw.android.LocationMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Monitors significant location changes (~500m displacement) and pushes
 * `location.update` events to the gateway so the severance hook can
 * determine whether the user is at their configured work location.
 */
object SignificantLocationMonitor {
  fun startIfNeeded(
    scope: CoroutineScope,
    location: LocationCaptureManager,
    locationMode: StateFlow<LocationMode>,
    hasFineLocationPermission: () -> Boolean,
    hasCoarseLocationPermission: () -> Boolean,
    sendNodeEvent: suspend (event: String, payloadJson: String) -> Unit,
  ) {
    if (locationMode.value == LocationMode.Off) return
    if (!hasFineLocationPermission() && !hasCoarseLocationPermission()) return
    location.startMonitoringSignificantChanges { lat, lon, accuracyMeters ->
      scope.launch {
        sendNodeEvent(
          "location.update",
          buildJsonObject {
            put("lat", JsonPrimitive(lat))
            put("lon", JsonPrimitive(lon))
            put("accuracyMeters", JsonPrimitive(accuracyMeters.toDouble()))
            put("source", JsonPrimitive("android-significant-location"))
          }.toString(),
        )
      }
    }
  }
}
