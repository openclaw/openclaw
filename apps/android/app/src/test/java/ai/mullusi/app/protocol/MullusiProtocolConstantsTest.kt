package ai.mullusi.app.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class MullusiProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", MullusiCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", MullusiCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", MullusiCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", MullusiCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", MullusiCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", MullusiCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", MullusiCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", MullusiCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", MullusiCapability.Canvas.rawValue)
    assertEquals("camera", MullusiCapability.Camera.rawValue)
    assertEquals("voiceWake", MullusiCapability.VoiceWake.rawValue)
    assertEquals("location", MullusiCapability.Location.rawValue)
    assertEquals("sms", MullusiCapability.Sms.rawValue)
    assertEquals("device", MullusiCapability.Device.rawValue)
    assertEquals("notifications", MullusiCapability.Notifications.rawValue)
    assertEquals("system", MullusiCapability.System.rawValue)
    assertEquals("photos", MullusiCapability.Photos.rawValue)
    assertEquals("contacts", MullusiCapability.Contacts.rawValue)
    assertEquals("calendar", MullusiCapability.Calendar.rawValue)
    assertEquals("motion", MullusiCapability.Motion.rawValue)
    assertEquals("callLog", MullusiCapability.CallLog.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", MullusiCameraCommand.List.rawValue)
    assertEquals("camera.snap", MullusiCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", MullusiCameraCommand.Clip.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", MullusiNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", MullusiNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", MullusiDeviceCommand.Status.rawValue)
    assertEquals("device.info", MullusiDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", MullusiDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", MullusiDeviceCommand.Health.rawValue)
  }

  @Test
  fun systemCommandsUseStableStrings() {
    assertEquals("system.notify", MullusiSystemCommand.Notify.rawValue)
  }

  @Test
  fun photosCommandsUseStableStrings() {
    assertEquals("photos.latest", MullusiPhotosCommand.Latest.rawValue)
  }

  @Test
  fun contactsCommandsUseStableStrings() {
    assertEquals("contacts.search", MullusiContactsCommand.Search.rawValue)
    assertEquals("contacts.add", MullusiContactsCommand.Add.rawValue)
  }

  @Test
  fun calendarCommandsUseStableStrings() {
    assertEquals("calendar.events", MullusiCalendarCommand.Events.rawValue)
    assertEquals("calendar.add", MullusiCalendarCommand.Add.rawValue)
  }

  @Test
  fun motionCommandsUseStableStrings() {
    assertEquals("motion.activity", MullusiMotionCommand.Activity.rawValue)
    assertEquals("motion.pedometer", MullusiMotionCommand.Pedometer.rawValue)
  }

  @Test
  fun smsCommandsUseStableStrings() {
    assertEquals("sms.send", MullusiSmsCommand.Send.rawValue)
    assertEquals("sms.search", MullusiSmsCommand.Search.rawValue)
  }

  @Test
  fun callLogCommandsUseStableStrings() {
    assertEquals("callLog.search", MullusiCallLogCommand.Search.rawValue)
  }

}
