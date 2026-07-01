package ai.openclaw.app.gateway

import android.util.Log
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Properties

private const val TAG = "SshTunnelManager"

/** Reconnection delay in milliseconds between failed tunnel attempts. */
private const val RECONNECT_DELAY_MS = 5_000L

/** Connection timeout passed to the JSch session handshake. */
private const val CONNECT_TIMEOUT_MS = 15_000

/**
 * Manages the lifecycle of a local-port-forwarding SSH tunnel.
 *
 * When [start] is called with a valid [SshTunnelConfig] the manager:
 *  1. Opens a JSch SSH session to the configured host/port.
 *  2. Binds a local TCP port that forwards traffic to [SshTunnelConfig.remoteHost]:[SshTunnelConfig.remotePort].
 *  3. Automatically reconnects if the session drops, until [stop] is called.
 *
 * The tunnel runs on the IO dispatcher; callers do not need to manage threading.
 */
class SshTunnelManager(
  private val scope: CoroutineScope,
  private val prefs: ai.openclaw.app.SecurePrefs,
) {
  /** Currently active JSch session, if any. */
  @Volatile
  private var session: Session? = null

  /** Job that keeps the tunnel alive across reconnects. */
  private var keepAliveJob: Job? = null

  /** Last known config used to reconnect automatically on session drop. */
  @Volatile
  private var currentConfig: SshTunnelConfig? = null

  /** Returns true when the underlying SSH session is currently connected. */
  val isConnected: Boolean
    get() = session?.isConnected == true

  /**
   * Starts the SSH tunnel described by [config].
   *
   * If a tunnel is already running it is stopped first. When [config] is disabled or empty,
   * [start] is a no-op. The coroutine keeps retrying on transient failures until [stop] is called.
   */
  fun start(config: SshTunnelConfig) {
    if (!config.enabled || config.host.isBlank() || config.username.isBlank()) {
      Log.d(TAG, "SSH tunnel skipped: not configured or disabled.")
      stop()
      return
    }
    if (config == currentConfig && keepAliveJob != null) {
      Log.d(TAG, "SSH tunnel manager already running with same config.")
      return
    }
    stop()
    currentConfig = config

    keepAliveJob =
      scope.launch(Dispatchers.IO) {
        while (isActive) {
          val connected = tryConnect(config)
          if (!connected) {
            Log.w(TAG, "SSH tunnel connection failed – retrying in ${RECONNECT_DELAY_MS}ms")
            delay(RECONNECT_DELAY_MS)
            continue
          }
          // Monitor the session and reconnect when it drops.
          while (isActive && session?.isConnected == true) {
            delay(2_000)
          }
          if (isActive) {
            Log.w(TAG, "SSH tunnel dropped – reconnecting…")
            safeDisconnect()
          }
        }
      }

    Log.i(TAG, "SSH tunnel manager started for ${config.host}:${config.port}")
  }

  /**
   * Stops the tunnel and disconnects the underlying SSH session.
   *
   * Safe to call multiple times or when no tunnel is active.
   */
  fun stop() {
    keepAliveJob?.cancel()
    keepAliveJob = null
    safeDisconnect()
    currentConfig = null
    Log.i(TAG, "SSH tunnel stopped.")
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Attempts to open one SSH session and bind the local port forward. Returns true on success. */
  private suspend fun tryConnect(config: SshTunnelConfig): Boolean =
    withContext(Dispatchers.IO) {
      safeDisconnect()
      return@withContext try {
        val jsch = JSch()

        // Implement Trust on First Use (TOFU) by storing the host key fingerprint.
        jsch.setHostKeyRepository(object : com.jcraft.jsch.HostKeyRepository {
          override fun check(host: String, key: ByteArray): Int {
            val encodedKey = android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP)
            val savedKey = prefs.loadSshHostKey(host, config.port)
            return when {
              savedKey == null -> {
                Log.i(TAG, "First connection to $host:${config.port}, trusting host key.")
                prefs.setSshHostKey(host, config.port, encodedKey)
                com.jcraft.jsch.HostKeyRepository.OK
              }
              savedKey == encodedKey -> com.jcraft.jsch.HostKeyRepository.OK
              else -> {
                Log.e(TAG, "SSH HOST KEY MISMATCH for $host:${config.port}! Potential Man-in-the-Middle attack.")
                com.jcraft.jsch.HostKeyRepository.CHANGED
              }
            }
          }
          override fun add(hostkey: com.jcraft.jsch.HostKey, userinfo: com.jcraft.jsch.UserInfo?) {}
          override fun remove(host: String, type: String) {}
          override fun remove(host: String, type: String, key: ByteArray) {}
          override fun getKnownHostsRepositoryID(): String = "openclaw-memory-repo"
          override fun getHostKey(): Array<com.jcraft.jsch.HostKey> = emptyArray()
          override fun getHostKey(host: String, type: String): Array<com.jcraft.jsch.HostKey> = emptyArray()
        })

        val props =
          Properties().apply {
            setProperty("StrictHostKeyChecking", "ask")
            setProperty("PreferredAuthentications", "publickey,password,keyboard-interactive")
          }

        // We need a UserInfo to handle the "ask" when the key is new, 
        // even if our repository already handled it in check().
        val userInfo = object : com.jcraft.jsch.UserInfo {
          override fun getPassphrase(): String? = null
          override fun getPassword(): String? = null
          override fun promptPassword(message: String?): Boolean = true
          override fun promptPassphrase(message: String?): Boolean = true
          override fun promptYesNo(message: String?): Boolean = true
          override fun showMessage(message: String?) { Log.d(TAG, "SSH Message: $message") }
        }

        if (config.privateKey.isNotBlank()) {
          val passphrase = config.privateKeyPassphrase.toByteArray().takeIf { it.isNotEmpty() }
          jsch.addIdentity("openclaw-key", config.privateKey.toByteArray(), null, passphrase)
        }

        val newSession =
          jsch.getSession(config.username, config.host, config.port).apply {
            if (config.password.isNotBlank()) {
              setPassword(config.password)
            }
            setConfig(props)
            setUserInfo(userInfo)
          }

        newSession.connect(CONNECT_TIMEOUT_MS)
        // Forward localPort → remoteHost:remotePort through the SSH server.
        newSession.setPortForwardingL(config.localPort, config.remoteHost, config.remotePort)
        session = newSession

        Log.i(
          TAG,
          "SSH tunnel established: localhost:${config.localPort} → " +
            "${config.remoteHost}:${config.remotePort} via ${config.host}:${config.port}",
        )
        true
      } catch (e: Exception) {
        Log.e(TAG, "SSH tunnel error: ${e.message}", e)
        safeDisconnect()
        false
      }
    }

  /** Disconnects the current JSch session without throwing. */
  private fun safeDisconnect() {
    try {
      session?.disconnect()
    } catch (_: Exception) {
    }
    session = null
  }
}
