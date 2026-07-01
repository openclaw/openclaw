package ai.openclaw.app.gateway

/**
 * SSH tunnel configuration used to forward a local port to the gateway host through a
 * remote SSH server. When [enabled] is false the tunnel manager is a no-op.
 *
 * Fields mirror the Windows Companion SSH tunnel settings so the two companions stay
 * interchangeable when the same gateway requires remote access through SSH.
 *
 * @param enabled   Whether the SSH tunnel should be activated on every gateway connect.
 * @param host      SSH server hostname or IP address (e.g. "example.com" or "1.2.3.4").
 * @param port      SSH server port – typically 22.
 * @param username  SSH login user.
 * @param password  Optional password credential (empty string = no password auth).
 * @param localPort Local TCP port that the tunnel binds on this device.
 *                  The gateway WebSocket client will connect to 127.0.0.1:[localPort].
 * @param remoteHost Remote host the SSH server forwards to (usually the gateway LAN hostname).
 * @param remotePort Remote port that maps to the gateway WebSocket port.
 */
data class SshTunnelConfig(
  val enabled: Boolean,
  val host: String,
  val port: Int,
  val username: String,
  val password: String,
  val privateKey: String = "",
  val privateKeyPassphrase: String = "",
  val localPort: Int,
  val remoteHost: String,
  val remotePort: Int,
) {
  companion object {
    /** Default local-port chosen to avoid collision with any well-known service. */
    const val DEFAULT_LOCAL_PORT = 18799

    /** Standard SSH service port. */
    const val DEFAULT_SSH_PORT = 22

    /** Returns an empty, disabled config used as the initial state. */
    val EMPTY: SshTunnelConfig =
      SshTunnelConfig(
        enabled = false,
        host = "",
        port = DEFAULT_SSH_PORT,
        username = "",
        password = "",
        privateKey = "",
        privateKeyPassphrase = "",
        localPort = DEFAULT_LOCAL_PORT,
        remoteHost = "127.0.0.1",
        remotePort = 18789,
      )
  }
}
