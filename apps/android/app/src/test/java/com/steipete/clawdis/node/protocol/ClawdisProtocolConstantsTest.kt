package com.steipete.clawdis.node.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class ClawdisProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.show", ClawdisCanvasCommand.Show.rawValue)
    assertEquals("canvas.hide", ClawdisCanvasCommand.Hide.rawValue)
    assertEquals("canvas.setMode", ClawdisCanvasCommand.SetMode.rawValue)
    assertEquals("canvas.navigate", ClawdisCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", ClawdisCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", ClawdisCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", ClawdisCapability.Canvas.rawValue)
    assertEquals("camera", ClawdisCapability.Camera.rawValue)
    assertEquals("voiceWake", ClawdisCapability.VoiceWake.rawValue)
  }
}
