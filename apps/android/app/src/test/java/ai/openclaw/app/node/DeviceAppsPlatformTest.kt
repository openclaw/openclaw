package ai.openclaw.app.node

import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowApplicationPackageManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [DeviceAppsPackageManagerShadow::class])
class DeviceAppsPlatformTest {
  @Test
  fun includeDisabledFindsDisabledLauncherAppsWithoutIncludingBackgroundOnlyApps() {
    installLauncherApp("sample.enabled")
    installLauncherApp("sample.disabled")
    installLauncherApp("sample.background", launcher = false)
    val app = RuntimeEnvironment.getApplication()
    app.packageManager.setApplicationEnabledSetting(
      "sample.disabled",
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
      0,
    )
    val handler = DeviceHandler(app)

    val defaults = apps(handler, """{"query":"sample."}""")
    assertEquals(setOf("sample.enabled"), defaults.keys)

    val included = apps(handler, """{"query":"sample.","includeDisabled":true}""")
    assertEquals(setOf("sample.enabled", "sample.disabled"), included.keys)
    val disabled = included.getValue("sample.disabled")
    assertFalse(disabled.getValue("enabled").jsonPrimitive.boolean)
    assertTrue(disabled.getValue("launchable").jsonPrimitive.boolean)

    val restoredDefaults = apps(handler, """{"query":"sample.","includeDisabled":false}""")
    assertEquals(defaults, restoredDefaults)
  }

  @Test
  fun disabledLauncherComponentDoesNotExpandDefaultInventory() {
    installLauncherApp("sample.enabled")
    val disabledLauncher = installLauncherApp("sample.disabledlauncher")
    val app = RuntimeEnvironment.getApplication()
    app.packageManager.setComponentEnabledSetting(
      disabledLauncher,
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      0,
    )
    val handler = DeviceHandler(app)

    val defaults = apps(handler, """{"query":"sample."}""")
    assertEquals(setOf("sample.enabled"), defaults.keys)

    val included = apps(handler, """{"query":"sample.","includeDisabled":true}""")
    assertEquals(setOf("sample.enabled", "sample.disabledlauncher"), included.keys)
    val disabled = included.getValue("sample.disabledlauncher")
    assertTrue(disabled.getValue("enabled").jsonPrimitive.boolean)
    assertTrue(disabled.getValue("launchable").jsonPrimitive.boolean)
  }

  private fun installLauncherApp(
    packageName: String,
    launcher: Boolean = true,
  ): ComponentName {
    val manager = RuntimeEnvironment.getApplication().packageManager
    val shadow = shadowOf(manager)
    val appInfo =
      ApplicationInfo().apply {
        this.packageName = packageName
        nonLocalizedLabel = packageName
        enabled = true
      }
    val activity =
      ActivityInfo().apply {
        this.packageName = packageName
        name = "$packageName.MainActivity"
        applicationInfo = appInfo
        enabled = true
        exported = true
      }
    shadow.addOrUpdateActivity(activity)
    val component = ComponentName(packageName, activity.name)
    if (launcher) {
      val filter = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
      shadow.addIntentFilterForActivity(component, filter)
    }
    return component
  }

  private fun apps(
    handler: DeviceHandler,
    params: String,
  ): Map<String, JsonObject> {
    val result = handler.handleDeviceApps(params)
    assertTrue(result.ok)
    val payload = Json.parseToJsonElement(checkNotNull(result.payloadJson)).jsonObject
    val entries = payload.getValue("apps").jsonArray
    return entries.associate { element ->
      val entry = element.jsonObject
      entry.getValue("packageName").jsonPrimitive.content to entry
    }
  }
}

// Robolectric 4.17 treats MATCH_ALL as MATCH_DISABLED_COMPONENTS, unlike Android's
// PackageUserStateUtils.isEnabled. Keep Android's disabled filtering at this I/O boundary.
@Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
class DeviceAppsPackageManagerShadow : ShadowApplicationPackageManager() {
  @Implementation
  override fun queryIntentActivities(
    intent: Intent,
    flags: Int,
  ): List<ResolveInfo> = super.queryIntentActivities(intent, flags and PackageManager.MATCH_ALL.inv())
}
