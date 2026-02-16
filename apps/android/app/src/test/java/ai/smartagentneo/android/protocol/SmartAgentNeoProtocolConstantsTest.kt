package ai.smartagentneo.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class SmartAgentNeoProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", SmartAgentNeoCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", SmartAgentNeoCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", SmartAgentNeoCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", SmartAgentNeoCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", SmartAgentNeoCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", SmartAgentNeoCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", SmartAgentNeoCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", SmartAgentNeoCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", SmartAgentNeoCapability.Canvas.rawValue)
    assertEquals("camera", SmartAgentNeoCapability.Camera.rawValue)
    assertEquals("screen", SmartAgentNeoCapability.Screen.rawValue)
    assertEquals("voiceWake", SmartAgentNeoCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", SmartAgentNeoScreenCommand.Record.rawValue)
  }
}
