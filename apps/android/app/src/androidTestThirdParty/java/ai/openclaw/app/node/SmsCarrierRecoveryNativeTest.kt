package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import android.Manifest
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import android.telephony.SmsMessage
import android.telephony.TelephonyManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import android.telephony.SmsManager as AndroidSmsManager
import java.lang.reflect.Array as ReflectArray

/** Opt-in virtual-radio proof; never send these synthetic messages from a physical device. */
@RunWith(AndroidJUnit4::class)
class SmsCarrierRecoveryNativeTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val args = InstrumentationRegistry.getArguments()
  private val context = instrumentation.targetContext

  private fun requireFixture() {
    assumeTrue("Requires two isolated SMS emulators", args.getString("smsCarrierProof") == "true")
    check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Dedicated emulators are required" }
    assertEquals(args.getString("candidateSha"), BuildConfig.GIT_COMMIT)
  }

  private fun messages(): List<String> {
    val marker = requireNotNull(args.getString("fixtureMarker"))
    require(marker.matches(Regex("[a-z0-9]{1,20}")))
    return if (args.getString("shortControl") == "true") {
      listOf("$marker short")
    } else {
      listOf("$marker short", "$marker " + "a".repeat(651), "$marker " + "日".repeat(134))
    }
  }

  private suspend fun submitMessages() {
    val recipient = requireNotNull(args.getString("recipientPort")).toInt()
    // The legacy backend uses even console ports; ModemSimulator uses its own endpoint range.
    require((recipient in 5554..5682 && recipient % 2 == 0) || recipient in 6520..6527)
    val handler = SmsHandler(SmsManager(context))
    for (message in messages()) {
      val result =
        handler.handleSmsSend(
          buildJsonObject {
            put("to", JsonPrimitive(recipient.toString()))
            put("message", JsonPrimitive(message))
          }.toString(),
        )
      assertTrue(result.error?.message, result.ok)
    }
  }

  @Test
  fun ordinaryShortMessageControl() =
    runBlocking {
      requireFixture()
      require(args.getString("shortControl") == "true")
      submitMessages()
    }

  @Test
  fun deniedFrameworkDividerStillSubmitsCompleteMessages() =
    runBlocking {
      requireFixture()
      assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE))
      assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.SEND_SMS))

      val telephony = requireNotNull(context.getSystemService(TelephonyManager::class.java))
      val gidFailure = runCatching { telephony.javaClass.getMethod("getGroupIdLevel1").invoke(telephony) }.exceptionOrNull()?.cause
      assertTrue(gidFailure is SecurityException && gidFailure.message.orEmpty().contains("getGroupIdLevel1"))
      // API 35's contextless default manager returns null before IPC. Bind the real manager so
      // this app-process EMS fixture reaches Binder permission enforcement; service state is untouched.
      val managerField = TelephonyManager::class.java.getDeclaredField("sInstance").apply { isAccessible = true }
      val previousManager = managerField.get(null)
      val configClass = Class.forName("android.telephony.SmsMessage\$NoEmsSupportConfig")
      val constructor = configClass.getDeclaredConstructor(Array<String>::class.java).apply { isAccessible = true }
      val config = constructor.newInstance(arrayOf("00101", "prefix").let { it as Any })
      val entries = ReflectArray.newInstance(configClass, 1).also { ReflectArray.set(it, 0, config) }
      val listField = SmsMessage::class.java.getDeclaredField("mNoEmsSupportConfigList").apply { isAccessible = true }
      val loadedField = SmsMessage::class.java.getDeclaredField("mIsNoEmsSupportConfigListLoaded").apply { isAccessible = true }
      val previousList = listField.get(null)
      val previouslyLoaded = loadedField.getBoolean(null)
      try {
        managerField.set(null, telephony)
        listField.set(null, entries)
        loadedField.setBoolean(null, true)
        try {
          requireNotNull(context.getSystemService(AndroidSmsManager::class.java)).divideMessage(messages().last())
          fail("The real framework divider must reject the missing phone-state permission")
        } catch (expected: SecurityException) {
          assertTrue(expected.message.orEmpty().contains("getGroupIdLevel1"))
        }
        submitMessages()
        instrumentation.sendStatus(
          0,
          Bundle().apply {
            putString("smsProof", "context-bound framework denial; three production sms.send submissions accepted")
          },
        )
      } finally {
        managerField.set(null, previousManager)
        listField.set(null, previousList)
        loadedField.setBoolean(null, previouslyLoaded)
      }
    }

  @Test
  fun virtualRadioRecipientGetsCompleteShortGsmAndUnicodeMessages() =
    runBlocking {
      requireFixture()
      assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.READ_SMS))
      val expected = messages().toSet()
      val received = CompletableDeferred<Set<String>>()

      fun inspectInbox() {
        val bodies = mutableSetOf<String>()
        context.contentResolver
          .query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.BODY),
            "${Telephony.Sms.DATE} >= ?",
            arrayOf(requireNotNull(args.getString("startMillis"))),
            null,
          )?.use { cursor ->
            while (cursor.moveToNext()) bodies.add(cursor.getString(0))
          }
        if (bodies.containsAll(expected)) received.complete(bodies.intersect(expected))
      }
      val observer =
        object : ContentObserver(Handler(Looper.getMainLooper())) {
          override fun onChange(selfChange: Boolean) = inspectInbox()
        }
      context.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer)
      try {
        inspectInbox()
        assertEquals(expected, withTimeout(60_000) { received.await() })
        instrumentation.sendStatus(
          0,
          Bundle().apply {
            putString("smsProof", "recipient readback matched ${expected.size} complete synthetic messages")
          },
        )
      } finally {
        context.contentResolver.unregisterContentObserver(observer)
      }
    }
}
