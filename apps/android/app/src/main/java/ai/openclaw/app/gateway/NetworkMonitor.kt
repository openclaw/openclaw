package ai.openclaw.app.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Reports newly available app-visible networks, including private LANs without internet validation.
 * Sessions own desired-connection, auth-pause, and readiness decisions. This process-lifetime
 * callback uses the application context, like its owning NodeRuntime.
 */
internal class NetworkMonitor(
  context: Context,
  private val onNetworkAvailable: () -> Unit,
) {
  private val logTag = "OpenClaw/NetworkMonitor"

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        try {
          onNetworkAvailable()
        } catch (err: Throwable) {
          Log.w(logTag, "network restore callback threw: ${err.message ?: err::class.java.simpleName}")
        }
      }
    }

  init {
    try {
      // Registration delivers existing networks too; session readiness guards make that harmless.
      context.getSystemService(ConnectivityManager::class.java)?.registerNetworkCallback(gatewayNetworkRequest(), callback)
    } catch (err: Throwable) {
      Log.w(logTag, "registerNetworkCallback failed: ${err.message ?: err::class.java.simpleName}")
    }
  }
}

/** Include VPNs without dropping the request's normal trusted, unrestricted, app-visible defaults. */
internal fun gatewayNetworkRequest(): NetworkRequest =
  NetworkRequest
    .Builder()
    .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
    .build()
