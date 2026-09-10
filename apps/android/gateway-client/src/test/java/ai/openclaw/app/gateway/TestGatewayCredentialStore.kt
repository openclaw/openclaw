package ai.openclaw.app.gateway

import android.content.Context
import android.content.SharedPreferences

/** Plain test backing; encrypted-store lifecycle and commit failures stay covered in the phone app. */
internal class TestGatewayCredentialStore(
  private val backing: SharedPreferences,
) : GatewayCredentialStore {
  override fun getString(key: String): String? = backing.getString(key, null)

  override fun putString(
    key: String,
    value: String,
  ) {
    backing.edit().putString(key, value).apply()
  }

  override fun putStringSynchronously(
    key: String,
    value: String,
  ): Boolean = backing.edit().putString(key, value).commit()

  override fun commitSecureStrings(values: Map<String, String?>): Boolean {
    val editor = backing.edit()
    values.forEach { (key, value) -> if (value == null) editor.remove(key) else editor.putString(key, value) }
    return editor.commit()
  }

  override fun remove(key: String) {
    backing.edit().remove(key).apply()
  }
}

internal fun testDeviceIdentityStore(context: Context): DeviceIdentityStore =
  DeviceIdentityStore.withPrefs(
    context,
    TestGatewayCredentialStore(
      context.getSharedPreferences("openclaw.node.secure.test.device-identity", Context.MODE_PRIVATE),
    ),
  )
