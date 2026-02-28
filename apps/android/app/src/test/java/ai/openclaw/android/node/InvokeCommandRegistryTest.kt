package ai.openclaw.android.node

import ai.openclaw.android.protocol.OpenClawCameraCommand
import ai.openclaw.android.protocol.OpenClawCapability
import ai.openclaw.android.protocol.OpenClawDeviceCommand
import ai.openclaw.android.protocol.OpenClawLocationCommand
import ai.openclaw.android.protocol.OpenClawNotificationsCommand
import ai.openclaw.android.protocol.OpenClawSmsCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  @Test
  fun advertisedCapabilities_respectsFeatureAvailability() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          smsAvailable = false,
          voiceWakeEnabled = false,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(OpenClawCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Screen.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Device.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Camera.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Location.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Sms.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.VoiceWake.rawValue))
  }

  @Test
  fun advertisedCapabilities_includesFeatureCapabilitiesWhenEnabled() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        NodeRuntimeFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          voiceWakeEnabled = true,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(OpenClawCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Screen.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Device.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Camera.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Location.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Sms.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.VoiceWake.rawValue))
  }

  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          smsAvailable = false,
          voiceWakeEnabled = false,
          debugBuild = false,
        ),
      )

    assertFalse(commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertFalse(commands.contains(OpenClawCameraCommand.Clip.rawValue))
    assertFalse(commands.contains(OpenClawCameraCommand.List.rawValue))
    assertFalse(commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.Actions.rawValue))
    assertFalse(commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(commands.contains("debug.logs"))
    assertFalse(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          voiceWakeEnabled = false,
          debugBuild = true,
        ),
      )

    assertTrue(commands.contains(OpenClawCameraCommand.Snap.rawValue))
    assertTrue(commands.contains(OpenClawCameraCommand.Clip.rawValue))
    assertTrue(commands.contains(OpenClawCameraCommand.List.rawValue))
    assertTrue(commands.contains(OpenClawLocationCommand.Get.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(OpenClawDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(OpenClawNotificationsCommand.Actions.rawValue))
    assertTrue(commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }
}
