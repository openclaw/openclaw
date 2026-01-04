package com.clawdbot.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class ClawdbotProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", ClawdbotCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", ClawdbotCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", ClawdbotCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", ClawdbotCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", ClawdbotCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", ClawdbotCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", ClawdbotCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", ClawdbotCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", ClawdbotCapability.Canvas.rawValue)
    assertEquals("camera", ClawdbotCapability.Camera.rawValue)
    assertEquals("screen", ClawdbotCapability.Screen.rawValue)
    assertEquals("voiceWake", ClawdbotCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", ClawdbotScreenCommand.Record.rawValue)
  }
}
