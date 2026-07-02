package ai.openclaw.app.node

import android.content.Context
import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.coroutines.EmptyCoroutineContext

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayEventHandlerTest {
  @Test
  fun scheduleWakeWordsSyncIfNeeded_debouncesLatestLocalWakeWords() =
    runTest {
      val sender = FakeGatewayRequestSender()
      val prefs = securePrefs()
      val handler = eventHandler(scope = this, prefs = prefs, sender = sender)

      prefs.setWakeWords(listOf("first"))
      handler.scheduleWakeWordsSyncIfNeeded()
      advanceTimeBy(649)

      prefs.setWakeWords(listOf("second", "third"))
      handler.scheduleWakeWordsSyncIfNeeded()
      advanceTimeBy(650)
      advanceUntilIdle()

      assertEquals(1, sender.requests.size)
      assertEquals("voicewake.set", sender.requests.single().method)
      assertEquals(listOf("second", "third"), triggersFromParams(sender.requests.single().paramsJson))
    }

  @Test
  fun scheduleWakeWordsSyncIfNeeded_skipsWhenDisconnected() =
    runTest {
      val sender = FakeGatewayRequestSender()
      val prefs = securePrefs()
      val handler = eventHandler(scope = this, prefs = prefs, sender = sender, connected = false)

      prefs.setWakeWords(listOf("offline"))
      handler.scheduleWakeWordsSyncIfNeeded()
      advanceTimeBy(650)
      advanceUntilIdle()

      assertEquals(emptyList<GatewayRequest>(), sender.requests)
    }

  @Test
  fun refreshWakeWordsFromGateway_appliesGatewayTriggers() =
    runTest {
      val sender =
        FakeGatewayRequestSender(responseJson = """{"triggers":[" molty ","openclaw",""]}""")
      val prefs = securePrefs()
      val handler = eventHandler(prefs = prefs, sender = sender)

      handler.refreshWakeWordsFromGateway()

      assertEquals(listOf("molty", "openclaw"), prefs.wakeWords.value)
      assertEquals(listOf(GatewayRequest("voicewake.get", "{}")), sender.requests)
    }

  @Test
  fun refreshWakeWordsFromGateway_preservesWakeWordsOnMalformedResponse() =
    runTest {
      val sender = FakeGatewayRequestSender(responseJson = """{"triggers":"not-an-array"}""")
      val prefs = securePrefs()
      prefs.setWakeWords(listOf("existing"))
      val handler = eventHandler(prefs = prefs, sender = sender)

      handler.refreshWakeWordsFromGateway()

      assertEquals(listOf("existing"), prefs.wakeWords.value)
    }

  @Test
  fun handleVoiceWakeChangedEvent_appliesGatewayTriggersAndIgnoresMalformedPayloads() {
    val prefs = securePrefs()
    val handler = eventHandler(prefs = prefs, sender = FakeGatewayRequestSender())

    handler.handleVoiceWakeChangedEvent("""{"triggers":[" gateway ","wake"]}""")
    handler.handleVoiceWakeChangedEvent("""{"triggers":42}""")
    handler.handleVoiceWakeChangedEvent("{")

    assertEquals(listOf("gateway", "wake"), prefs.wakeWords.value)
  }

  private fun eventHandler(
    scope: CoroutineScope = CoroutineScope(EmptyCoroutineContext),
    prefs: SecurePrefs,
    sender: GatewayRequestSender,
    connected: Boolean = true,
  ): GatewayEventHandler =
    GatewayEventHandler(
      scope = scope,
      prefs = prefs,
      json = Json,
      requestSender = sender,
      isConnected = { connected },
    )

  private fun securePrefs(): SecurePrefs {
    val context = RuntimeEnvironment.getApplication()
    context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE).edit().clear().commit()
    return SecurePrefs(context)
  }

  private fun triggersFromParams(paramsJson: String?): List<String> {
    requireNotNull(paramsJson)
    return Json
      .parseToJsonElement(paramsJson)
      .jsonObject["triggers"]
      ?.jsonArray
      ?.map { it.jsonPrimitive.content }
      .orEmpty()
  }
}

private data class GatewayRequest(
  val method: String,
  val paramsJson: String?,
)

private class FakeGatewayRequestSender(
  private val responseJson: String = "{}",
) : GatewayRequestSender {
  val requests = mutableListOf<GatewayRequest>()

  override suspend fun request(
    method: String,
    paramsJson: String?,
  ): String {
    requests += GatewayRequest(method, paramsJson)
    return responseJson
  }
}
