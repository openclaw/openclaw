package ai.hanzo.bot.android.protocol

enum class HanzoBotCapability(val rawValue: String) {
  Canvas("canvas"),
  Camera("camera"),
  Screen("screen"),
  Sms("sms"),
  VoiceWake("voiceWake"),
  Location("location"),
  Device("device"),
  Photos("photos"),
  Contacts("contacts"),
  Calendar("calendar"),
  Motion("motion"),
}

enum class HanzoBotCanvasCommand(val rawValue: String) {
  Present("canvas.present"),
  Hide("canvas.hide"),
  Navigate("canvas.navigate"),
  Eval("canvas.eval"),
  Snapshot("canvas.snapshot"),
  ;

  companion object {
    const val NamespacePrefix: String = "canvas."
  }
}

enum class HanzoBotCanvasA2UICommand(val rawValue: String) {
  Push("canvas.a2ui.push"),
  PushJSONL("canvas.a2ui.pushJSONL"),
  Reset("canvas.a2ui.reset"),
  ;

  companion object {
    const val NamespacePrefix: String = "canvas.a2ui."
  }
}

enum class HanzoBotCameraCommand(val rawValue: String) {
  List("camera.list"),
  Snap("camera.snap"),
  Clip("camera.clip"),
  ;

  companion object {
    const val NamespacePrefix: String = "camera."
  }
}

enum class HanzoBotScreenCommand(val rawValue: String) {
  Record("screen.record"),
  ;

  companion object {
    const val NamespacePrefix: String = "screen."
  }
}

enum class HanzoBotSmsCommand(val rawValue: String) {
  Send("sms.send"),
  ;

  companion object {
    const val NamespacePrefix: String = "sms."
  }
}

enum class HanzoBotLocationCommand(val rawValue: String) {
  Get("location.get"),
  ;

  companion object {
    const val NamespacePrefix: String = "location."
  }
}

enum class HanzoBotDeviceCommand(val rawValue: String) {
  Status("device.status"),
  Info("device.info"),
  Permissions("device.permissions"),
  Health("device.health"),
  ;

  companion object {
    const val NamespacePrefix: String = "device."
  }
}

enum class HanzoBotNotificationsCommand(val rawValue: String) {
  List("notifications.list"),
  Actions("notifications.actions"),
  ;

  companion object {
    const val NamespacePrefix: String = "notifications."
  }
}

enum class HanzoBotSystemCommand(val rawValue: String) {
  Notify("system.notify"),
  ;

  companion object {
    const val NamespacePrefix: String = "system."
  }
}

enum class HanzoBotPhotosCommand(val rawValue: String) {
  Latest("photos.latest"),
  ;

  companion object {
    const val NamespacePrefix: String = "photos."
  }
}

enum class HanzoBotContactsCommand(val rawValue: String) {
  Search("contacts.search"),
  Add("contacts.add"),
  ;

  companion object {
    const val NamespacePrefix: String = "contacts."
  }
}

enum class HanzoBotCalendarCommand(val rawValue: String) {
  Events("calendar.events"),
  Add("calendar.add"),
  ;

  companion object {
    const val NamespacePrefix: String = "calendar."
  }
}

enum class HanzoBotMotionCommand(val rawValue: String) {
  Activity("motion.activity"),
  Pedometer("motion.pedometer"),
  ;

  companion object {
    const val NamespacePrefix: String = "motion."
  }
}

// Short aliases for concise usage across the codebase
typealias BotCapability = HanzoBotCapability
typealias BotCanvasCommand = HanzoBotCanvasCommand
typealias BotCanvasA2UICommand = HanzoBotCanvasA2UICommand
typealias BotCameraCommand = HanzoBotCameraCommand
typealias BotScreenCommand = HanzoBotScreenCommand
typealias BotSmsCommand = HanzoBotSmsCommand
typealias BotLocationCommand = HanzoBotLocationCommand
typealias BotDeviceCommand = HanzoBotDeviceCommand
typealias BotNotificationsCommand = HanzoBotNotificationsCommand
typealias BotSystemCommand = HanzoBotSystemCommand
typealias BotPhotosCommand = HanzoBotPhotosCommand
typealias BotContactsCommand = HanzoBotContactsCommand
typealias BotCalendarCommand = HanzoBotCalendarCommand
typealias BotMotionCommand = HanzoBotMotionCommand
