package com.steipete.clawdis.node.protocol

enum class ClawdisCapability(val rawValue: String) {
  Canvas("canvas"),
  Camera("camera"),
  VoiceWake("voiceWake"),
}

enum class ClawdisScreenCommand(val rawValue: String) {
  Show("screen.show"),
  Hide("screen.hide"),
  SetMode("screen.setMode"),
  Navigate("screen.navigate"),
  Eval("screen.eval"),
  Snapshot("screen.snapshot"),
  ;

  companion object {
    const val NamespacePrefix: String = "screen."
  }
}

enum class ClawdisCanvasCommand(val rawValue: String) {
  Show("canvas.show"),
  Hide("canvas.hide"),
  SetMode("canvas.setMode"),
  Navigate("canvas.navigate"),
  Eval("canvas.eval"),
  Snapshot("canvas.snapshot"),
  ;

  companion object {
    const val NamespacePrefix: String = "canvas."
  }
}

enum class ClawdisCameraCommand(val rawValue: String) {
  Snap("camera.snap"),
  Clip("camera.clip"),
  ;

  companion object {
    const val NamespacePrefix: String = "camera."
  }
}

object ClawdisInvokeCommandAliases {
  fun canonicalizeScreenToCanvas(command: String): String {
    if (command.startsWith(ClawdisScreenCommand.NamespacePrefix)) {
      return ClawdisCanvasCommand.NamespacePrefix +
        command.removePrefix(ClawdisScreenCommand.NamespacePrefix)
    }
    return command
  }
}
