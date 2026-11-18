package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.app.PendingIntent
import android.content.pm.PackageManager
import android.telephony.SmsMessage
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
@Config(sdk = [35], shadows = [SmsSendTest.CarrierSmsManager::class])
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
  fun sendsLongMessagesWhenCarrierDividerCannotReadPhoneState() =
    runTest {
      // GSM, non-EMS Unicode page indicators, extension characters, and a surrogate boundary.
      val messages =
        listOf(
          "a".repeat(651) to listOf(153, 153, 153, 153, 39),
          "日".repeat(134) to listOf(66, 66, 2),
          ("a".repeat(153) + "日") to listOf(66, 66, 22),
          "日".repeat(594) to List(9) { 66 },
          "日".repeat(595) to (List(9) { 66 } + 1),
          "^".repeat(161) to listOf(76, 76, 9),
          ("日".repeat(65) + "😀" + "日".repeat(70)) to listOf(65, 66, 6),
        )
      for ((message, partLengths) in messages) {
        val result = SmsManager(context).send(params(message))

        assertTrue(result.error, result.ok)
        val submitted = requireNotNull(carrier.lastSentMultipartTextMessageParams)
        assertEquals("+15551234567", submitted.destinationAddress)
        assertEquals(message, submitted.parts.joinToString(""))
        assertEquals(partLengths, submitted.parts.map { it.length })
        for (part in submitted.parts) {
          assertFalse(part.first().isLowSurrogate())
          assertFalse(part.last().isHighSurrogate())
          // Non-EMS telephony adds four septets/UTF-16 units when converting 2..9 parts.
          val page = if (submitted.parts.size < 10) "1/3 $part" else part
          assertNotNull(SmsMessage.getSubmitPdu(null, "+15551234567", page, false))
        }
        carrier.clearLastSentMultipartTextMessageParams()
      }
    }

  @Test
  fun shortMessageAndSuccessfulPlatformDivisionKeepTheirExistingSendPaths() =
    runTest {
      for (message in listOf("hello", "a".repeat(160), "^".repeat(80), "日".repeat(70))) {
        assertTrue(SmsManager(context).send(params(message)).ok)
        assertEquals(message, carrier.lastSentTextMessageParams.text)
        assertNull(carrier.lastSentMultipartTextMessageParams)
      }

      carrier.platformParts = arrayListOf("carrier ", "segmentation")
      assertTrue(SmsManager(context).send(params("carrier segmentation")).ok)
      assertEquals(carrier.platformParts, carrier.lastSentMultipartTextMessageParams.parts)
    }

  @Test
  fun missingSmsPermissionStillPreventsSubmission() =
    runTest {
      shadowOf(context).denyPermissions(Manifest.permission.SEND_SMS)

      val result = SmsManager(context).send(params("a".repeat(651)))

      assertFalse(result.ok)
      assertEquals("SMS_PERMISSION_REQUIRED: grant SMS permission", result.error)
      assertNull(carrier.lastSentMultipartTextMessageParams)
    }

  @Test
  fun submissionPermissionFailureIsNotRetried() =
    runTest {
      carrier.denySubmission = true

      val result = SmsManager(context).send(params("a".repeat(651)))

      assertFalse(result.ok)
      assertEquals("SMS_PERMISSION_REQUIRED: send denied", result.error)
      assertEquals(1, carrier.submissionCalls)
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
    var denySubmission = false
    var submissionCalls = 0

    @Implementation
    override fun sendMultipartTextMessage(
      destinationAddress: String?,
      scAddress: String?,
      parts: ArrayList<String>?,
      sentIntents: ArrayList<PendingIntent>?,
      deliveryIntents: ArrayList<PendingIntent>?,
    ) {
      submissionCalls += 1
      if (denySubmission) throw SecurityException("send denied")
      super.sendMultipartTextMessage(destinationAddress, scAddress, parts, sentIntents, deliveryIntents)
    }

    @Implementation
    fun divideMessage(message: String): ArrayList<String> = platformParts ?: throw SecurityException("getGroupIdLevel1")
  }
}
