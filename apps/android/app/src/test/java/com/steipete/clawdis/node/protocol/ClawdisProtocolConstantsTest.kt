package com.steipete.clawdis.node.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class ClawdisProtocolConstantsTest {
  @Test
  fun mapsKnownScreenCommandsToCanvas() {
    val mappings =
      listOf(
        Pair(ClawdisScreenCommand.Show, ClawdisCanvasCommand.Show),
        Pair(ClawdisScreenCommand.Hide, ClawdisCanvasCommand.Hide),
        Pair(ClawdisScreenCommand.SetMode, ClawdisCanvasCommand.SetMode),
        Pair(ClawdisScreenCommand.Navigate, ClawdisCanvasCommand.Navigate),
        Pair(ClawdisScreenCommand.Eval, ClawdisCanvasCommand.Eval),
        Pair(ClawdisScreenCommand.Snapshot, ClawdisCanvasCommand.Snapshot),
      )

    for ((screen, canvas) in mappings) {
      assertEquals(
        canvas.rawValue,
        ClawdisInvokeCommandAliases.canonicalizeScreenToCanvas(screen.rawValue),
      )
    }
  }

  @Test
  fun mapsUnknownScreenNamespaceToCanvas() {
    assertEquals("canvas.foo", ClawdisInvokeCommandAliases.canonicalizeScreenToCanvas("screen.foo"))
  }

  @Test
  fun leavesNonScreenCommandsUnchanged() {
    assertEquals(
      ClawdisCameraCommand.Snap.rawValue,
      ClawdisInvokeCommandAliases.canonicalizeScreenToCanvas(ClawdisCameraCommand.Snap.rawValue),
    )
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", ClawdisCapability.Canvas.rawValue)
    assertEquals("camera", ClawdisCapability.Camera.rawValue)
    assertEquals("voiceWake", ClawdisCapability.VoiceWake.rawValue)
  }
}
