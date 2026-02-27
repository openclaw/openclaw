package ai.hanzo.bot.android.node

import ai.hanzo.bot.android.protocol.BotCameraCommand
import ai.hanzo.bot.android.protocol.BotDeviceCommand
import ai.hanzo.bot.android.protocol.BotLocationCommand
import ai.hanzo.bot.android.protocol.BotNotificationsCommand
import ai.hanzo.bot.android.protocol.BotSmsCommand
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

    assertFalse(commands.contains(BotCameraCommand.Snap.rawValue))
    assertFalse(commands.contains(BotCameraCommand.Clip.rawValue))
    assertFalse(commands.contains(BotCameraCommand.List.rawValue))
    assertFalse(commands.contains(BotLocationCommand.Get.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(BotNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(BotNotificationsCommand.Actions.rawValue))
    assertFalse(commands.contains(BotSmsCommand.Send.rawValue))
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

    assertTrue(commands.contains(BotCameraCommand.Snap.rawValue))
    assertTrue(commands.contains(BotCameraCommand.Clip.rawValue))
    assertTrue(commands.contains(BotCameraCommand.List.rawValue))
    assertTrue(commands.contains(BotLocationCommand.Get.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(BotDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(BotNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(BotNotificationsCommand.Actions.rawValue))
    assertTrue(commands.contains(BotSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }
}
