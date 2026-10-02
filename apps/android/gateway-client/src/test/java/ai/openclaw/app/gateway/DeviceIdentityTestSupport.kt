package ai.openclaw.app.gateway

import android.content.Context
import android.content.SharedPreferences

internal fun testDeviceIdentityStore(context: Context): DeviceIdentityStore =
  DeviceIdentityStore.withPrefs(
    context,
    TestGatewayCredentialStore(
      context.getSharedPreferences("openclaw.node.secure.test.device-identity", Context.MODE_PRIVATE),
    ),
  )

internal class TestGatewayCredentialStore(
  private val prefs: SharedPreferences,
) : GatewayCredentialStore {
  override fun getString(key: String): String? = prefs.getString(key, null)

  override fun putString(
    key: String,
    value: String,
  ) {
    prefs.edit().putString(key, value).apply()
  }

  override fun putStringSynchronously(
    key: String,
    value: String,
  ): Boolean = prefs.edit().putString(key, value).commit()

  override fun commitSecureStrings(values: Map<String, String?>): Boolean {
    val previous = values.keys.associateWith(::getString)
    val editor = prefs.edit()
    values.forEach { (key, value) -> editor.putString(key, value) }
    if (editor.commit()) return true
    val rollback = prefs.edit()
    previous.forEach { (key, value) -> rollback.putString(key, value) }
    rollback.apply()
    return false
  }

  override fun remove(key: String) {
    prefs.edit().remove(key).apply()
  }
}
