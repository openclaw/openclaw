package ai.hanzo.bot.android.node

import ai.hanzo.bot.android.protocol.HanzoBotCalendarCommand
import ai.hanzo.bot.android.protocol.HanzoBotCameraCommand
import ai.hanzo.bot.android.protocol.HanzoBotCapability
import ai.hanzo.bot.android.protocol.HanzoBotContactsCommand
import ai.hanzo.bot.android.protocol.HanzoBotDeviceCommand
import ai.hanzo.bot.android.protocol.HanzoBotLocationCommand
import ai.hanzo.bot.android.protocol.HanzoBotMotionCommand
import ai.hanzo.bot.android.protocol.HanzoBotNotificationsCommand
import ai.hanzo.bot.android.protocol.HanzoBotPhotosCommand
import ai.hanzo.bot.android.protocol.HanzoBotSmsCommand
import ai.hanzo.bot.android.protocol.HanzoBotSystemCommand
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
          motionAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(HanzoBotCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Screen.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Device.rawValue))
    assertFalse(capabilities.contains(HanzoBotCapability.Camera.rawValue))
    assertFalse(capabilities.contains(HanzoBotCapability.Location.rawValue))
    assertFalse(capabilities.contains(HanzoBotCapability.Sms.rawValue))
    assertFalse(capabilities.contains(HanzoBotCapability.VoiceWake.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Photos.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Contacts.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Calendar.rawValue))
    assertFalse(capabilities.contains(HanzoBotCapability.Motion.rawValue))
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
          motionAvailable = true,
          debugBuild = false,
        ),
      )

    assertTrue(capabilities.contains(HanzoBotCapability.Canvas.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Screen.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Device.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Camera.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Location.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Sms.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.VoiceWake.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Photos.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Contacts.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Calendar.rawValue))
    assertTrue(capabilities.contains(HanzoBotCapability.Motion.rawValue))
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
          motionAvailable = false,
          debugBuild = false,
        ),
      )

    assertFalse(commands.contains(HanzoBotCameraCommand.Snap.rawValue))
    assertFalse(commands.contains(HanzoBotCameraCommand.Clip.rawValue))
    assertFalse(commands.contains(HanzoBotCameraCommand.List.rawValue))
    assertFalse(commands.contains(HanzoBotLocationCommand.Get.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(HanzoBotNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(HanzoBotNotificationsCommand.Actions.rawValue))
    assertTrue(commands.contains(HanzoBotSystemCommand.Notify.rawValue))
    assertTrue(commands.contains(HanzoBotPhotosCommand.Latest.rawValue))
    assertTrue(commands.contains(HanzoBotContactsCommand.Search.rawValue))
    assertTrue(commands.contains(HanzoBotContactsCommand.Add.rawValue))
    assertTrue(commands.contains(HanzoBotCalendarCommand.Events.rawValue))
    assertTrue(commands.contains(HanzoBotCalendarCommand.Add.rawValue))
    assertFalse(commands.contains(HanzoBotMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(HanzoBotMotionCommand.Pedometer.rawValue))
    assertFalse(commands.contains(HanzoBotSmsCommand.Send.rawValue))
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
          motionAvailable = true,
          debugBuild = true,
        ),
      )

    assertTrue(commands.contains(HanzoBotCameraCommand.Snap.rawValue))
    assertTrue(commands.contains(HanzoBotCameraCommand.Clip.rawValue))
    assertTrue(commands.contains(HanzoBotCameraCommand.List.rawValue))
    assertTrue(commands.contains(HanzoBotLocationCommand.Get.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(HanzoBotDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(HanzoBotNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(HanzoBotNotificationsCommand.Actions.rawValue))
    assertTrue(commands.contains(HanzoBotSystemCommand.Notify.rawValue))
    assertTrue(commands.contains(HanzoBotPhotosCommand.Latest.rawValue))
    assertTrue(commands.contains(HanzoBotContactsCommand.Search.rawValue))
    assertTrue(commands.contains(HanzoBotContactsCommand.Add.rawValue))
    assertTrue(commands.contains(HanzoBotCalendarCommand.Events.rawValue))
    assertTrue(commands.contains(HanzoBotCalendarCommand.Add.rawValue))
    assertTrue(commands.contains(HanzoBotMotionCommand.Activity.rawValue))
    assertTrue(commands.contains(HanzoBotMotionCommand.Pedometer.rawValue))
    assertTrue(commands.contains(HanzoBotSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }
}
