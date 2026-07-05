package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Listens for Android transport restores and signals [onAvailable] when the device
 * regains a validated internet connection. Used to trigger an immediate gateway
 * reconnect instead of waiting out the time-based backoff slot in [GatewaySession].
 *
 * The receiver MUST already guard against the already-connected case: this monitor only
 * reports "transport came back", it does not decide whether a reconnect is wanted.
 * The application context is used so the callback survives the NodeRuntime lifetime.
 */
class NetworkMonitor(
  context: Context,
  private val onAvailable: () -> Unit,
) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val logTag = "OpenClaw/NetworkMonitor"

  // Tracks the last emitted transport state so capability churn (e.g. signal strength
  // changes) does not re-fire the reconnect path. Only a lost->validated transition
  // should signal.
  private val validatedNetworks = ValidatedNetworkState<Network>(initialValidatedNetworks())

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // Captive portals can report onAvailable before NET_CAPABILITY_VALIDATED;
        // read capabilities for this network instead of treating availability alone as online.
        markOnlineWhenValidated(network)
      }

      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities,
      ) {
        if (isTransportValidated(capabilities)) {
          markOnline(network)
        } else {
          markLost(network)
        }
      }

      override fun onLost(network: Network) {
        markLost(network)
      }
    }

  init {
    start()
  }

  private fun start() {
    val cm = connectivity ?: return
    try {
      // Equivalent to the default request used by GatewayDiscovery: match any network.
      cm.registerNetworkCallback(NetworkRequest.Builder().build(), callback)
    } catch (err: Throwable) {
      Log.w(logTag, "registerNetworkCallback failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun markOnlineWhenValidated(network: Network) {
    val cm = connectivity ?: return
    val caps =
      try {
        cm.getNetworkCapabilities(network)
      } catch (_: Throwable) {
        null
      } ?: return
    if (isTransportValidated(caps)) {
      markOnline(network)
    }
  }

  private fun markOnline(network: Network) {
    // Dedupe via the pure transition rule so the semantics stay unit-testable.
    if (!validatedNetworks.markValidated(network)) {
      return
    }
    try {
      onAvailable()
    } catch (err: Throwable) {
      Log.w(logTag, "onAvailable callback threw: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun markLost(network: Network) {
    validatedNetworks.markLost(network)
  }

  private fun initialValidatedNetworks(): Set<Network> {
    return try {
      val cm = connectivity ?: return emptySet()
      val active = cm.activeNetwork ?: return emptySet()
      val caps = cm.getNetworkCapabilities(active) ?: return emptySet()
      if (isTransportValidated(caps)) setOf(active) else emptySet()
    } catch (_: Throwable) {
      emptySet()
    }
  }
}

internal class ValidatedNetworkState<T>(
  initialValidatedNetworks: Set<T> = emptySet(),
) {
  private val validatedNetworks = initialValidatedNetworks.toMutableSet()

  @Synchronized
  fun markValidated(network: T): Boolean {
    val wasOnline = validatedNetworks.isNotEmpty()
    validatedNetworks.add(network)
    return shouldEmitOnlineTransition(wasOnline)
  }

  @Synchronized
  fun markLost(network: T) {
    validatedNetworks.remove(network)
  }
}

/**
 * True when the network reports a validated internet capability. Exposed internal so the
 * predicate can be unit-tested without a Robolectric ConnectivityManager shadow.
 */
internal fun isTransportValidated(capabilities: NetworkCapabilities): Boolean =
  capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

/**
 * True only on the first transition out of an offline state. Repeated onAvailable /
 * onCapabilitiesChanged calls while already online must not re-fire the reconnect path.
 */
internal fun shouldEmitOnlineTransition(previouslyOnline: Boolean): Boolean = !previouslyOnline
