package ai.openclaw.app.calls

import ai.openclaw.app.NodeApp
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi
import androidx.core.net.toUri

/** Android owns call arbitration; the controller owns invitation authority and all audio. */
class IncomingCallConnectionService : ConnectionService() {
  private val calls get() = (application as NodeApp).ensureBackgroundRuntime().incomingCalls

  override fun onCreateIncomingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest,
  ): Connection {
    val id =
      request.extras?.getString(IncomingCallController.CALL_ID)
        ?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
    val connection =
      object : Connection() {
        override fun onAnswer() = launchAnswer(id)

        override fun onAnswer(videoState: Int) = launchAnswer(id)

        override fun onReject() = calls.decline(id)

        override fun onDisconnect() = calls.end(id)

        override fun onAbort() = calls.end(id)

        override fun onShowIncomingCallUi() = calls.showIncomingUi(id)

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION") // API 31–33 call routing compatibility.
        override fun onCallAudioStateChanged(state: CallAudioState) = calls.legacyAudioStateChanged(id, state)

        override fun onMuteStateChanged(isMuted: Boolean) = calls.platformMuteChanged(id, isMuted)

        @RequiresApi(34)
        override fun onAvailableCallEndpointsChanged(availableEndpoints: List<CallEndpoint>) = calls.availableEndpointsChanged(id, availableEndpoints)

        @RequiresApi(34)
        override fun onCallEndpointChanged(callEndpoint: CallEndpoint) = calls.currentEndpointChanged(id, callEndpoint)
      }
    connection.connectionProperties = Connection.PROPERTY_SELF_MANAGED
    connection.setAddress("openclaw:$id".toUri(), TelecomManager.PRESENTATION_RESTRICTED)
    connection.audioModeIsVoip = true
    if (!calls.attachConnection(id, connection)) {
      connection.destroy()
      return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
    }
    connection.setRinging()
    return connection
  }

  private fun launchAnswer(id: String) {
    // Bring a user-visible Activity forward before microphone FGS startup (Android 14+).
    runCatching {
      startActivity(
        android.content
          .Intent(this, IncomingCallActivity::class.java)
          .putExtra(IncomingCallController.CALL_ID, id)
          .putExtra(IncomingCallController.ACTION, "answer")
          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP),
      )
    }.onFailure { calls.connectionFailed(id) }
  }

  override fun onCreateIncomingConnectionFailed(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest,
  ) {
    request.extras?.getString(IncomingCallController.CALL_ID)?.let(calls::connectionFailed)
  }
}
