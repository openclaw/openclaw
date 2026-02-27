package ai.openclaw.android.node

import ai.openclaw.android.gateway.GatewaySession
import ai.openclaw.android.protocol.OpenClawCanvasA2UICommand
import ai.openclaw.android.protocol.OpenClawCanvasCommand
import ai.openclaw.android.protocol.OpenClawCameraCommand
import ai.openclaw.android.protocol.OpenClawDeviceCommand
import ai.openclaw.android.protocol.OpenClawLocationCommand
import ai.openclaw.android.protocol.OpenClawNotificationsCommand
import ai.openclaw.android.protocol.OpenClawScreenCommand
import ai.openclaw.android.protocol.OpenClawSmsCommand

class InvokeDispatcher(
  private val canvas: CanvasController,
  private val cameraHandler: CameraHandler,
  private val locationHandler: LocationHandler,
  private val deviceHandler: DeviceHandler,
  private val notificationsHandler: NotificationsHandler,
  private val screenHandler: ScreenHandler,
  private val smsHandler: SmsHandler,
  private val a2uiHandler: A2UIHandler,
  private val debugHandler: DebugHandler,
  private val appUpdateHandler: AppUpdateHandler,
  private val isForeground: () -> Boolean,
  private val cameraEnabled: () -> Boolean,
  private val locationEnabled: () -> Boolean,
  private val smsAvailable: () -> Boolean,
  private val debugBuild: () -> Boolean,
  private val refreshNodeCanvasCapability: suspend () -> Boolean,
  private val onCanvasA2uiPush: () -> Unit,
  private val onCanvasA2uiReset: () -> Unit,
) {
  suspend fun handleInvoke(command: String, paramsJson: String?): GatewaySession.InvokeResult {
    val spec =
      InvokeCommandRegistry.find(command)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
    if (spec.requiresForeground && !isForeground()) {
      return GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
      )
    }
    availabilityError(spec.availability)?.let { return it }

    return when (command) {
      // Canvas commands
      OpenClawCanvasCommand.Present.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Hide.rawValue -> GatewaySession.InvokeResult.ok(null)
      OpenClawCanvasCommand.Navigate.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      OpenClawCanvasCommand.Eval.rawValue -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        withCanvasAvailable {
          val result = canvas.eval(js)
          GatewaySession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
        }
      }
      OpenClawCanvasCommand.Snapshot.rawValue -> {
        val snapshotParams = CanvasController.parseSnapshotParams(paramsJson)
        withCanvasAvailable {
          val base64 =
            canvas.snapshotBase64(
              format = snapshotParams.format,
              quality = snapshotParams.quality,
              maxWidth = snapshotParams.maxWidth,
            )
          GatewaySession.InvokeResult.ok("""{"format":"${snapshotParams.format.rawValue}","base64":"$base64"}""")
        }
      }

      // A2UI commands
      OpenClawCanvasA2UICommand.Reset.rawValue ->
        withReadyA2ui {
          withCanvasAvailable {
            val res = canvas.eval(A2UIHandler.a2uiResetJS)
            onCanvasA2uiReset()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      OpenClawCanvasA2UICommand.Push.rawValue, OpenClawCanvasA2UICommand.PushJSONL.rawValue -> {
        val messages =
          try {
            a2uiHandler.decodeA2uiMessages(command, paramsJson)
          } catch (err: Throwable) {
            return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = err.message ?: "invalid A2UI payload"
            )
          }
        withReadyA2ui {
          withCanvasAvailable {
            val js = A2UIHandler.a2uiApplyMessagesJS(messages)
            val res = canvas.eval(js)
            onCanvasA2uiPush()
            GatewaySession.InvokeResult.ok(res)
          }
        }
      }

      // Camera commands
      OpenClawCameraCommand.List.rawValue -> cameraHandler.handleList(paramsJson)
      OpenClawCameraCommand.Snap.rawValue -> cameraHandler.handleSnap(paramsJson)
      OpenClawCameraCommand.Clip.rawValue -> cameraHandler.handleClip(paramsJson)

      // Location command
      OpenClawLocationCommand.Get.rawValue -> locationHandler.handleLocationGet(paramsJson)

      // Device commands
      OpenClawDeviceCommand.Status.rawValue -> deviceHandler.handleDeviceStatus(paramsJson)
      OpenClawDeviceCommand.Info.rawValue -> deviceHandler.handleDeviceInfo(paramsJson)
      OpenClawDeviceCommand.Permissions.rawValue -> deviceHandler.handleDevicePermissions(paramsJson)
      OpenClawDeviceCommand.Health.rawValue -> deviceHandler.handleDeviceHealth(paramsJson)

      // Notifications command
      OpenClawNotificationsCommand.List.rawValue -> notificationsHandler.handleNotificationsList(paramsJson)
      OpenClawNotificationsCommand.Actions.rawValue -> notificationsHandler.handleNotificationsActions(paramsJson)

      // Screen command
      OpenClawScreenCommand.Record.rawValue -> screenHandler.handleScreenRecord(paramsJson)

      // SMS command
      OpenClawSmsCommand.Send.rawValue -> smsHandler.handleSmsSend(paramsJson)

      // Debug commands
      "debug.ed25519" -> debugHandler.handleEd25519()
      "debug.logs" -> debugHandler.handleLogs()

      // App update
      "app.update" -> appUpdateHandler.handleUpdate(paramsJson)

      else -> GatewaySession.InvokeResult.error(code = "INVALID_REQUEST", message = "INVALID_REQUEST: unknown command")
    }
  }

  private suspend fun withReadyA2ui(
    block: suspend () -> GatewaySession.InvokeResult,
  ): GatewaySession.InvokeResult {
    var a2uiUrl = a2uiHandler.resolveA2uiHostUrl()
      ?: return GatewaySession.InvokeResult.error(
        code = "A2UI_HOST_NOT_CONFIGURED",
        message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
      )
    val readyOnFirstCheck = a2uiHandler.ensureA2uiReady(a2uiUrl)
    if (!readyOnFirstCheck) {
      if (!refreshNodeCanvasCapability()) {
        return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_UNAVAILABLE",
          message = "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        )
      }
      a2uiUrl = a2uiHandler.resolveA2uiHostUrl()
        ?: return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_NOT_CONFIGURED",
          message = "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        )
      if (!a2uiHandler.ensureA2uiReady(a2uiUrl)) {
        return GatewaySession.InvokeResult.error(
          code = "A2UI_HOST_UNAVAILABLE",
          message = "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        )
      }
    }
    return block()
  }

  private suspend fun withCanvasAvailable(
    block: suspend () -> GatewaySession.InvokeResult,
  ): GatewaySession.InvokeResult {
    return try {
      block()
    } catch (_: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "NODE_BACKGROUND_UNAVAILABLE",
        message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
      )
    }
  }

  private fun availabilityError(availability: InvokeCommandAvailability): GatewaySession.InvokeResult? {
    return when (availability) {
      InvokeCommandAvailability.Always -> null
      InvokeCommandAvailability.CameraEnabled ->
        if (cameraEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "CAMERA_DISABLED",
            message = "CAMERA_DISABLED: enable Camera in Settings",
          )
        }
      InvokeCommandAvailability.LocationEnabled ->
        if (locationEnabled()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "LOCATION_DISABLED",
            message = "LOCATION_DISABLED: enable Location in Settings",
          )
        }
      InvokeCommandAvailability.SmsAvailable ->
        if (smsAvailable()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "SMS_UNAVAILABLE",
            message = "SMS_UNAVAILABLE: SMS not available on this device",
          )
        }
      InvokeCommandAvailability.DebugBuild ->
        if (debugBuild()) {
          null
        } else {
          GatewaySession.InvokeResult.error(
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: unknown command",
          )
        }
    }
  }
}
