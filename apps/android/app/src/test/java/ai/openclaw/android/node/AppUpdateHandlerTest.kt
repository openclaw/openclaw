package ai.openclaw.android.node

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AppUpdateHandlerTest {
  @Test
  fun parseAppUpdateRequest_acceptsHttpsWithMatchingHost() {
    val req =
      parseAppUpdateRequest(
        paramsJson =
          """{"url":"https://gw.example.com/releases/openclaw.apk","sha256":"${"a".repeat(64)}"}""",
        connectedHost = "gw.example.com",
      )

    assertEquals("https://gw.example.com/releases/openclaw.apk", req.url)
    assertEquals("a".repeat(64), req.expectedSha256)
  }

  @Test
  fun parseAppUpdateRequest_rejectsNonHttps() {
    assertThrows(IllegalArgumentException::class.java) {
      parseAppUpdateRequest(
        paramsJson = """{"url":"http://gw.example.com/releases/openclaw.apk","sha256":"${"a".repeat(64)}"}""",
        connectedHost = "gw.example.com",
      )
    }
  }

  @Test
  fun parseAppUpdateRequest_rejectsHostMismatch() {
    assertThrows(IllegalArgumentException::class.java) {
      parseAppUpdateRequest(
        paramsJson = """{"url":"https://evil.example.com/releases/openclaw.apk","sha256":"${"a".repeat(64)}"}""",
        connectedHost = "gw.example.com",
      )
    }
  }

  @Test
  fun parseAppUpdateRequest_rejectsInvalidSha256() {
    assertThrows(IllegalArgumentException::class.java) {
      parseAppUpdateRequest(
        paramsJson = """{"url":"https://gw.example.com/releases/openclaw.apk","sha256":"bad"}""",
        connectedHost = "gw.example.com",
      )
    }
  }

  @Test
  fun sha256Hex_computesExpectedDigest() {
    val tmp = File.createTempFile("openclaw-update-hash", ".bin")
    try {
      tmp.writeText("hello", Charsets.UTF_8)
      assertEquals(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        sha256Hex(tmp),
      )
    } finally {
      tmp.delete()
    }
  }
}
