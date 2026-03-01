package ai.hanzo.bot.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class BotProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", HanzoBotCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", HanzoBotCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", HanzoBotCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", HanzoBotCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", HanzoBotCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", HanzoBotCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", HanzoBotCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", HanzoBotCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", HanzoBotCapability.Canvas.rawValue)
    assertEquals("camera", HanzoBotCapability.Camera.rawValue)
    assertEquals("screen", HanzoBotCapability.Screen.rawValue)
    assertEquals("voiceWake", HanzoBotCapability.VoiceWake.rawValue)
    assertEquals("location", HanzoBotCapability.Location.rawValue)
    assertEquals("sms", HanzoBotCapability.Sms.rawValue)
    assertEquals("device", HanzoBotCapability.Device.rawValue)
    assertEquals("photos", HanzoBotCapability.Photos.rawValue)
    assertEquals("contacts", HanzoBotCapability.Contacts.rawValue)
    assertEquals("calendar", HanzoBotCapability.Calendar.rawValue)
    assertEquals("motion", HanzoBotCapability.Motion.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", HanzoBotCameraCommand.List.rawValue)
    assertEquals("camera.snap", HanzoBotCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", HanzoBotCameraCommand.Clip.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", HanzoBotScreenCommand.Record.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", HanzoBotNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", HanzoBotNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", HanzoBotDeviceCommand.Status.rawValue)
    assertEquals("device.info", HanzoBotDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", HanzoBotDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", HanzoBotDeviceCommand.Health.rawValue)
  }

  @Test
  fun systemCommandsUseStableStrings() {
    assertEquals("system.notify", HanzoBotSystemCommand.Notify.rawValue)
  }

  @Test
  fun photosCommandsUseStableStrings() {
    assertEquals("photos.latest", HanzoBotPhotosCommand.Latest.rawValue)
  }

  @Test
  fun contactsCommandsUseStableStrings() {
    assertEquals("contacts.search", HanzoBotContactsCommand.Search.rawValue)
    assertEquals("contacts.add", HanzoBotContactsCommand.Add.rawValue)
  }

  @Test
  fun calendarCommandsUseStableStrings() {
    assertEquals("calendar.events", HanzoBotCalendarCommand.Events.rawValue)
    assertEquals("calendar.add", HanzoBotCalendarCommand.Add.rawValue)
  }

  @Test
  fun motionCommandsUseStableStrings() {
    assertEquals("motion.activity", HanzoBotMotionCommand.Activity.rawValue)
    assertEquals("motion.pedometer", HanzoBotMotionCommand.Pedometer.rawValue)
  }
}
