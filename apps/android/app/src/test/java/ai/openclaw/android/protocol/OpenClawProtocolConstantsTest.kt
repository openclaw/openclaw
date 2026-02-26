package ai.openclaw.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class OpenClawProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", OpenClawCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", OpenClawCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", OpenClawCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", OpenClawCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", OpenClawCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", OpenClawCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", OpenClawCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", OpenClawCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", OpenClawCapability.Canvas.rawValue)
    assertEquals("camera", OpenClawCapability.Camera.rawValue)
    assertEquals("screen", OpenClawCapability.Screen.rawValue)
    assertEquals("voiceWake", OpenClawCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", OpenClawScreenCommand.Record.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", OpenClawNotificationsCommand.List.rawValue)
  }
}
