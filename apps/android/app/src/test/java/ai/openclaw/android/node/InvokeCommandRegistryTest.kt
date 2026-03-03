package ai.openclaw.android.node

import ai.openclaw.android.protocol.OpenClawCalendarCommand
import ai.openclaw.android.protocol.OpenClawCameraCommand
import ai.openclaw.android.protocol.OpenClawCapability
import ai.openclaw.android.protocol.OpenClawContactsCommand
import ai.openclaw.android.protocol.OpenClawDeviceCommand
import ai.openclaw.android.protocol.OpenClawLocationCommand
import ai.openclaw.android.protocol.OpenClawMotionCommand
import ai.openclaw.android.protocol.OpenClawNotificationsCommand
import ai.openclaw.android.protocol.OpenClawPhotosCommand
import ai.openclaw.android.protocol.OpenClawSmsCommand
import ai.openclaw.android.protocol.OpenClawSystemCommand
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
          motionActivityAvailable = false,
          motionPedometerAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(OpenClawCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Screen.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Device.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Notifications.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.System.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.AppUpdate.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Camera.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Location.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Sms.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.VoiceWake.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Photos.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Contacts.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Calendar.rawValue))
    assertFalse(capabilities.contains(OpenClawCapability.Motion.rawValue))
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
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(OpenClawCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Screen.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Device.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Notifications.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.System.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.AppUpdate.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Camera.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Location.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Sms.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.VoiceWake.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Photos.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Contacts.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Calendar.rawValue))
    assertTrue(capabilities.contains(OpenClawCapability.Motion.rawValue))
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
          motionActivityAvailable = false,
          motionPedometerAvailable = false,
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
    assertTrue(commands.contains(OpenClawSystemCommand.Notify.rawValue))
    assertTrue(commands.contains(OpenClawPhotosCommand.Latest.rawValue))
    assertTrue(commands.contains(OpenClawContactsCommand.Search.rawValue))
    assertTrue(commands.contains(OpenClawContactsCommand.Add.rawValue))
    assertTrue(commands.contains(OpenClawCalendarCommand.Events.rawValue))
    assertTrue(commands.contains(OpenClawCalendarCommand.Add.rawValue))
    assertFalse(commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
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
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
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
    assertTrue(commands.contains(OpenClawSystemCommand.Notify.rawValue))
    assertTrue(commands.contains(OpenClawPhotosCommand.Latest.rawValue))
    assertTrue(commands.contains(OpenClawContactsCommand.Search.rawValue))
    assertTrue(commands.contains(OpenClawContactsCommand.Add.rawValue))
    assertTrue(commands.contains(OpenClawCalendarCommand.Events.rawValue))
    assertTrue(commands.contains(OpenClawCalendarCommand.Add.rawValue))
    assertTrue(commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertTrue(commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
    assertTrue(commands.contains(OpenClawSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }

  @Test
  fun advertisedCommands_onlyIncludesSupportedMotionCommands() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          smsAvailable = false,
          voiceWakeEnabled = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
  }
}
