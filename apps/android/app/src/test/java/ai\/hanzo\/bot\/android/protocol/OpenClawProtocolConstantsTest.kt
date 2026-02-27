package ai.hanzo.bot.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class BotProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", BotCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", BotCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", BotCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", BotCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", BotCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", BotCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", BotCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", BotCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", BotCapability.Canvas.rawValue)
    assertEquals("camera", BotCapability.Camera.rawValue)
    assertEquals("screen", BotCapability.Screen.rawValue)
    assertEquals("voiceWake", BotCapability.VoiceWake.rawValue)
    assertEquals("location", BotCapability.Location.rawValue)
    assertEquals("sms", BotCapability.Sms.rawValue)
    assertEquals("device", BotCapability.Device.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", BotCameraCommand.List.rawValue)
    assertEquals("camera.snap", BotCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", BotCameraCommand.Clip.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", BotScreenCommand.Record.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", BotNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", BotNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", BotDeviceCommand.Status.rawValue)
    assertEquals("device.info", BotDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", BotDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", BotDeviceCommand.Health.rawValue)
  }
}
