package ai.openclaw.app.node

import ai.openclaw.app.protocol.OpenClawCapability
import ai.openclaw.app.protocol.OpenClawHttpCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryHttpTest {

  @Test
  fun http_command_is_advertised_when_httpEnabled_is_true() {
    val flags = NodeRuntimeFlags(
      cameraEnabled = false,
      locationEnabled = false,
      sendSmsAvailable = false,
      readSmsAvailable = false,
      smsSearchPossible = false,
      callLogAvailable = false,
      voiceWakeEnabled = false,
      motionActivityAvailable = false,
      motionPedometerAvailable = false,
      debugBuild = false,
      httpEnabled = true,
    )

    val commands = InvokeCommandRegistry.advertisedCommands(flags)

    assertTrue(commands.contains(OpenClawHttpCommand.Request.rawValue))
  }

  @Test
  fun http_command_is_NOT_advertised_when_httpEnabled_is_false() {
    val flags = NodeRuntimeFlags(
      cameraEnabled = false,
      locationEnabled = false,
      sendSmsAvailable = false,
      readSmsAvailable = false,
      smsSearchPossible = false,
      callLogAvailable = false,
      voiceWakeEnabled = false,
      motionActivityAvailable = false,
      motionPedometerAvailable = false,
      debugBuild = false,
      httpEnabled = false,
    )

    val commands = InvokeCommandRegistry.advertisedCommands(flags)

    assertFalse(commands.contains(OpenClawHttpCommand.Request.rawValue))
  }

  @Test
  fun http_capability_is_advertised_when_httpEnabled_is_true() {
    val flags = NodeRuntimeFlags(
      cameraEnabled = false,
      locationEnabled = false,
      sendSmsAvailable = false,
      readSmsAvailable = false,
      smsSearchPossible = false,
      callLogAvailable = false,
      voiceWakeEnabled = false,
      motionActivityAvailable = false,
      motionPedometerAvailable = false,
      debugBuild = false,
      httpEnabled = true,
    )

    val capabilities = InvokeCommandRegistry.advertisedCapabilities(flags)

    assertTrue(capabilities.contains(OpenClawCapability.Http.rawValue))
  }

  @Test
  fun http_capability_is_NOT_advertised_when_httpEnabled_is_false() {
    val flags = NodeRuntimeFlags(
      cameraEnabled = false,
      locationEnabled = false,
      sendSmsAvailable = false,
      readSmsAvailable = false,
      smsSearchPossible = false,
      callLogAvailable = false,
      voiceWakeEnabled = false,
      motionActivityAvailable = false,
      motionPedometerAvailable = false,
      debugBuild = false,
      httpEnabled = false,
    )

    val capabilities = InvokeCommandRegistry.advertisedCapabilities(flags)

    assertFalse(capabilities.contains(OpenClawCapability.Http.rawValue))
  }
}
