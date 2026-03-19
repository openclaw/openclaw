package ai.openclaw.app.node

import ai.openclaw.app.protocol.OpenClawCalendarCommand
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.protocol.OpenClawCallLogCommand
import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawContactsCommand
import ai.openclaw.app.protocol.OpenClawDeviceCommand
import ai.openclaw.app.protocol.OpenClawLocationCommand
import ai.openclaw.app.protocol.OpenClawMotionCommand
import ai.openclaw.app.protocol.OpenClawNotificationsCommand
import ai.openclaw.app.protocol.OpenClawPhotosCommand
import ai.openclaw.app.protocol.OpenClawSmsCommand
import ai.openclaw.app.protocol.OpenClawSystemCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  private val coreCapabilities =
    setOf(
      OpenClawCapability.Canvas.rawValue,
      OpenClawCapability.Device.rawValue,
      OpenClawCapability.Notifications.rawValue,
      OpenClawCapability.System.rawValue,
      OpenClawCapability.Photos.rawValue,
      OpenClawCapability.Contacts.rawValue,
      OpenClawCapability.Calendar.rawValue,
      OpenClawCapability.CallLog.rawValue,
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
      OpenClawCallLogCommand.Search.rawValue,
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
      OpenClawSmsCommand.Search.rawValue,
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
          sendSmsAvailable = true,
          readSmsAvailable = true,
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
          sendSmsAvailable = true,
          readSmsAvailable = true,
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
          sendSmsAvailable = false,
          readSmsAvailable = false,
          voiceWakeEnabled = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(OpenClawMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(OpenClawMotionCommand.Pedometer.rawValue))
  }

  @Test
  fun advertisedCommands_splitsSmsSendAndSearchAvailability() {
    val readOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(readSmsAvailable = true),
      )
    val sendOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(sendSmsAvailable = true),
      )

    assertTrue(readOnlyCommands.contains(OpenClawSmsCommand.Search.rawValue))
    assertFalse(readOnlyCommands.contains(OpenClawSmsCommand.Send.rawValue))
    assertTrue(sendOnlyCommands.contains(OpenClawSmsCommand.Send.rawValue))
    assertFalse(sendOnlyCommands.contains(OpenClawSmsCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_includeSmsWhenEitherSmsPathIsAvailable() {
    val readOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(readSmsAvailable = true),
      )
    val sendOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(sendSmsAvailable = true),
      )

    assertTrue(readOnlyCapabilities.contains(OpenClawCapability.Sms.rawValue))
    assertTrue(sendOnlyCapabilities.contains(OpenClawCapability.Sms.rawValue))
  }

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    voiceWakeEnabled: Boolean = false,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    debugBuild: Boolean = false,
  ): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled,
      locationEnabled = locationEnabled,
      sendSmsAvailable = sendSmsAvailable,
      readSmsAvailable = readSmsAvailable,
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
