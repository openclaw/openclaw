package ai.hanzo.bot.android.node

import ai.hanzo.bot.android.gateway.GatewaySession
import ai.hanzo.bot.android.protocol.HanzoBotCanvasA2UICommand
import ai.hanzo.bot.android.protocol.HanzoBotCanvasCommand
import ai.hanzo.bot.android.protocol.HanzoBotCameraCommand
import ai.hanzo.bot.android.protocol.HanzoBotDeviceCommand
import ai.hanzo.bot.android.protocol.HanzoBotLocationCommand
import ai.hanzo.bot.android.protocol.HanzoBotNotificationsCommand
import ai.hanzo.bot.android.protocol.HanzoBotScreenCommand
import ai.hanzo.bot.android.protocol.HanzoBotSmsCommand

class InvokeDispatcher(
  private val canvas: CanvasController,
  private val cameraHandler: CameraHandler,
  private val locationHandler: LocationHandler,
  private val screenHandler: ScreenHandler,
  private val smsHandler: SmsHandler,
  private val a2uiHandler: A2UIHandler,
  private val debugHandler: DebugHandler,
  private val appUpdateHandler: AppUpdateHandler,
  private val deviceHandler: DeviceHandler,
  private val notificationsHandler: NotificationsHandler,
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
    // Check foreground requirement for canvas/camera/screen commands
    if (
      command.startsWith(HanzoBotCanvasCommand.NamespacePrefix) ||
        command.startsWith(HanzoBotCanvasA2UICommand.NamespacePrefix) ||
        command.startsWith(HanzoBotCameraCommand.NamespacePrefix) ||
        command.startsWith(HanzoBotScreenCommand.NamespacePrefix)
    ) {
      if (!isForeground()) {
        return GatewaySession.InvokeResult.error(
          code = "NODE_BACKGROUND_UNAVAILABLE",
          message = "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        )
      }
    }

    // Check camera enabled
    if (command.startsWith(HanzoBotCameraCommand.NamespacePrefix) && !cameraEnabled()) {
      return GatewaySession.InvokeResult.error(
        code = "CAMERA_DISABLED",
        message = "CAMERA_DISABLED: enable Camera in Settings",
      )
    }

    // Check location enabled
    if (command.startsWith(HanzoBotLocationCommand.NamespacePrefix) && !locationEnabled()) {
      return GatewaySession.InvokeResult.error(
        code = "LOCATION_DISABLED",
        message = "LOCATION_DISABLED: enable Location in Settings",
      )
    }

    return when (command) {
      // Canvas commands
      HanzoBotCanvasCommand.Present.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      HanzoBotCanvasCommand.Hide.rawValue -> GatewaySession.InvokeResult.ok(null)
      HanzoBotCanvasCommand.Navigate.rawValue -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        canvas.navigate(url)
        GatewaySession.InvokeResult.ok(null)
      }
      HanzoBotCanvasCommand.Eval.rawValue -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return GatewaySession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        val result =
          try {
            canvas.eval(js)
          } catch (err: Throwable) {
            return GatewaySession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        GatewaySession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
      }
      HanzoBotCanvasCommand.Snapshot.rawValue -> {
        val snapshotParams = CanvasController.parseSnapshotParams(paramsJson)
        val base64 =
          try {
            canvas.snapshotBase64(
              format = snapshotParams.format,
              quality = snapshotParams.quality,
              maxWidth = snapshotParams.maxWidth,
            )
          } catch (err: Throwable) {
            return GatewaySession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        GatewaySession.InvokeResult.ok("""{"format":"${snapshotParams.format.rawValue}","base64":"$base64"}""")
      }

      // A2UI commands
      HanzoBotCanvasA2UICommand.Reset.rawValue -> withReadyA2ui {
        val res = canvas.eval(A2UIHandler.a2uiResetJS)
        onCanvasA2uiReset()
        GatewaySession.InvokeResult.ok(res)
      }
      HanzoBotCanvasA2UICommand.Push.rawValue, HanzoBotCanvasA2UICommand.PushJSONL.rawValue -> {
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
          val js = A2UIHandler.a2uiApplyMessagesJS(messages)
          val res = canvas.eval(js)
          onCanvasA2uiPush()
          GatewaySession.InvokeResult.ok(res)
        }
      }

      // Camera commands
      HanzoBotCameraCommand.List.rawValue -> cameraHandler.handleList()
      HanzoBotCameraCommand.Snap.rawValue -> cameraHandler.handleSnap(paramsJson)
      HanzoBotCameraCommand.Clip.rawValue -> cameraHandler.handleClip(paramsJson)

      // Location command
      HanzoBotLocationCommand.Get.rawValue -> locationHandler.handleLocationGet(paramsJson)

      // Screen command
      HanzoBotScreenCommand.Record.rawValue -> screenHandler.handleScreenRecord(paramsJson)

      // SMS command
      HanzoBotSmsCommand.Send.rawValue -> smsHandler.handleSmsSend(paramsJson)

      // Device commands
      HanzoBotDeviceCommand.Status.rawValue -> deviceHandler.handleDeviceStatus(paramsJson)
      HanzoBotDeviceCommand.Info.rawValue -> deviceHandler.handleDeviceInfo(paramsJson)
      HanzoBotDeviceCommand.Permissions.rawValue -> deviceHandler.handleDevicePermissions(paramsJson)
      HanzoBotDeviceCommand.Health.rawValue -> deviceHandler.handleDeviceHealth(paramsJson)

      // Notifications commands
      HanzoBotNotificationsCommand.List.rawValue -> notificationsHandler.handleNotificationsList(paramsJson)
      HanzoBotNotificationsCommand.Actions.rawValue -> notificationsHandler.handleNotificationsActions(paramsJson)

      // Debug commands
      "debug.ed25519" -> debugHandler.handleEd25519()
      "debug.logs" -> debugHandler.handleLogs()

      // App update
      "app.update" -> appUpdateHandler.handleUpdate(paramsJson)

      else ->
        GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
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
}
