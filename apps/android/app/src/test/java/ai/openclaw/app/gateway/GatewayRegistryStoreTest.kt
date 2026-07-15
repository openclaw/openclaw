package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class GatewayRegistryStoreTest {
  @Test
  fun roundTripUpsertActiveAndRemove() {
    val (prefs, securePrefs) = freshPrefs()
    val store = prefs.gatewayRegistry
    val alpha = manualEntry("alpha", "alpha.example")
    val beta = manualEntry("Beta", "beta.example")

    store.upsert(beta)
    store.upsert(alpha)
    store.setActive(alpha.stableId)
    store.markConnected(alpha.stableId, 42L)

    val restored = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))
    assertEquals(listOf("alpha", "Beta"), restored.entries.value.map { it.name })
    assertEquals(alpha.stableId, restored.activeStableId.value)
    assertEquals(42L, restored.activeEntry()?.lastConnectedAtMs)

    restored.remove(alpha.stableId)
    assertNull(restored.activeStableId.value)
    assertEquals(listOf(beta.stableId), restored.entries.value.map { it.stableId })
  }

  @Test
  fun serializationIsDeterministicAndPreservesConnectedTimestampOnMetadataUpdate() {
    val (prefs, securePrefs) = freshPrefs()
    val store = prefs.gatewayRegistry
    val alpha = manualEntry("alpha", "alpha.example")
    val beta = manualEntry("Beta", "beta.example")

    store.upsert(beta.copy(lastConnectedAtMs = 7L))
    store.upsert(alpha)
    val first = securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null)
    store.upsert(beta.copy(name = "Beta renamed"))
    assertEquals(
      7L,
      store.entries.value
        .first { it.stableId == beta.stableId }
        .lastConnectedAtMs,
    )
    store.upsert(beta)
    val second = securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null)

    assertEquals(first, second)
  }

  private fun freshPrefs(): Pair<SecurePrefs, android.content.SharedPreferences> {
    val context = RuntimeEnvironment.getApplication()
    context
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    val securePrefs =
      context.getSharedPreferences("gateway-registry-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    return SecurePrefs(context, securePrefs) to securePrefs
  }

  private fun manualEntry(
    name: String,
    host: String,
  ): GatewayRegistryEntry {
    val endpoint = GatewayEndpoint.manual(host, 18789)
    return GatewayRegistryEntry(
      stableId = endpoint.stableId,
      kind = GatewayRegistryEntryKind.MANUAL,
      name = name,
      host = host,
      port = 18789,
    )
  }
}
