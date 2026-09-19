package ai.openclaw.app.auto

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context

class CarInvokeBridge(
  private val context: Context,
  private val carCommandHandler: CarCommandHandler,
) {
  suspend fun handleCarCommand(command: String, paramsJson: String?): GatewaySession.InvokeResult {
    return when (command) {
      "car.navigate" -> carCommandHandler.handleNavigate(paramsJson)
      "car.media" -> carCommandHandler.handleMedia(paramsJson)
      "car.alert" -> carCommandHandler.handleAlert(paramsJson)
      else -> GatewaySession.InvokeResult.error("UNKNOWN_CAR_COMMAND", "Unknown command: $command")
    }
  }

  companion object {
    val SUPPORTED_COMMANDS = listOf(
      "car.navigate",
      "car.media",
      "car.alert",
    )
  }
}
