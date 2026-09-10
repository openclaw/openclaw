package ai.openclaw.app.gateway

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GatewayRegistryStoreTest {
  @Test
  fun roundTripUpsertActiveAndRemove() {
    val (prefs, securePrefs) = freshPrefs()
    val store = GatewayRegistryStore(prefs)
    val alpha = manualEntry("alpha", "alpha.example")
    val beta = manualEntry("Beta", "beta.example")

    store.upsert(beta)
    store.upsert(alpha)
    store.setActive(alpha.stableId)
    store.markConnected(alpha.stableId, 42L)

    val restored = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))
    assertEquals(listOf("alpha", "Beta"), restored.entries.value.map { it.name })
    assertEquals(alpha.stableId, restored.activeStableId.value)
    assertEquals(listOf(alpha.stableId), restored.connectedStableIds.value)
    assertEquals(42L, restored.activeEntry()?.lastConnectedAtMs)

    restored.setConnectionEnabled(beta.stableId, true)
    assertEquals(listOf(alpha.stableId, beta.stableId), restored.connectedStableIds.value)
    restored.setConnectionEnabled(alpha.stableId, false)
    assertEquals(listOf(beta.stableId), restored.connectedStableIds.value)

    assertTrue(restored.remove(alpha.stableId))
    assertNull(restored.activeStableId.value)
    assertEquals(listOf(beta.stableId), restored.entries.value.map { it.stableId })
    assertEquals(listOf(beta.stableId), restored.connectedStableIds.value)

    val afterRemoval = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))
    assertNull(afterRemoval.activeStableId.value)
    assertEquals(listOf(beta.stableId), afterRemoval.entries.value.map { it.stableId })
  }

  @Test
  fun serializationIsDeterministicAndPreservesConnectedTimestampOnMetadataUpdate() {
    val (prefs, securePrefs) = freshPrefs()
    val store = GatewayRegistryStore(prefs)
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

  @Test
  fun roundTripPreservesManualGatewayContextPath() {
    val (prefs, securePrefs) = freshPrefs()
    val endpoint =
      GatewayEndpoint.manual(
        host = "gateway.example",
        port = 443,
        tlsEnabled = true,
        contextPath = "/openclaw-gw",
      )
    GatewayRegistryStore(prefs).upsert(
      GatewayRegistryEntry(
        stableId = endpoint.stableId,
        kind = GatewayRegistryEntryKind.MANUAL,
        name = endpoint.name,
        host = endpoint.host,
        port = endpoint.port,
        tls = endpoint.tlsEnabled,
        contextPath = endpoint.contextPath,
      ),
    )

    val restored = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))

    assertEquals(
      "/openclaw-gw",
      restored.entries.value
        .single()
        .contextPath,
    )
  }

  @Test
  fun failedRemovalCommitDoesNotPublishCandidateState() {
    val (_, securePrefs) = freshPrefs()
    var failCommit = false
    val failingCommitPrefs =
      object : SharedPreferences by securePrefs {
        override fun edit(): SharedPreferences.Editor {
          val editor = securePrefs.edit()
          return object : SharedPreferences.Editor by editor {
            override fun putString(
              key: String?,
              value: String?,
            ): SharedPreferences.Editor {
              editor.putString(key, value)
              return this
            }

            override fun commit(): Boolean = if (failCommit) false else editor.commit()
          }
        }
      }
    val store = GatewayRegistryStore(TestGatewayCredentialStore(failingCommitPrefs))
    val alpha = manualEntry("alpha", "alpha.example")
    store.upsert(alpha)
    store.setActive(alpha.stableId)
    failCommit = true

    assertFalse(store.remove(alpha.stableId))
    assertEquals(listOf(alpha.stableId), store.entries.value.map { it.stableId })
    assertEquals(alpha.stableId, store.activeStableId.value)
    assertEquals(listOf(alpha.stableId), store.connectedStableIds.value)
  }

  @Test
  fun failedSelectionCommitKeepsTheDurableRouteAndDoesNotNotify() {
    val (prefs, securePrefs) = freshPrefs()
    var failCommit = false
    val notifications = mutableListOf<String?>()
    val store =
      GatewayRegistryStore(
        object : GatewayCredentialStore by prefs {
          override fun commitSecureStrings(values: Map<String, String?>): Boolean = if (failCommit) false else prefs.commitSecureStrings(values)
        },
        onActiveChanged = notifications::add,
      )
    val alpha = manualEntry("alpha", "alpha.example")
    val beta = manualEntry("beta", "beta.example")
    store.upsert(alpha)
    store.upsert(beta)
    assertTrue(store.setActive(alpha.stableId))
    failCommit = true

    assertFalse(store.setActive(beta.stableId))
    assertFalse(store.setActive(null))
    assertEquals(alpha.stableId, store.activeStableId.value)
    assertEquals(listOf(alpha.stableId), store.connectedStableIds.value)
    assertEquals(listOf(alpha.stableId), notifications)
    assertEquals(alpha.stableId, GatewayRegistryStore(TestGatewayCredentialStore(securePrefs)).activeStableId.value)
  }

  @Test
  fun versionOneRegistryUpgradesActiveGatewayToConnected() {
    val (_, securePrefs) = freshPrefs()
    securePrefs
      .edit()
      .putString(
        GatewayRegistryStore.STORAGE_KEY,
        """{"version":1,"activeStableId":"manual|alpha.example|18789","entries":[{"stableId":"manual|alpha.example|18789","kind":"manual","name":"Alpha","host":"alpha.example","port":18789}]}""",
      ).commit()

    val restored = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))

    assertEquals(1, Json.decodeFromString<PersistedGatewayRegistry>(securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null)!!).version)
    assertEquals(listOf("manual|alpha.example|18789"), restored.connectedStableIds.value)
  }

  @Test
  fun unsupportedOrMalformedRegistryIsNotOverwrittenOnLaunch() {
    val (_, securePrefs) = freshPrefs()
    val unsupported = """{"version":3,"future":["keep-me"]}"""
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, unsupported).commit()

    val unsupportedStore = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))

    assertTrue(unsupportedStore.entries.value.isEmpty())
    unsupportedStore.upsert(manualEntry("new", "new.example"))
    assertEquals(unsupported, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))

    val malformed = "{not-json"
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, malformed).commit()

    val malformedStore = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))

    assertTrue(malformedStore.entries.value.isEmpty())
    malformedStore.upsert(manualEntry("new", "new.example"))
    assertEquals(malformed, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))

    val missingVersion = """{"entries":[]}"""
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, missingVersion).commit()

    val missingVersionStore = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))
    missingVersionStore.upsert(manualEntry("new", "new.example"))

    assertEquals(missingVersion, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))
  }

  @Test
  fun postCommitObserverFailureDoesNotUndoDurableSelectionOrRemoval() {
    val (prefs, securePrefs) = freshPrefs()
    var failObserver = false
    val store =
      GatewayRegistryStore(prefs) {
        if (failObserver) error("simulated observer failure")
      }
    val alpha = manualEntry("alpha", "alpha.example")
    failObserver = true
    assertTrue(store.upsertAndSetActive(alpha, mapOf("gateway.credentials.alpha" to "credential")))
    assertEquals(alpha.stableId, store.activeStableId.value)
    assertEquals(alpha.stableId, GatewayRegistryStore(TestGatewayCredentialStore(securePrefs)).activeStableId.value)
    assertEquals("credential", securePrefs.getString("gateway.credentials.alpha", null))

    assertTrue(store.remove(alpha.stableId, mapOf("gateway.credentials.alpha" to null)))
    assertTrue(store.entries.value.isEmpty())
    assertNull(store.activeStableId.value)
    val restored = GatewayRegistryStore(TestGatewayCredentialStore(securePrefs))
    assertTrue(restored.entries.value.isEmpty())
    assertNull(restored.activeStableId.value)
    assertNull(securePrefs.getString("gateway.credentials.alpha", null))
  }

  @Test
  fun accompanyingCredentialEditsCannotOverrideRegistryAuthority() {
    val (prefs, securePrefs) = freshPrefs()
    val store = GatewayRegistryStore(prefs)
    val alpha = manualEntry("alpha", "alpha.example")
    assertTrue(store.upsertAndSetActive(alpha))
    val before = securePrefs.all.toMap()
    val edits = mapOf(GatewayRegistryStore.STORAGE_KEY to null, "gateway.credentials.alpha" to "replacement")

    assertThrows(IllegalArgumentException::class.java) { store.upsertAndSetActive(alpha, edits) }
    assertThrows(IllegalArgumentException::class.java) { store.remove(alpha.stableId, edits) }
    assertEquals(before, securePrefs.all)
    assertEquals(alpha.stableId, store.activeStableId.value)
  }

  private fun freshPrefs(): Pair<GatewayCredentialStore, SharedPreferences> {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs =
      context.getSharedPreferences("gateway-registry-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    return TestGatewayCredentialStore(securePrefs) to securePrefs
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
