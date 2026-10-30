package ai.openclaw.app.gateway

import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class CloudflareAccessNativeTest {
  @Test
  fun packagedSodiumLoadsAndDecryptsTheGoTransferVector() =
    runBlocking {
      val expectedPageSize = checkNotNull(InstrumentationRegistry.getArguments().getString("expectedPageSize")).toLong()
      assertEquals(expectedPageSize, Os.sysconf(OsConstants._SC_PAGESIZE))
      assertEquals("1.0.22", CloudflareAccessBox.version())
      val keys = mutableListOf<String>()
      repeat(2) {
        CloudflareAccessBox.withEphemeralKey { publicKey, secretKey ->
          assertEquals(32, Base64.getUrlDecoder().decode(publicKey).size)
          assertEquals(32, secretKey.size)
          keys += publicKey
        }
      }
      assertNotEquals(keys[0], keys[1])

      // Generated with Go1.26.4 and x/crypto/nacl/box v0.53.0, independently of the Android binding.
      val secret = ByteArray(32) { it.toByte() }
      val peer = "eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo="
      val body = "4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3mUfpSI3NujJScq2SSYTNjPQHWD/4rcDtGZ4aXmZQQKiucDTkbzLbxWfGKrd5AcTTDtoyjAmnEygNkAiq9mC4Ma37GxgCkQhrX0liw7+6uoTpq9n5Rg=="
      assertEquals("test-only-app-token", CloudflareAccessBox.appToken(body.toByteArray(), peer, secret))
      val bytes = Base64.getDecoder().decode(body)
      for (index in listOf(0, 24, 108)) {
        val tampered = bytes.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
        assertThrows(CloudflareAccessException::class.java) {
          CloudflareAccessBox.appToken(Base64.getEncoder().encode(tampered), peer, secret)
        }
      }
    }
}
