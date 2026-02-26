package ai.openclaw.android.node

import ai.openclaw.android.protocol.OpenClawCameraCommand
import ai.openclaw.android.protocol.OpenClawLocationCommand
import ai.openclaw.android.protocol.OpenClawNotificationsCommand
import ai.openclaw.android.protocol.OpenClawSmsCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        cameraEnabled = false,
        locationEnabled = false,
        smsAvailable = false,
        debugBuild = false,
      )

    assertFalse(commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertFalse(commands.contains(OpenClawCameraCommand.Clip.rawValue))
    assertFalse(commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.List.rawValue))
    assertFalse(commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(commands.contains("debug.logs"))
    assertFalse(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        cameraEnabled = true,
        locationEnabled = true,
        smsAvailable = true,
        debugBuild = true,
      )

    assertTrue(commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertTrue(commands.contains(OpenClawCameraCommand.Clip.rawValue))
    assertTrue(commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }
}
