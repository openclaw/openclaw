package ai.mullusi.app.node

import ai.mullusi.app.protocol.MullusiCalendarCommand
import ai.mullusi.app.protocol.MullusiCameraCommand
import ai.mullusi.app.protocol.MullusiCallLogCommand
import ai.mullusi.app.protocol.MullusiCapability
import ai.mullusi.app.protocol.MullusiContactsCommand
import ai.mullusi.app.protocol.MullusiDeviceCommand
import ai.mullusi.app.protocol.MullusiLocationCommand
import ai.mullusi.app.protocol.MullusiMotionCommand
import ai.mullusi.app.protocol.MullusiNotificationsCommand
import ai.mullusi.app.protocol.MullusiPhotosCommand
import ai.mullusi.app.protocol.MullusiSmsCommand
import ai.mullusi.app.protocol.MullusiSystemCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  private val coreCapabilities =
    setOf(
      MullusiCapability.Canvas.rawValue,
      MullusiCapability.Device.rawValue,
      MullusiCapability.Notifications.rawValue,
      MullusiCapability.System.rawValue,
      MullusiCapability.Photos.rawValue,
      MullusiCapability.Contacts.rawValue,
      MullusiCapability.Calendar.rawValue,
    )

  private val optionalCapabilities =
    setOf(
      MullusiCapability.Camera.rawValue,
      MullusiCapability.Location.rawValue,
      MullusiCapability.Sms.rawValue,
      MullusiCapability.CallLog.rawValue,
      MullusiCapability.VoiceWake.rawValue,
      MullusiCapability.Motion.rawValue,
    )

  private val coreCommands =
    setOf(
      MullusiDeviceCommand.Status.rawValue,
      MullusiDeviceCommand.Info.rawValue,
      MullusiDeviceCommand.Permissions.rawValue,
      MullusiDeviceCommand.Health.rawValue,
      MullusiNotificationsCommand.List.rawValue,
      MullusiNotificationsCommand.Actions.rawValue,
      MullusiSystemCommand.Notify.rawValue,
      MullusiPhotosCommand.Latest.rawValue,
      MullusiContactsCommand.Search.rawValue,
      MullusiContactsCommand.Add.rawValue,
      MullusiCalendarCommand.Events.rawValue,
      MullusiCalendarCommand.Add.rawValue,
    )

  private val optionalCommands =
    setOf(
      MullusiCameraCommand.Snap.rawValue,
      MullusiCameraCommand.Clip.rawValue,
      MullusiCameraCommand.List.rawValue,
      MullusiLocationCommand.Get.rawValue,
      MullusiMotionCommand.Activity.rawValue,
      MullusiMotionCommand.Pedometer.rawValue,
      MullusiSmsCommand.Send.rawValue,
      MullusiSmsCommand.Search.rawValue,
      MullusiCallLogCommand.Search.rawValue,
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
          smsSearchPossible = true,
          callLogAvailable = true,
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
          smsSearchPossible = true,
          callLogAvailable = true,
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
          smsSearchPossible = false,
          callLogAvailable = false,
          voiceWakeEnabled = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(MullusiMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(MullusiMotionCommand.Pedometer.rawValue))
  }

  @Test
  fun advertisedCommands_splitsSmsSendAndSearchAvailability() {
    val readOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(readSmsAvailable = true, smsSearchPossible = true),
      )
    val sendOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(sendSmsAvailable = true),
      )
    val requestableSearchCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCommands.contains(MullusiSmsCommand.Search.rawValue))
    assertFalse(readOnlyCommands.contains(MullusiSmsCommand.Send.rawValue))
    assertTrue(sendOnlyCommands.contains(MullusiSmsCommand.Send.rawValue))
    assertFalse(sendOnlyCommands.contains(MullusiSmsCommand.Search.rawValue))
    assertTrue(requestableSearchCommands.contains(MullusiSmsCommand.Search.rawValue))
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
    val requestableSearchCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCapabilities.contains(MullusiCapability.Sms.rawValue))
    assertTrue(sendOnlyCapabilities.contains(MullusiCapability.Sms.rawValue))
    assertFalse(requestableSearchCapabilities.contains(MullusiCapability.Sms.rawValue))
  }

  @Test
  fun advertisedCommands_excludesCallLogWhenUnavailable() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags(callLogAvailable = false))

    assertFalse(commands.contains(MullusiCallLogCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_excludesCallLogWhenUnavailable() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags(callLogAvailable = false))

    assertFalse(capabilities.contains(MullusiCapability.CallLog.rawValue))
  }

  @Test
  fun advertisedCapabilities_includesVoiceWakeWithoutAdvertisingCommands() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags(voiceWakeEnabled = true))
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags(voiceWakeEnabled = true))

    assertTrue(capabilities.contains(MullusiCapability.VoiceWake.rawValue))
    assertFalse(commands.any { it.contains("voice", ignoreCase = true) })
  }

  @Test
  fun find_returnsForegroundMetadataForCameraCommands() {
    val list = InvokeCommandRegistry.find(MullusiCameraCommand.List.rawValue)
    val location = InvokeCommandRegistry.find(MullusiLocationCommand.Get.rawValue)

    assertNotNull(list)
    assertEquals(true, list?.requiresForeground)
    assertNotNull(location)
    assertEquals(false, location?.requiresForeground)
  }

  @Test
  fun find_returnsNullForUnknownCommand() {
    assertNull(InvokeCommandRegistry.find("not.real"))
  }

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    smsSearchPossible: Boolean = false,
    callLogAvailable: Boolean = false,
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
      smsSearchPossible = smsSearchPossible,
      callLogAvailable = callLogAvailable,
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
