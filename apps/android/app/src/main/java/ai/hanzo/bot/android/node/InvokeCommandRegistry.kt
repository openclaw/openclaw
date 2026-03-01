package ai.hanzo.bot.android.node

import ai.hanzo.bot.android.protocol.HanzoBotCalendarCommand
import ai.hanzo.bot.android.protocol.HanzoBotCanvasA2UICommand
import ai.hanzo.bot.android.protocol.HanzoBotCanvasCommand
import ai.hanzo.bot.android.protocol.HanzoBotCameraCommand
import ai.hanzo.bot.android.protocol.HanzoBotCapability
import ai.hanzo.bot.android.protocol.HanzoBotContactsCommand
import ai.hanzo.bot.android.protocol.HanzoBotDeviceCommand
import ai.hanzo.bot.android.protocol.HanzoBotLocationCommand
import ai.hanzo.bot.android.protocol.HanzoBotMotionCommand
import ai.hanzo.bot.android.protocol.HanzoBotNotificationsCommand
import ai.hanzo.bot.android.protocol.HanzoBotPhotosCommand
import ai.hanzo.bot.android.protocol.HanzoBotScreenCommand
import ai.hanzo.bot.android.protocol.HanzoBotSmsCommand
import ai.hanzo.bot.android.protocol.HanzoBotSystemCommand

data class NodeRuntimeFlags(
  val cameraEnabled: Boolean,
  val locationEnabled: Boolean,
  val smsAvailable: Boolean,
  val voiceWakeEnabled: Boolean,
  val motionActivityAvailable: Boolean,
  val motionPedometerAvailable: Boolean,
  val debugBuild: Boolean,
)

enum class InvokeCommandAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  MotionActivityAvailable,
  MotionPedometerAvailable,
  DebugBuild,
}

enum class NodeCapabilityAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  VoiceWakeEnabled,
  MotionAvailable,
}

data class NodeCapabilitySpec(
  val name: String,
  val availability: NodeCapabilityAvailability = NodeCapabilityAvailability.Always,
)

data class InvokeCommandSpec(
  val name: String,
  val requiresForeground: Boolean = false,
  val availability: InvokeCommandAvailability = InvokeCommandAvailability.Always,
)

object InvokeCommandRegistry {
  val capabilityManifest: List<NodeCapabilitySpec> =
    listOf(
      NodeCapabilitySpec(name = HanzoBotCapability.Canvas.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.Screen.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.Device.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.Notifications.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.System.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.AppUpdate.rawValue),
      NodeCapabilitySpec(
        name = HanzoBotCapability.Camera.rawValue,
        availability = NodeCapabilityAvailability.CameraEnabled,
      ),
      NodeCapabilitySpec(
        name = HanzoBotCapability.Sms.rawValue,
        availability = NodeCapabilityAvailability.SmsAvailable,
      ),
      NodeCapabilitySpec(
        name = HanzoBotCapability.VoiceWake.rawValue,
        availability = NodeCapabilityAvailability.VoiceWakeEnabled,
      ),
      NodeCapabilitySpec(
        name = HanzoBotCapability.Location.rawValue,
        availability = NodeCapabilityAvailability.LocationEnabled,
      ),
      NodeCapabilitySpec(name = HanzoBotCapability.Photos.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.Contacts.rawValue),
      NodeCapabilitySpec(name = HanzoBotCapability.Calendar.rawValue),
      NodeCapabilitySpec(
        name = HanzoBotCapability.Motion.rawValue,
        availability = NodeCapabilityAvailability.MotionAvailable,
      ),
    )

  val all: List<InvokeCommandSpec> =
    listOf(
      InvokeCommandSpec(
        name = HanzoBotCanvasCommand.Present.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasCommand.Hide.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasCommand.Navigate.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasCommand.Eval.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasCommand.Snapshot.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasA2UICommand.Push.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasA2UICommand.PushJSONL.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotCanvasA2UICommand.Reset.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotScreenCommand.Record.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = HanzoBotSystemCommand.Notify.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotCameraCommand.List.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = HanzoBotCameraCommand.Snap.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = HanzoBotCameraCommand.Clip.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = HanzoBotLocationCommand.Get.rawValue,
        availability = InvokeCommandAvailability.LocationEnabled,
      ),
      InvokeCommandSpec(
        name = HanzoBotDeviceCommand.Status.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotDeviceCommand.Info.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotDeviceCommand.Permissions.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotDeviceCommand.Health.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotNotificationsCommand.List.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotNotificationsCommand.Actions.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotPhotosCommand.Latest.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotContactsCommand.Search.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotContactsCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotCalendarCommand.Events.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotCalendarCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = HanzoBotMotionCommand.Activity.rawValue,
        availability = InvokeCommandAvailability.MotionActivityAvailable,
      ),
      InvokeCommandSpec(
        name = HanzoBotMotionCommand.Pedometer.rawValue,
        availability = InvokeCommandAvailability.MotionPedometerAvailable,
      ),
      InvokeCommandSpec(
        name = HanzoBotSmsCommand.Send.rawValue,
        availability = InvokeCommandAvailability.SmsAvailable,
      ),
      InvokeCommandSpec(
        name = "debug.logs",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(
        name = "debug.ed25519",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(name = "app.update"),
    )

  private val byNameInternal: Map<String, InvokeCommandSpec> = all.associateBy { it.name }

  fun find(command: String): InvokeCommandSpec? = byNameInternal[command]

  fun advertisedCapabilities(flags: NodeRuntimeFlags): List<String> {
    return capabilityManifest
      .filter { spec ->
        when (spec.availability) {
          NodeCapabilityAvailability.Always -> true
          NodeCapabilityAvailability.CameraEnabled -> flags.cameraEnabled
          NodeCapabilityAvailability.LocationEnabled -> flags.locationEnabled
          NodeCapabilityAvailability.SmsAvailable -> flags.smsAvailable
          NodeCapabilityAvailability.VoiceWakeEnabled -> flags.voiceWakeEnabled
          NodeCapabilityAvailability.MotionAvailable -> flags.motionActivityAvailable || flags.motionPedometerAvailable
        }
      }
      .map { it.name }
  }

  fun advertisedCommands(flags: NodeRuntimeFlags): List<String> {
    return all
      .filter { spec ->
        when (spec.availability) {
          InvokeCommandAvailability.Always -> true
          InvokeCommandAvailability.CameraEnabled -> flags.cameraEnabled
          InvokeCommandAvailability.LocationEnabled -> flags.locationEnabled
          InvokeCommandAvailability.SmsAvailable -> flags.smsAvailable
          InvokeCommandAvailability.MotionActivityAvailable -> flags.motionActivityAvailable
          InvokeCommandAvailability.MotionPedometerAvailable -> flags.motionPedometerAvailable
          InvokeCommandAvailability.DebugBuild -> flags.debugBuild
        }
      }
      .map { it.name }
  }
}
