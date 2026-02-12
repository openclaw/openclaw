package ai.openclaw.android.gateway

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@ConscryptMode(ConscryptMode.Mode.OFF)
class DeviceIdentityStoreTest {
  @Test
  fun loadOrCreateReturnsSignableIdentity() {
    val app = RuntimeEnvironment.getApplication()
    resetIdentityFiles(app.filesDir)
    val store = DeviceIdentityStore(app)

    val identity = store.loadOrCreate()
    val publicKey = store.publicKeyBase64Url(identity)
    val signature = store.signPayload("connect-check", identity)

    assertNotNull(publicKey)
    assertNotNull(signature)
    assertFalse(publicKey.isNullOrBlank())
    assertFalse(signature.isNullOrBlank())
  }

  @Test
  fun regenerateReturnsSignableIdentity() {
    val app = RuntimeEnvironment.getApplication()
    resetIdentityFiles(app.filesDir)
    val store = DeviceIdentityStore(app)

    val identity = store.regenerate()
    val publicKey = store.publicKeyBase64Url(identity)
    val signature = store.signPayload("connect-check", identity)

    assertNotNull(publicKey)
    assertNotNull(signature)
    assertFalse(publicKey.isNullOrBlank())
    assertFalse(signature.isNullOrBlank())
  }

  private fun resetIdentityFiles(filesDir: File) {
    File(filesDir, "openclaw").deleteRecursively()
  }
}
