package ai.openclaw.android.node

import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraManager
import ai.openclaw.android.gateway.GatewaySession

class FlashlightHandler(
  private val appContext: Context,
) {
  private val cameraManager: CameraManager? =
    appContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

  private fun getCameraId(): String? {
    val cm = cameraManager ?: return null
    return try {
      cm.cameraIdList.firstOrNull { id ->
        cm.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      }
    } catch (e: CameraAccessException) {
      null
    }
  }

  suspend fun handleFlashlightOn(paramsJson: String?): GatewaySession.InvokeResult {
    val cm = cameraManager ?: return GatewaySession.InvokeResult.error(
      code = "UNAVAILABLE",
      message = "UNAVAILABLE: CameraManager not available",
    )
    val cameraId = getCameraId() ?: return GatewaySession.InvokeResult.error(
      code = "NO_FLASHLIGHT",
      message = "NO_FLASHLIGHT: device does not have a flashlight",
    )
    return try {
      cm.setTorchMode(cameraId, true)
      GatewaySession.InvokeResult.ok("""{"status":"on"}""")
    } catch (e: CameraAccessException) {
      GatewaySession.InvokeResult.error(
        code = "CAMERA_ACCESS_ERROR",
        message = "CAMERA_ACCESS_ERROR: ${e.message}",
      )
    } catch (e: Exception) {
      GatewaySession.InvokeResult.error(
        code = "UNAVAILABLE",
        message = "UNAVAILABLE: ${e.message}",
      )
    }
  }

  suspend fun handleFlashlightOff(paramsJson: String?): GatewaySession.InvokeResult {
    val cm = cameraManager ?: return GatewaySession.InvokeResult.error(
      code = "UNAVAILABLE",
      message = "UNAVAILABLE: CameraManager not available",
    )
    val cameraId = getCameraId() ?: return GatewaySession.InvokeResult.error(
      code = "NO_FLASHLIGHT",
      message = "NO_FLASHLIGHT: device does not have a flashlight",
    )
    return try {
      cm.setTorchMode(cameraId, false)
      GatewaySession.InvokeResult.ok("""{"status":"off"}""")
    } catch (e: CameraAccessException) {
      GatewaySession.InvokeResult.error(
        code = "CAMERA_ACCESS_ERROR",
        message = "CAMERA_ACCESS_ERROR: ${e.message}",
      )
    } catch (e: Exception) {
      GatewaySession.InvokeResult.error(
        code = "UNAVAILABLE",
        message = "UNAVAILABLE: ${e.message}",
      )
    }
  }
}
