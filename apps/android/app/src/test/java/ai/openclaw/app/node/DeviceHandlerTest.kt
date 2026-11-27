package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.BatteryManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
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

@RunWith(RobolectricTestRunner::class)
class DeviceHandlerTest {


  @Test
  fun handleDeviceStatus_reportsBatteryLevelAsFractionAndPercent() {
    val readings =
      listOf(
        Triple(0 to 100, 0.0, 0L),
        Triple(1 to 8, 0.125, 13L),
        Triple(50 to 100, 0.5, 50L),
        Triple(100 to 100, 1.0, 100L),
      )

    for ((reading, expectedLevel, expectedPercent) in readings) {
      val battery = batteryStatus(reading.first, reading.second)

      assertEquals(expectedLevel, battery.getValue("level").jsonPrimitive.double, 0.0)
      assertEquals(
        expectedPercent,
        battery
          .getValue("levelPercent")
          .jsonPrimitive
          .content
          .toLong(),
      )
      assertEquals("unplugged", battery.getValue("state").jsonPrimitive.content)
      assertFalse(battery.getValue("lowPowerModeEnabled").jsonPrimitive.boolean)
    }
  }

  @Test
  fun handleDeviceStatus_omitsUnavailableBatteryLevelAndPercent() {
    for ((level, scale) in listOf(null to 100, -1 to 100, 50 to null, 50 to 0, 50 to -1)) {
      val battery = batteryStatus(level, scale)

      assertFalse("level=$level scale=$scale", battery.containsKey("level"))
      assertFalse("level=$level scale=$scale", battery.containsKey("levelPercent"))
      assertEquals("unplugged", battery.getValue("state").jsonPrimitive.content)
      assertFalse(battery.getValue("lowPowerModeEnabled").jsonPrimitive.boolean)
    }
  }

  private fun batteryStatus(
    level: Int?,
    scale: Int?,
  ): JsonObject {
    val app = appContext()
    val batteryIntent =
      Intent(Intent.ACTION_BATTERY_CHANGED)
        .putExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_DISCHARGING)
    level?.let { batteryIntent.putExtra(BatteryManager.EXTRA_LEVEL, it) }
    scale?.let { batteryIntent.putExtra(BatteryManager.EXTRA_SCALE, it) }
    // Seed the sticky ACTION_BATTERY_CHANGED broadcast that readBatterySnapshot()
    // consumes via registerReceiver(null, ...). Context.sendStickyBroadcast is the
    // only non-reflection way to populate that sticky state under Robolectric.
    @Suppress("DEPRECATION")
    app.sendStickyBroadcast(batteryIntent)
    val handler = DeviceHandler(app)

    val result = handler.handleDeviceStatus(null)

    assertTrue(result.ok)
    return parsePayload(result.payloadJson).getValue("battery").jsonObject
  }

  @Test
  fun handleDevicePermissions_returnsExpectedShape() {
    val handler = DeviceHandler(appContext())

    val result = handler.handleDevicePermissions(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val permissions = payload.getValue("permissions").jsonObject
    val expected =
      listOf(
        "camera",
        "microphone",
        "location",
        "sms",
        "notificationListener",
        "notifications",
        "photos",
        "contacts",
        "calendar",
        "callLog",
        "motion",
      )
    for (key in expected) {
      val state = permissions.getValue(key).jsonObject
      val status = state.getValue("status").jsonPrimitive.content
      assertTrue(status == "granted" || status == "denied")
      state.getValue("promptable").jsonPrimitive.boolean
      if (key == "sms") {
        val capabilities = state.getValue("capabilities").jsonObject
        for (capabilityKey in listOf("send", "read")) {
          val capability = capabilities.getValue(capabilityKey).jsonObject
          val capabilityStatus = capability.getValue("status").jsonPrimitive.content
          assertTrue(capabilityStatus == "granted" || capabilityStatus == "denied")
          capability.getValue("promptable").jsonPrimitive.boolean
        }
      }
    }
  }

  @Test
  fun handleDevicePermissions_derivesCompositeStatesFromCanonicalSnapshot() {
    val app = appContext()
    shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
    val snapshot =
      emptyPermissionSnapshot().copy(
        smsSend = true,
        contactsRead = true,
        calendarRead = true,
        calendarWrite = true,
      )
    val handler =
      DeviceHandler(
        appContext = app,
        appSource = FakeDeviceAppSource(emptyList()),
        smsEnabled = true,
        permissionSnapshot = { snapshot },
      )

    val payload = handler.handleDevicePermissions(null).payloadJson

    assertEquals("granted", permissionStatus(payload, "sms"))
    assertEquals("denied", permissionStatus(payload, "contacts"))
    assertEquals("granted", permissionStatus(payload, "calendar"))
    val smsCapabilities =
      parsePayload(payload)
        .getValue("permissions")
        .jsonObject
        .getValue("sms")
        .jsonObject
        .getValue("capabilities")
        .jsonObject
    assertEquals(
      "granted",
      smsCapabilities
        .getValue("send")
        .jsonObject
        .getValue("status")
        .jsonPrimitive.content,
    )
    assertEquals(
      "denied",
      smsCapabilities
        .getValue("read")
        .jsonObject
        .getValue("status")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun handleDevicePermissions_reportsSmsGrantsAndPromptability() {
    val send = Manifest.permission.SEND_SMS
    val read = Manifest.permission.READ_SMS
    val cases =
      listOf(
        SmsPermissionCase(true, true, emptyList(), "denied", true),
        SmsPermissionCase(true, true, listOf(send), "granted", true),
        SmsPermissionCase(true, true, listOf(read), "granted", true),
        SmsPermissionCase(true, true, listOf(send, read), "granted", false),
        SmsPermissionCase(false, true, listOf(send, read), "denied", false),
        SmsPermissionCase(true, false, listOf(send, read), "denied", false),
        SmsPermissionCase(false, true, emptyList(), "denied", false),
        SmsPermissionCase(true, false, emptyList(), "denied", false),
      )
    val app = appContext()
    for (case in cases) {
      shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, case.telephony)
      shadowOf(app).denyPermissions(send, read)
      shadowOf(app).grantPermissions(*case.permissions.toTypedArray())
      val handler = DeviceHandler(app, smsEnabled = case.smsEnabled)

      val result = handler.handleDevicePermissions(null)

      assertTrue(result.ok)
      val sms =
        parsePayload(result.payloadJson)
          .getValue("permissions")
          .jsonObject
          .getValue("sms")
          .jsonObject
      assertEquals(case.toString(), case.expectedStatus, sms.getValue("status").jsonPrimitive.content)
      assertEquals(case.toString(), case.expectedPromptable, sms.getValue("promptable").jsonPrimitive.boolean)
    }
  }

  @Test
  fun handleDevicePermissions_marksCallLogUnpromptableWhenFeatureDisabled() {
    val handler = DeviceHandler(appContext(), callLogEnabled = false)

    val result = handler.handleDevicePermissions(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val callLog =
      payload
        .getValue("permissions")
        .jsonObject
        .getValue("callLog")
        .jsonObject
    assertEquals("denied", callLog.getValue("status").jsonPrimitive.content)
    assertTrue(!callLog.getValue("promptable").jsonPrimitive.boolean)
  }

  @Test
  fun handleDevicePermissions_requiresReadAndWritePermissionPairs() {
    val app = appContext()
    val handler = DeviceHandler(app)
    val permissionPairs =
      listOf(
        Triple("contacts", Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS),
        Triple("calendar", Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
      )

    for ((key, readPermission, writePermission) in permissionPairs) {
      shadowOf(app).denyPermissions(readPermission, writePermission)

      shadowOf(app).grantPermissions(readPermission)
      assertEquals("$key read-only", "denied", permissionStatus(handler.handleDevicePermissions(null).payloadJson, key))

      shadowOf(app).denyPermissions(readPermission)
      shadowOf(app).grantPermissions(writePermission)
      assertEquals("$key write-only", "denied", permissionStatus(handler.handleDevicePermissions(null).payloadJson, key))

      shadowOf(app).grantPermissions(readPermission)
      assertEquals("$key read-write", "granted", permissionStatus(handler.handleDevicePermissions(null).payloadJson, key))
    }
  }

  private fun emptyPermissionSnapshot(): AndroidPermissionSnapshot =
    AndroidPermissionSnapshot(
      camera = false,
      microphone = false,
      location = false,
      locationPrecise = false,
      locationBackground = false,
      smsSend = false,
      smsRead = false,
      notificationListener = false,
      notifications = false,
      photos = false,
      contactsRead = false,
      contactsWrite = false,
      calendarRead = false,
      calendarWrite = false,
      callLog = false,
      motion = false,
    )


  @Test
  fun handleDeviceApps_filtersAndLimitsVisibleApps() {
    val handler =
      DeviceHandler(
        appContext = appContext(),
        appSource =
          FakeDeviceAppSource(
            listOf(
              DeviceAppEntry(
                label = "Calendar",
                packageName = "com.google.android.calendar",
                system = false,
                enabled = true,
                launchable = true,
              ),
              DeviceAppEntry(
                label = "Android System",
                packageName = "android",
                system = true,
                enabled = true,
                launchable = false,
              ),
              DeviceAppEntry(
                label = "Disabled App",
                packageName = "com.example.disabled",
                system = false,
                enabled = false,
                launchable = true,
              ),
              DeviceAppEntry(
                label = "Gmail",
                packageName = "com.google.android.gm",
                system = false,
                enabled = true,
                launchable = true,
              ),
            ),
          ),
      )

    val result = handler.handleDeviceApps("""{"query":"google","limit":1}""")

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    assertEquals("1", payload.getValue("count").jsonPrimitive.content)
    assertEquals("2", payload.getValue("totalMatched").jsonPrimitive.content)
    assertTrue(payload.getValue("truncated").jsonPrimitive.boolean)
    assertEquals("launcher", payload.getValue("visibility").jsonPrimitive.content)
    val apps = payload.getValue("apps").jsonArray
    assertEquals(1, apps.size)
    val app = apps.first().jsonObject
    assertEquals("Calendar", app.getValue("label").jsonPrimitive.content)
    assertEquals("com.google.android.calendar", app.getValue("packageName").jsonPrimitive.content)
    assertTrue(!app.getValue("system").jsonPrimitive.boolean)
    assertTrue(app.getValue("enabled").jsonPrimitive.boolean)
    assertTrue(app.getValue("launchable").jsonPrimitive.boolean)
  }

  @Test
  fun handleDeviceApps_canIncludeSystemAndNonLaunchableApps() {
    val source =
      FakeDeviceAppSource(
        listOf(
          DeviceAppEntry(
            label = "Android System",
            packageName = "android",
            system = true,
            enabled = true,
            launchable = false,
          ),
        ),
      )
    val handler = DeviceHandler(appContext = appContext(), appSource = source)

    val result = handler.handleDeviceApps("""{"includeSystem":true,"includeNonLaunchable":true}""")

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    assertEquals("android-visible", payload.getValue("visibility").jsonPrimitive.content)
    assertTrue(payload.getValue("includeSystem").jsonPrimitive.boolean)
    val app =
      payload
        .getValue("apps")
        .jsonArray
        .first()
        .jsonObject
    assertEquals("android", app.getValue("packageName").jsonPrimitive.content)
    assertTrue(app.getValue("system").jsonPrimitive.boolean)
    assertTrue(!app.getValue("launchable").jsonPrimitive.boolean)
    assertTrue(source.includeNonLaunchableRequests.single())
  }

  @Test
  fun isSystemDeviceApp_treatsUpdatedBuiltInsAsSystemApps() {
    val appInfo =
      ApplicationInfo().apply {
        flags = ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
      }

    assertTrue(isSystemDeviceApp(appInfo))
  }

  private fun appContext(): Application = RuntimeEnvironment.getApplication()

  private data class SmsPermissionCase(
    val smsEnabled: Boolean,
    val telephony: Boolean,
    val permissions: List<String>,
    val expectedStatus: String,
    val expectedPromptable: Boolean,
  )

  private fun parsePayload(payloadJson: String?): JsonObject {
    val jsonString = payloadJson ?: error("expected payload")
    return Json.parseToJsonElement(jsonString).jsonObject
  }

  private fun permissionStatus(
    payloadJson: String?,
    key: String,
  ): String =
    parsePayload(payloadJson)
      .getValue("permissions")
      .jsonObject
      .getValue(key)
      .jsonObject
      .getValue("status")
      .jsonPrimitive
      .content
}

private class FakeDeviceAppSource(
  private val apps: List<DeviceAppEntry>,
) : DeviceAppSource {
  val includeNonLaunchableRequests = mutableListOf<Boolean>()

  override fun listApps(includeNonLaunchable: Boolean): List<DeviceAppEntry> {
    includeNonLaunchableRequests += includeNonLaunchable
    return apps
  }
}
