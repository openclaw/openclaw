package ai.openclaw.app.chat

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
  fun metadataFailureNamesMetadataRefreshWithoutCallingModelsList() =
    runTest {
      var metadataFails = false
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = {
            it == "session-scoped-chat-metadata" || it == "session-scoped-model-catalog"
          }
          respond("chat.metadata") {
            if (metadataFails) error("Session changed while preparing its metadata. Retry the request.") else """{"commands":[]}"""
          }
          respond("models.list") {
            """{"models":[{"id":"chat","name":"Chat","provider":"fixture","available":true}]}"""
          }
        }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val acceptedChoices = controller.modelCatalog.value
      assertEquals(listOf("chat"), acceptedChoices.map { it.id })
      val modelReads = requests.count { it.first == "models.list" }

      metadataFails = true
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()

      assertEquals("Could not refresh chat metadata. Tap Refresh to try again.", controller.errorText.value)
      assertEquals(modelReads, requests.count { it.first == "models.list" })
      assertEquals(acceptedChoices, controller.modelCatalog.value)

      metadataFails = false
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertNull(controller.errorText.value)
      assertEquals(acceptedChoices, controller.modelCatalog.value)
    }

  @Test
  fun catalogFailureStillNamesModelRefresh() =
    runTest {
      var catalogFails = false
      val (controller, _) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = {
            it == "session-scoped-chat-metadata" || it == "session-scoped-model-catalog"
          }
          respond("chat.metadata", """{"commands":[]}""")
          respond("models.list") {
            if (catalogFails) error("catalog unavailable") else """{"models":[{"id":"chat","name":"Chat","provider":"fixture","available":true}]}"""
          }
        }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val acceptedChoices = controller.modelCatalog.value

      catalogFails = true
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()

      assertEquals("Could not refresh models. Tap Refresh to try again.", controller.errorText.value)
      assertEquals(acceptedChoices, controller.modelCatalog.value)

      catalogFails = false
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertNull(controller.errorText.value)
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
