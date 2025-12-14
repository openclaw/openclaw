package com.steipete.clawdis.node

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

class SecurePrefs(context: Context) {
  companion object {
    val defaultWakeWords: List<String> = listOf("clawd", "claude")
  }

  private val json = Json { ignoreUnknownKeys = true }

  private val masterKey =
    MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()

  private val prefs =
    EncryptedSharedPreferences.create(
      context,
      "clawdis.node.secure",
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  private val _instanceId = MutableStateFlow(loadOrCreateInstanceId())
  val instanceId: StateFlow<String> = _instanceId

  private val _displayName = MutableStateFlow(prefs.getString("node.displayName", "Android Node")!!)
  val displayName: StateFlow<String> = _displayName

  private val _cameraEnabled = MutableStateFlow(prefs.getBoolean("camera.enabled", true))
  val cameraEnabled: StateFlow<Boolean> = _cameraEnabled

  private val _manualEnabled = MutableStateFlow(prefs.getBoolean("bridge.manual.enabled", false))
  val manualEnabled: StateFlow<Boolean> = _manualEnabled

  private val _manualHost = MutableStateFlow(prefs.getString("bridge.manual.host", "")!!)
  val manualHost: StateFlow<String> = _manualHost

  private val _manualPort = MutableStateFlow(prefs.getInt("bridge.manual.port", 18790))
  val manualPort: StateFlow<Int> = _manualPort

  private val _lastDiscoveredStableId =
    MutableStateFlow(prefs.getString("bridge.lastDiscoveredStableId", "")!!)
  val lastDiscoveredStableId: StateFlow<String> = _lastDiscoveredStableId

  private val _wakeWords = MutableStateFlow(loadWakeWords())
  val wakeWords: StateFlow<List<String>> = _wakeWords

  fun setLastDiscoveredStableId(value: String) {
    val trimmed = value.trim()
    prefs.edit().putString("bridge.lastDiscoveredStableId", trimmed).apply()
    _lastDiscoveredStableId.value = trimmed
  }

  fun setDisplayName(value: String) {
    val trimmed = value.trim()
    prefs.edit().putString("node.displayName", trimmed).apply()
    _displayName.value = trimmed
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.edit().putBoolean("camera.enabled", value).apply()
    _cameraEnabled.value = value
  }

  fun setManualEnabled(value: Boolean) {
    prefs.edit().putBoolean("bridge.manual.enabled", value).apply()
    _manualEnabled.value = value
  }

  fun setManualHost(value: String) {
    val trimmed = value.trim()
    prefs.edit().putString("bridge.manual.host", trimmed).apply()
    _manualHost.value = trimmed
  }

  fun setManualPort(value: Int) {
    prefs.edit().putInt("bridge.manual.port", value).apply()
    _manualPort.value = value
  }

  fun loadBridgeToken(): String? {
    val key = "bridge.token.${_instanceId.value}"
    return prefs.getString(key, null)
  }

  fun saveBridgeToken(token: String) {
    val key = "bridge.token.${_instanceId.value}"
    prefs.edit().putString(key, token.trim()).apply()
  }

  private fun loadOrCreateInstanceId(): String {
    val existing = prefs.getString("node.instanceId", null)?.trim()
    if (!existing.isNullOrBlank()) return existing
    val fresh = UUID.randomUUID().toString()
    prefs.edit().putString("node.instanceId", fresh).apply()
    return fresh
  }

  fun setWakeWords(words: List<String>) {
    val sanitized = WakeWords.sanitize(words, defaultWakeWords)
    val encoded =
      JsonArray(sanitized.map { JsonPrimitive(it) }).toString()
    prefs.edit().putString("voiceWake.triggerWords", encoded).apply()
    _wakeWords.value = sanitized
  }

  private fun loadWakeWords(): List<String> {
    val raw = prefs.getString("voiceWake.triggerWords", null)?.trim()
    if (raw.isNullOrEmpty()) return defaultWakeWords
    return try {
      val element = json.parseToJsonElement(raw)
      val array = element as? JsonArray ?: return defaultWakeWords
      val decoded =
        array.mapNotNull { item ->
          when (item) {
            is JsonNull -> null
            is JsonPrimitive -> item.content.trim().takeIf { it.isNotEmpty() }
            else -> null
          }
        }
      WakeWords.sanitize(decoded, defaultWakeWords)
    } catch (_: Throwable) {
      defaultWakeWords
    }
  }
}
