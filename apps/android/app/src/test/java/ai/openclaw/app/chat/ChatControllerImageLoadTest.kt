package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayLoadedImage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerImageLoadTest {
  @Test
  fun sentImageReferencesLoadThroughTheInboundLoaderAndArtifactsThroughArtifacts() =
    runTest {
      val artifactKeys = mutableListOf<String>()
      val inboundSources = mutableListOf<Pair<String?, String>>()
      val controller =
        backgroundScope.createChatController(
          loadGatewayImageArtifact = { _, _, _, artifactId ->
            artifactKeys += artifactId
            GatewayLoadedImage(byteArrayOf(1), "image/png")
          },
          loadGatewayInboundImage = { gatewayId, _, _, source ->
            inboundSources += gatewayId to source
            GatewayLoadedImage(byteArrayOf(2), "image/jpeg")
          },
        )

      val sent = controller.loadImageArtifact(" media://inbound/photo---af3c4068.jpg ")
      val managed = controller.loadImageArtifact("artifact_managed_image_11111111-1111-4111-8111-111111111111")
      controller.loadImageArtifact("media://inbound/..")

      assertArrayEquals(byteArrayOf(2), sent?.bytes)
      assertArrayEquals(byteArrayOf(1), managed?.bytes)
      assertEquals(listOf("gateway-test" to "media://inbound/photo---af3c4068.jpg"), inboundSources)
      assertEquals("artifact_managed_image_11111111-1111-4111-8111-111111111111", artifactKeys.first())
    }
}
