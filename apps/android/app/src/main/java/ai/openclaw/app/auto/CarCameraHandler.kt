package ai.openclaw.app.auto

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CameraHandler
import android.content.Context

class CarCameraHandler(
  private val cameraHandler: CameraHandler,
) {
  suspend fun handleRoadSnap(paramsJson: String?): GatewaySession.InvokeResult {
    // Captura snapshot da lente traseira voltada para a pista
    return cameraHandler.handleSnap(paramsJson)
  }

  suspend fun handleRoadClip(paramsJson: String?): GatewaySession.InvokeResult {
    return cameraHandler.handleClip(paramsJson)
  }
}
