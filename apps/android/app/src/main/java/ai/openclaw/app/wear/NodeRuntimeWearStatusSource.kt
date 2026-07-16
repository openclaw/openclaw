package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearStatusSnapshot

internal class NodeRuntimeWearStatusSource(
  private val app: NodeApp,
  private val clock: () -> Long = System::currentTimeMillis,
) : PhoneWearStatusSource {
  override fun snapshot(): WearStatusSnapshot? {
    val runtime = app.peekRuntime() ?: return null
    val gatewayConnected = runtime.gatewayConnectionDisplay.value.isConnected
    return WearStatusSnapshot(
      generatedAtEpochMillis = clock(),
      gatewayState =
        if (gatewayConnected) {
          WearGatewayState.CONNECTED
        } else {
          WearGatewayState.DISCONNECTED
        },
    )
  }
}
