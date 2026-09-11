package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerCatalogTest {
  @Test
  fun olderGatewayKeepsCommandsAndExplainsMissingCatalogCapability() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = { false }
          respond("chat.metadata", """{"commands":[{"name":"new","textAliases":["/new"]}]}""")
        }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("new"), controller.commands.value.map { it.name })
      assertFalse(requests.any { it.first == "models.list" })
      assertEquals("Update your Gateway to use session model choices.", controller.errorText.value)
    }

  @Test
  fun sessionCatalogOwnsChoicesAndEmptySuccessDoesNotRetry() =
    runTest {
      var empty = false
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", """{"messages":[],"sessionInfo":{"key":"agent:main:work","modelProvider":"fixture","model":"chat"}}""")
          respond("chat.metadata", """{"commands":[],"models":[{"id":"obsolete","provider":"other"}]}""")
          respond("models.list") {
            if (empty) {
              """{"models":[]}"""
            } else {
              """{"models":[{
          "id":"chat","name":"Chat","provider":"fixture","supportsFastMode":false,
          "thinkingLevels":[{"id":"off","label":"Off"},{"id":"deep","label":"Deep"}],
          "thinkingDefault":"deep","input":["text","image"]
        }]}"""
            }
          }
        }
      controller.load("agent:main:work")
      advanceUntilIdle()

      assertEquals(listOf("chat"), controller.modelCatalog.value.map { it.id })
      assertEquals(
        listOf("off", "deep"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      assertEquals("deep", controller.thinkingLevel.value)
      val params = chatControllerTestJson.parseToJsonElement(requests.single { it.first == "models.list" }.second!!).jsonObject
      assertEquals(JsonPrimitive("agent:main:work"), params["sessionKey"])
      assertEquals(JsonPrimitive("main"), params["agentId"])
      assertEquals(JsonPrimitive("configured"), params["view"])
      assertFalse("authProfileId" in params)

      empty = true
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertEquals(emptyList<String>(), controller.modelCatalog.value.map { it.id })
      val reads = requests.count { it.first == "models.list" }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(reads, requests.count { it.first == "models.list" })
    }
}
