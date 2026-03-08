package ai.openclaw.app.voice

import java.io.File
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

@Serializable
private data class TalkConfigContractFixture(
  @SerialName("selectionCases") val selectionCases: List<SelectionCase>,
) {
  @Serializable
  data class SelectionCase(
    val id: String,
    val defaultProvider: String,
    val payloadValid: Boolean,
    val expectedSelection: ExpectedSelection? = null,
    val talk: JsonObject,
  )

  @Serializable
  data class ExpectedSelection(
    val provider: String,
    val normalizedPayload: Boolean,
    val voiceId: String? = null,
  )
}

class TalkModeConfigContractTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun selectionFixtures() {
    for (fixture in loadFixtures().selectionCases) {
      val selection = TalkModeGatewayConfigParser.selectTalkProviderConfig(fixture.talk)
      val expected = fixture.expectedSelection
      if (expected == null) {
        assertNull(fixture.id, selection)
        continue
      }
      assertNotNull(fixture.id, selection)
      assertEquals(fixture.id, expected.provider, selection?.provider)
      assertEquals(fixture.id, expected.normalizedPayload, selection?.normalizedPayload)
      assertEquals(
        fixture.id,
        expected.voiceId,
        (selection?.config?.get("voiceId") as? JsonPrimitive)?.content,
      )
      assertEquals(fixture.id, true, fixture.payloadValid)
    }
  }

  private fun loadFixtures(): TalkConfigContractFixture {
    val fixturePath = findFixtureFile()
    return json.decodeFromString(File(fixturePath).readText())
  }

  private fun findFixtureFile(): String {
    val startDir = System.getProperty("user.dir") ?: error("user.dir unavailable")
    var current = File(startDir).absoluteFile
    while (true) {
      val candidate = File(current, "test-fixtures/talk-config-contract.json")
      if (candidate.exists()) {
        return candidate.absolutePath
      }
      current = current.parentFile ?: break
    }
    error("talk-config-contract.json not found from $startDir")
  }
}
