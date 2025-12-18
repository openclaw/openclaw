package com.steipete.clawdis.node.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class ClawdisProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.show", ClawdisCanvasCommand.Show.rawValue)
    assertEquals("canvas.hide", ClawdisCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", ClawdisCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", ClawdisCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", ClawdisCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", ClawdisCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", ClawdisCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", ClawdisCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", ClawdisCapability.Canvas.rawValue)
    assertEquals("camera", ClawdisCapability.Camera.rawValue)
    assertEquals("voiceWake", ClawdisCapability.VoiceWake.rawValue)
  }
}
