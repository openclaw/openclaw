package ai.openclaw.app

import ai.openclaw.app.chat.deleteChatTranscriptCacheDatabase
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import android.app.Application
import android.os.StrictMode

/**
 * Android Application singleton that owns process-wide secure prefs and lazy NodeRuntime startup.
 */
class NodeApp : Application() {
  val prefs: SecurePrefs by lazy { SecurePrefs(this) }

  private val runtimeLock = Any()
  private var runtimeInstance: NodeRuntime? = null

  /**
   * Returns the single NodeRuntime for this process, creating it on first use.
   */
  fun ensureRuntime(): NodeRuntime =
    synchronized(runtimeLock) {
      runtimeInstance ?: NodeRuntime(this, prefs).also { runtimeInstance = it }
    }

  /**
   * Reads the runtime without forcing startup, used by lifecycle probes and services.
   */
  fun peekRuntime(): NodeRuntime? = synchronized(runtimeLock) { runtimeInstance }

  /** Clears pairing auth without racing lazy process-runtime construction. */
  suspend fun resetGatewaySetupAuth(): Boolean {
    val runtime =
      synchronized(runtimeLock) {
        runtimeInstance?.let { return@synchronized it }
        // Keep runtime construction blocked through the direct purge: a runtime built from the old
        // credentials could otherwise reconnect and rewrite device auth after this reset returns.
        return runCatching { resetGatewaySetupAuthBeforeRuntime() }.getOrDefault(false)
      }
    return runtime.resetGatewaySetupAuth()
  }

  private fun resetGatewaySetupAuthBeforeRuntime(): Boolean {
    // Delete first: credential destruction must not strand an unreadable cache after a failed purge.
    if (!deleteChatTranscriptCacheDatabase(this)) return false
    prefs.clearGatewaySetupAuth()
    val deviceId = DeviceIdentityStore(this).loadOrCreate().deviceId
    val deviceAuthStore = DeviceAuthStore(prefs)
    deviceAuthStore.clearToken(deviceId, "node")
    deviceAuthStore.clearToken(deviceId, "operator")
    return true
  }

  override fun onCreate() {
    super.onCreate()
    if (BuildConfig.DEBUG) {
      StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
      StrictMode.setVmPolicy(
        StrictMode.VmPolicy
          .Builder()
          .detectAll()
          .penaltyLog()
          .build(),
      )
    }
  }
}
