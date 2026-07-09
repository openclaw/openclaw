package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidScreenshotFixtureTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun providesDeterministicProductionScreenData() {
    val sessions =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("sessions.list", null))
        .jsonObject["sessions"]
        ?.jsonArray
        .orEmpty()
    val metadata =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("chat.metadata", null))
        .jsonObject

    assertEquals(3, sessions.size)
    assertEquals(
      AndroidScreenshotFixture.primarySessionTitle,
      sessions
        .first()
        .jsonObject["displayName"]
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(1, metadata["models"]?.jsonArray?.size)
    assertEquals(1, metadata["commands"]?.jsonArray?.size)
  }

  @Test
  fun rejectsUnexpectedGatewayCalls() {
    val error =
      assertThrows(IllegalStateException::class.java) {
        AndroidScreenshotFixture.request("gateway.unexpected", null)
      }

    assertEquals(
      "Screenshot fixture does not implement gateway method gateway.unexpected with params null",
      error.message,
    )
  }
}
