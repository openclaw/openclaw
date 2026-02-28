package ai.openclaw.android.gateway

import ai.openclaw.android.SecurePrefs

interface DeviceAuthTokenStore {
  fun loadToken(deviceId: String, role: String): String?
  fun saveToken(deviceId: String, role: String, token: String)
}

class DeviceAuthStore(private val prefs: SecurePrefs) : DeviceAuthTokenStore {
  override fun loadToken(deviceId: String, role: String): String? {
    val key = tokenKey(deviceId, role)
    return prefs.getString(key)?.trim()?.takeIf { it.isNotEmpty() }
  }

  override fun saveToken(deviceId: String, role: String, token: String) {
    val key = tokenKey(deviceId, role)
    prefs.putString(key, token.trim())
  }

  fun clearToken(deviceId: String, role: String) {
    val key = tokenKey(deviceId, role)
    prefs.remove(key)
  }

  private fun tokenKey(deviceId: String, role: String): String {
    val normalizedDevice = deviceId.trim().lowercase()
    val normalizedRole = role.trim().lowercase()
    return "gateway.deviceToken.$normalizedDevice.$normalizedRole"
  }
}
