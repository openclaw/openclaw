package ai.openclaw.wear.gateway

import android.content.Context
import android.content.SharedPreferences

enum class WearReplyAction(val storageValue: String) {
  VOICE("voice"),
  TEXT("text");

  companion object {
    fun fromStorage(value: String?): WearReplyAction {
      return entries.firstOrNull { it.storageValue == value } ?: VOICE
    }
  }
}

enum class WearScreenAwakeMode(val storageValue: String) {
  DEFAULT("default"),
  WHILE_WAITING("while_waiting"),
  ALWAYS("always");

  companion object {
    fun fromStorage(value: String?): WearScreenAwakeMode {
      return entries.firstOrNull { it.storageValue == value } ?: DEFAULT
    }
  }
}

data class WearGatewayConfig(
  val host: String = "",
  val port: Int = 18789,
  val token: String = "",
  val password: String = "",
  val useTls: Boolean = false,
  val usePhoneProxy: Boolean = false,
  val defaultReplyAction: WearReplyAction = WearReplyAction.VOICE,
  val nativeTtsEnabled: Boolean = false,
  val screenAwakeMode: WearScreenAwakeMode = WearScreenAwakeMode.DEFAULT,
) {
  val isValid: Boolean
    get() = if (usePhoneProxy) true else (host.isNotBlank() && port in 1..65535)

  fun wsUrl(): String {
    val scheme = if (useTls) "wss" else "ws"
    return "$scheme://$host:$port"
  }
}

class WearGatewayConfigStore(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("openclaw_wear_config", Context.MODE_PRIVATE)

  fun load(): WearGatewayConfig {
    return WearGatewayConfig(
      host = prefs.getString("gw_host", "") ?: "",
      port = prefs.getInt("gw_port", 18789),
      token = prefs.getString("gw_token", "") ?: "",
      password = prefs.getString("gw_password", "") ?: "",
      useTls = prefs.getBoolean("gw_tls", false),
      usePhoneProxy = prefs.getBoolean("gw_phone_proxy", false),
      defaultReplyAction = WearReplyAction.fromStorage(prefs.getString("reply_action", null)),
      nativeTtsEnabled = prefs.getBoolean("native_tts_enabled", false),
      screenAwakeMode = WearScreenAwakeMode.fromStorage(prefs.getString("screen_awake_mode", null)),
    )
  }

  fun save(config: WearGatewayConfig) {
    prefs.edit()
      .putString("gw_host", config.host)
      .putInt("gw_port", config.port)
      .putString("gw_token", config.token)
      .putString("gw_password", config.password)
      .putBoolean("gw_tls", config.useTls)
      .putBoolean("gw_phone_proxy", config.usePhoneProxy)
      .putString("reply_action", config.defaultReplyAction.storageValue)
      .putBoolean("native_tts_enabled", config.nativeTtsEnabled)
      .putString("screen_awake_mode", config.screenAwakeMode.storageValue)
      .apply()
  }
}
