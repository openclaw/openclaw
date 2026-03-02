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
  private val coreCapabilities =
    setOf(
      OpenClawCapability.Canvas.rawValue,
      OpenClawCapability.Screen.rawValue,
      OpenClawCapability.Device.rawValue,
      OpenClawCapability.Notifications.rawValue,
      OpenClawCapability.System.rawValue,
      OpenClawCapability.AppUpdate.rawValue,
      OpenClawCapability.Photos.rawValue,
      OpenClawCapability.Contacts.rawValue,
      OpenClawCapability.Calendar.rawValue,
    )

  private val optionalCapabilities =
    setOf(
      OpenClawCapability.Camera.rawValue,
      OpenClawCapability.Location.rawValue,
      OpenClawCapability.Sms.rawValue,
      OpenClawCapability.VoiceWake.rawValue,
      OpenClawCapability.Motion.rawValue,
    )

  private val coreCommands =
    setOf(
      OpenClawDeviceCommand.Status.rawValue,
      OpenClawDeviceCommand.Info.rawValue,
      OpenClawDeviceCommand.Permissions.rawValue,
      OpenClawDeviceCommand.Health.rawValue,
      OpenClawNotificationsCommand.List.rawValue,
      OpenClawNotificationsCommand.Actions.rawValue,
      OpenClawSystemCommand.Notify.rawValue,
      OpenClawPhotosCommand.Latest.rawValue,
      OpenClawContactsCommand.Search.rawValue,
      OpenClawContactsCommand.Add.rawValue,
      OpenClawCalendarCommand.Events.rawValue,
      OpenClawCalendarCommand.Add.rawValue,
      "app.update",
    )

  private val optionalCommands =
    setOf(
      OpenClawCameraCommand.Snap.rawValue,
      OpenClawCameraCommand.Clip.rawValue,
      OpenClawCameraCommand.List.rawValue,
      OpenClawLocationCommand.Get.rawValue,
      OpenClawMotionCommand.Activity.rawValue,
      OpenClawMotionCommand.Pedometer.rawValue,
      OpenClawSmsCommand.Send.rawValue,
    )

  private val debugCommands = setOf("debug.logs", "debug.ed25519")

  @Test
  fun advertisedCapabilities_respectsFeatureAvailability() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags())

    assertContainsAll(capabilities, coreCapabilities)
    assertMissingAll(capabilities, optionalCapabilities)
  }

  @Test
  fun advertisedCapabilities_includesFeatureCapabilitiesWhenEnabled() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          voiceWakeEnabled = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
        ),
      )

    assertContainsAll(capabilities, coreCapabilities + optionalCapabilities)
  }

  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags())

    assertContainsAll(commands, coreCommands)
    assertMissingAll(commands, optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          debugBuild = true,
        ),
      )

    assertContainsAll(commands, coreCommands + optionalCommands + debugCommands)
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

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    smsAvailable: Boolean = false,
    voiceWakeEnabled: Boolean = false,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    debugBuild: Boolean = false,
  ): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled,
      locationEnabled = locationEnabled,
      smsAvailable = smsAvailable,
      voiceWakeEnabled = voiceWakeEnabled,
      motionActivityAvailable = motionActivityAvailable,
      motionPedometerAvailable = motionPedometerAvailable,
      debugBuild = debugBuild,
    )

  private fun assertContainsAll(actual: List<String>, expected: Set<String>) {
    expected.forEach { value -> assertTrue(actual.contains(value)) }
  }

  private fun assertMissingAll(actual: List<String>, forbidden: Set<String>) {
    forbidden.forEach { value -> assertFalse(actual.contains(value)) }
  }
}
