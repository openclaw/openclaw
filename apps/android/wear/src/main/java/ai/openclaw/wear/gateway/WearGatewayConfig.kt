@file:Suppress("DEPRECATION")

package ai.openclaw.wear.gateway

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

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
  private val appContext = context.applicationContext
  private val prefs: SharedPreferences =
    appContext.getSharedPreferences("openclaw_wear_config", Context.MODE_PRIVATE)
  private val masterKey by lazy {
    MasterKey.Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
  }
  private val securePrefs: SharedPreferences by lazy {
    createSecurePrefs(appContext, "openclaw_wear_secure_config")
  }

  init {
    migrateLegacySecretsIfNeeded()
  }

  fun load(): WearGatewayConfig {
    return WearGatewayConfig(
      host = prefs.getString("gw_host", "") ?: "",
      port = prefs.getInt("gw_port", 18789),
      token = securePrefs.getString("gw_token", "") ?: "",
      password = securePrefs.getString("gw_password", "") ?: "",
      useTls = prefs.getBoolean("gw_tls", false),
      usePhoneProxy = prefs.getBoolean("gw_phone_proxy", false),
      defaultReplyAction = WearReplyAction.fromStorage(prefs.getString("reply_action", null)),
      nativeTtsEnabled = prefs.getBoolean("native_tts_enabled", false),
      screenAwakeMode = WearScreenAwakeMode.fromStorage(prefs.getString("screen_awake_mode", null)),
    )
  }

  fun save(config: WearGatewayConfig) {
    prefs.edit {
      putString("gw_host", config.host)
      putInt("gw_port", config.port)
      putBoolean("gw_tls", config.useTls)
      putBoolean("gw_phone_proxy", config.usePhoneProxy)
      putString("reply_action", config.defaultReplyAction.storageValue)
      putBoolean("native_tts_enabled", config.nativeTtsEnabled)
      putString("screen_awake_mode", config.screenAwakeMode.storageValue)
      remove("gw_token")
      remove("gw_password")
    }

    securePrefs.edit {
      putString("gw_token", config.token)
      putString("gw_password", config.password)
    }
  }

  private fun migrateLegacySecretsIfNeeded() {
    val legacyToken = prefs.getString("gw_token", null)
    val legacyPassword = prefs.getString("gw_password", null)
    val secureToken = securePrefs.getString("gw_token", null)
    val securePassword = securePrefs.getString("gw_password", null)

    if ((legacyToken == null && legacyPassword == null) || (secureToken != null || securePassword != null)) {
      return
    }

    securePrefs.edit {
      putString("gw_token", legacyToken ?: "")
      putString("gw_password", legacyPassword ?: "")
    }

    prefs.edit {
      remove("gw_token")
      remove("gw_password")
    }
  }

  private fun createSecurePrefs(context: Context, name: String): SharedPreferences {
    return EncryptedSharedPreferences.create(
      context,
      name,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }
}
