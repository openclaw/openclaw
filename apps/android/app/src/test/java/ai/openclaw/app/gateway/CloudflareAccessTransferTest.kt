package ai.openclaw.app.gateway

import com.sun.jna.NativeLibrary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.Base64

class CloudflareAccessTransferTest {
  // Go1.26.4 + x/crypto/nacl/box v0.53.0; service Seal(clientPublic) -> mobile Open(servicePublic).
  private val secret = ByteArray(32) { it.toByte() }
  private val peer = "eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo="
  private val body = "4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3mUfpSI3NujJScq2SSYTNjPQHWD/4rcDtGZ4aXmZQQKiucDTkbzLbxWfGKrd5AcTTDtoyjAmnEygNkAiq9mC4Ma37GxgCkQhrX0liw7+6uoTpq9n5Rg=="

  @Before fun loadsPinnedLibraryFromTaskOutput() {
    val expected = System.getProperty("openclaw.sodium.test.library")
    if (System.getProperty("os.name") == "Linux" && System.getProperty("os.arch").orEmpty() in setOf("amd64", "x86_64")) {
      checkNotNull(expected) { "Linux x64 CI must configure the pinned native transfer library." }
    }
    assumeTrue("No pinned libsodium interoperability fixture for this JVM host; JWT and lifecycle suites still run.", expected != null)
    assertEquals(File(checkNotNull(expected)).canonicalFile, NativeLibrary.getInstance("sodium").file.canonicalFile)
    assertEquals("1.0.22", CloudflareAccessBox.version())
  }

  @Test fun decryptsGoVectorAndRejectsFakeAppGrant() {
    val token = CloudflareAccessBox.appToken(body.toByteArray(), peer, secret)
    assertEquals("test-only-app-token", token)
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.appClaims(token, CloudflareAccessTestTokens.application) }
  }

  @Test fun rejectsTamperedNonceMacCiphertextAndTruncation() {
    val bytes = Base64.getDecoder().decode(body)
    for (index in listOf(0, 24, 108)) {
      val tampered = bytes.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
      assertThrows(CloudflareAccessException::class.java) { CloudflareAccessBox.appToken(Base64.getEncoder().encode(tampered), peer, secret) }
    }
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessBox.appToken(Base64.getEncoder().encode(bytes.copyOf(bytes.size - 1)), peer, secret) }
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessBox.appToken(body.toByteArray(), "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8=", secret) }
  }

  @Test fun rejectsWrongBase64AlphabetAndAuthenticatedInvalidSchema() {
    for ((encoded, header) in listOf(
      body.replace('+', '-').replace('/', '_') to peer,
      body to peer.replace('-', '+').replace('_', '/'),
      "invalid" to peer,
      Base64.getEncoder().encodeToString(ByteArray(39)) to peer,
      body to peer.dropLast(1),
    )) {
      assertThrows(CloudflareAccessException::class.java) { CloudflareAccessBox.appToken(encoded.toByteArray(), header, secret) }
    }
    for (encoded in listOf(
      "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3tnpip9KPq9XQpBI5GjPt0k4=",
      "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaX4yew9i53b9+4rxh5Ix7UWTihTHI/Vzb1WO5a6ObFvXw7ZG9HhfL+6JQZgxuOPpv/heDdWETPVFwnFCVEpX6KUrs=",
      "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3udaJ6+8j8qaBZ7chKhIfXXKQgJRQ6OV5HOolnKdfDc/aXVQJ1Ra+UQCWuNZQcQ5PFktF",
    )) {
      assertThrows(CloudflareAccessException::class.java) { CloudflareAccessBox.appToken(encoded.toByteArray(), "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=", secret) }
    }
  }

  @Test fun browserUsesFreshKeysAndCancellationNeverPolls() =
    runBlocking {
      val urls = mutableListOf<String>()
      var polled = false
      val transfer =
        CloudflareAccessTransfer { _, _, _ ->
          polled = true
          error("Cancelled browser must not poll")
        }
      repeat(2) {
        val failure =
          runCatching {
            transfer.signIn(CloudflareAccessTestTokens.application) { url ->
              urls += url
              throw CancellationException()
            }
          }.exceptionOrNull()
        assertTrue(failure is CancellationException)
      }
      assertFalse(polled)
      val first = urls[0].toHttpUrl()
      assertNotEquals(first.queryParameter("token"), urls[1].toHttpUrl().queryParameter("token"))
      assertEquals(44, first.queryParameter("token")?.length)
      assertEquals("/cdn-cgi/access/cli", first.encodedPath)
      assertEquals("test-audience", first.queryParameter("aud"))
      for (name in listOf("send_org_token", "edge_token_transfer", "close_interstitial")) assertEquals("true", first.queryParameter(name))
      assertTrue(CloudflareAccessTestTokens.application.origin.contains(checkNotNull(first.queryParameter("redirect_url"))))
    }
}
