package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerMetadataRetryTest {
  private val supersededRead = "UNAVAILABLE: Error: Session changed while preparing its metadata. Retry the request."

  @Test
  fun supersededMetadataReadIsRetriedWithoutModelsRefreshError() =
    runTest {
      var metadataReads = 0
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata") {
            if (++metadataReads == 1) throw IllegalStateException(supersededRead)
            """{"commands":[]}"""
          }
          respond("models.list", """{"models":[{"id":"current","name":"Current","provider":"fixture"}]}""")
        }

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals("A superseded read is retried once", 2, requests.count { it.first == "chat.metadata" })
      assertEquals(listOf("current"), controller.modelCatalog.value.map { it.id })
      assertEquals(null, controller.errorText.value)
    }

  @Test
  fun persistentSupersededReadsStillSurfaceTheRefreshError() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata") { throw IllegalStateException(supersededRead) }
        }

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals("Retries are bounded", 3, requests.count { it.first == "chat.metadata" })
      assertEquals("Could not refresh models. Tap Refresh to try again.", controller.errorText.value)
    }

  @Test
  fun otherMetadataFailuresAreNotRetried() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata") { throw IllegalStateException("FORBIDDEN: missing scope") }
        }

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(1, requests.count { it.first == "chat.metadata" })
    }
}
