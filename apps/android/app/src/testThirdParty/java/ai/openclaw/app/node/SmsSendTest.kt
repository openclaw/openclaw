package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSmsManager
import android.telephony.SmsManager as AndroidSmsManager

@RunWith(RobolectricTestRunner::class)
@Config(shadows = [SmsSendTest.CarrierSmsManager::class])
class SmsSendTest {
  private lateinit var context: Application
  private lateinit var carrier: CarrierSmsManager

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
    shadowOf(context).grantPermissions(Manifest.permission.SEND_SMS)
    carrier = Shadow.extract(context.getSystemService(AndroidSmsManager::class.java))
  }

  @Test
  fun sendsLongMessagesWhenCarrierDividerCannotReadPhoneState() = runTest {
    // GSM, non-EMS Unicode page indicators, extension characters, and a surrogate boundary.
    val messages = listOf("a".repeat(651), "日".repeat(134), "^".repeat(161), "日".repeat(65) + "😀" + "日".repeat(70))
    for (message in messages) {
      val result = SmsManager(context).send(params(message))

      assertTrue(result.error, result.ok)
      val submitted = requireNotNull(carrier.lastSentMultipartTextMessageParams)
      assertEquals("+15551234567", submitted.destinationAddress)
      assertEquals(message, submitted.parts.joinToString(""))
      assertTrue(submitted.parts.size > 1)
      for (part in submitted.parts) {
        val limit = if (message.all { it == 'a' }) 153 else 66
        assertTrue(part.length <= limit)
        assertFalse(part.first().isLowSurrogate())
        assertFalse(part.last().isHighSurrogate())
        // Android adds "1/3 " or " 1/3" when converting 2..9 non-EMS parts to single SMS.
        if (limit == 66) assertTrue(("1/3 " + part).length <= 70)
      }
      carrier.clearLastSentMultipartTextMessageParams()
    }
  }

  @Test
  fun shortMessageAndSuccessfulPlatformDivisionKeepTheirExistingSendPaths() = runTest {
    assertTrue(SmsManager(context).send(params("hello")).ok)
    assertEquals("hello", carrier.lastSentTextMessageParams.text)
    assertNull(carrier.lastSentMultipartTextMessageParams)

    carrier.platformParts = arrayListOf("carrier ", "segmentation")
    assertTrue(SmsManager(context).send(params("carrier segmentation")).ok)
    assertEquals(carrier.platformParts, carrier.lastSentMultipartTextMessageParams.parts)
  }

  @Test
  fun missingSmsPermissionStillPreventsSubmission() = runTest {
    shadowOf(context).denyPermissions(Manifest.permission.SEND_SMS)

    val result = SmsManager(context).send(params("a".repeat(651)))

    assertFalse(result.ok)
    assertEquals("SMS_PERMISSION_REQUIRED: grant SMS permission", result.error)
    assertNull(carrier.lastSentMultipartTextMessageParams)
  }

  private fun params(message: String): String =
    Json.encodeToString(
      buildJsonObject {
        put("to", JsonPrimitive("+15551234567"))
        put("message", JsonPrimitive(message))
      },
    )

  @Implements(AndroidSmsManager::class)
  class CarrierSmsManager : ShadowSmsManager() {
    var platformParts: ArrayList<String>? = null

    @Implementation
    fun divideMessage(message: String): ArrayList<String> = platformParts ?: throw SecurityException("getGroupIdLevel1")
  }
}
