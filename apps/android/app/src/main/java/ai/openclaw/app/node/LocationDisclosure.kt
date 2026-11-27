package ai.openclaw.app.node

import android.location.Location
import android.location.LocationManager

/** Shared disclosure boundary for node responses and user-requested chat attachments. */
internal class LocationDisclosure(
  private val preciseEnabled: () -> Boolean,
  private val hasFinePermission: () -> Boolean,
  private val capture: suspend (List<String>, Long?, Long) -> Location,
) {
  data class Fix(
    val location: Location,
    val isPrecise: Boolean,
  )

  suspend fun getLocation(
    maxAgeMs: Long?,
    timeoutMs: Long,
    allowPrecise: Boolean = true,
  ): Fix {
    val initiallyPrecise = allowPrecise && preciseEnabled() && hasFinePermission()
    val providers =
      if (initiallyPrecise) {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      } else {
        listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
      }
    val fix = capture(providers, maxAgeMs, timeoutMs)
    // Recheck after suspension, and never upgrade an operation that began approximate.
    val isPrecise = initiallyPrecise && preciseEnabled() && hasFinePermission()
    return Fix(if (isPrecise) fix else coarsener.coarsen(fix), isPrecise)
  }

  private companion object {
    // One process-wide grid across every disclosure surface and reopening. Fresh random
    // offsets per request or per sheet could be averaged to recover a precise position.
    val coarsener by lazy { LocationCoarsener() }
  }
}
