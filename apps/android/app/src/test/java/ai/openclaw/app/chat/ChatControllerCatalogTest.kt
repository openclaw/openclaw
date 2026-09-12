package ai.openclaw.app.chat

import ai.openclaw.app.GatewayModelAllowList
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
  fun loadAndHandleGatewayEventReplaceAndClearPublishedAllowListState() =
    runTest {
      var catalogResponse =
        """{
          "models":[{"id":"primary","name":"Primary","provider":"fixture","tags":["default"]}],
          "allowList":{"hiddenCount":2,"settingsPath":"agents.defaults.modelPolicy.allow","selectedModelBlocked":true}
        }"""
      val (controller) =
        chatControllerTestSetup {
          respond("chat.history", """{"messages":[],"sessionInfo":{"key":"agent:main:work","modelProvider":"fixture","model":"blocked"}}""")
          respond("chat.metadata", """{"commands":[]}""")
          respond("models.list") { catalogResponse }
        }

      controller.load("agent:main:work")
      advanceUntilIdle()

      assertEquals(listOf("primary"), controller.modelCatalog.value.map { it.id })
      assertEquals(
        listOf("default"),
        controller.modelCatalog.value
          .single()
          .tags,
      )
      assertEquals(
        GatewayModelAllowList(
          hiddenCount = 2,
          settingsPath = "agents.defaults.modelPolicy.allow",
          selectedModelBlocked = true,
        ),
        controller.modelAllowList.value,
      )

      catalogResponse =
        """{
          "models":[
            {"id":"primary","name":"Primary","provider":"fixture","tags":["configured"]},
            {"id":"blocked","name":"Former pin","provider":"fixture","tags":["default"]}
          ],
          "allowList":{"hiddenCount":1,"settingsPath":"agents.entries.main.modelPolicy.allow","selectedModelBlocked":false}
        }"""
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()

      assertEquals(listOf("primary", "blocked"), controller.modelCatalog.value.map { it.id })
      assertEquals(listOf(listOf("configured"), listOf("default")), controller.modelCatalog.value.map { it.tags })
      assertEquals(
        GatewayModelAllowList(
          hiddenCount = 1,
          settingsPath = "agents.entries.main.modelPolicy.allow",
          selectedModelBlocked = false,
        ),
        controller.modelAllowList.value,
      )

      catalogResponse = """{"models":[]}"""
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()

      assertEquals(emptyList<String>(), controller.modelCatalog.value.map { it.id })
      assertNull(controller.modelAllowList.value)
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
