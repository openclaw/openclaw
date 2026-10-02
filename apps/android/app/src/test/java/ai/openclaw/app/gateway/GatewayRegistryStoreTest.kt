package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gatewayRegistryEntry
import ai.openclaw.app.manualGatewayEndpoint
import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class GatewayRegistryStoreTest {
  @Test
  fun localNamesSurviveSwitchReconnectDiscoveryAndReloadWithoutChangingIdentityOrCredentials() {
    val (prefs, securePrefs) = freshPrefs()
    val store = prefs.gatewayRegistry
    val manual = GatewayEndpoint.manual("home.example", 443, true, "/gateway")
    val discovered = GatewayEndpoint("bonjour|office", "Discovered office", "office.example", 18789, tlsEnabled = true)
    val endpoints = listOf(manual, discovered)
    endpoints.forEach { endpoint ->
      store.upsert(gatewayRegistryEntry(endpoint, null))
      prefs.saveGatewayCredentials(endpoint.stableId, token = "synthetic-token", password = "synthetic-password")
      prefs.saveGatewayCustomHeaders(endpoint.stableId, mapOf("X-Test" to "synthetic-header"))
    }
    val credentialsBefore = securePrefs.all.filterKeys { it != GatewayRegistryStore.STORAGE_KEY }
    store.setActive(manual.stableId)
    val entriesBefore = store.entries.value
    endpoints.forEach { assertTrue(store.rename(it.stableId, "  Home lab  ")) }
    assertEquals(
      entriesBefore.associateBy { it.stableId },
      store.entries.value.associate { it.stableId to it.copy(localName = null) },
    )
    assertEquals(listOf(discovered.stableId, manual.stableId), store.entries.value.map { it.stableId })
    assertEquals(manual, manualGatewayEndpoint(requireNotNull(store.activeEntry())))

    store.setActive(discovered.stableId)
    store.setActive(manual.stableId)
    endpoints.forEach { endpoint ->
      val existing = store.entries.value.first { it.stableId == endpoint.stableId }
      store.upsert(gatewayRegistryEntry(endpoint, existing))
      store.markConnected(endpoint.stableId, 42L)
    }
    val refreshed = discovered.copy(name = "Updated discovery name", host = "new-office.example")
    store.upsert(gatewayRegistryEntry(refreshed, store.entries.value.first { it.stableId == discovered.stableId }))

    val restored = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))
    assertEquals(listOf("Home lab", "Home lab"), restored.entries.value.map { it.displayName })
    assertEquals(manual.stableId, restored.activeStableId.value)
    assertEquals(listOf(manual.stableId, discovered.stableId), restored.connectedStableIds.value)
    assertEquals(listOf(42L, 42L), restored.entries.value.map { it.lastConnectedAtMs })
    assertEquals(
      setOf("wss://home.example:443/gateway", "new-office.example:18789"),
      restored.entries.value
        .map { it.address }
        .toSet(),
    )
    assertEquals(credentialsBefore, securePrefs.all.filterKeys { it != GatewayRegistryStore.STORAGE_KEY })

    val staleEntry = restored.entries.value.first { it.stableId == discovered.stableId }
    assertTrue(restored.rename(discovered.stableId, ""))
    restored.upsert(staleEntry)
    val afterReset = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))
    assertEquals(
      "Updated discovery name",
      afterReset.entries.value
        .first { it.stableId == discovered.stableId }
        .displayName,
    )
    assertEquals("Home lab", afterReset.activeEntry()?.displayName)
    assertFalse(afterReset.rename("missing", "Missing"))
  }

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

    val afterRemoval = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))
    assertNull(afterRemoval.activeStableId.value)
    assertEquals(listOf(beta.stableId), afterRemoval.entries.value.map { it.stableId })
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
    prefs.gatewayRegistry.upsert(
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

    val restored = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))

    assertEquals(
      "/openclaw-gw",
      restored.entries.value
        .single()
        .contextPath,
    )
  }

  @Test
  fun failedRenameOrRemovalCommitDoesNotPublishCandidateState() {
    val (_, securePrefs) = freshPrefs()
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

            override fun commit(): Boolean {
              editor.apply()
              return false
            }
          }
        }
      }
    val store = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), failingCommitPrefs))
    val alpha = manualEntry("alpha", "alpha.example")
    store.upsert(alpha)
    store.setActive(alpha.stableId)

    assertFalse(store.rename(alpha.stableId, "Changed"))
    assertEquals("alpha", store.activeEntry()?.displayName)
    assertEquals("alpha", GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs)).activeEntry()?.displayName)
    assertFalse(store.remove(alpha.stableId))
    assertEquals(listOf(alpha.stableId), store.entries.value.map { it.stableId })
    assertEquals(alpha.stableId, store.activeStableId.value)
    assertEquals(listOf(alpha.stableId), store.connectedStableIds.value)
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

    val restored = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))

    assertEquals(1, Json.decodeFromString<PersistedGatewayRegistry>(securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null)!!).version)
    assertEquals(listOf("manual|alpha.example|18789"), restored.connectedStableIds.value)
    assertNull(restored.activeEntry()?.localName)
    assertEquals("Alpha", restored.activeEntry()?.displayName)
  }

  @Test
  fun unsupportedOrMalformedRegistryIsNotOverwrittenOnLaunch() {
    val (_, securePrefs) = freshPrefs()
    val unsupported = """{"version":3,"future":["keep-me"]}"""
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, unsupported).commit()

    val unsupportedStore = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))

    assertTrue(unsupportedStore.entries.value.isEmpty())
    unsupportedStore.upsert(manualEntry("new", "new.example"))
    assertFalse(unsupportedStore.rename("future", "New name"))
    assertEquals(unsupported, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))

    val malformed = "{not-json"
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, malformed).commit()

    val malformedStore = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))

    assertTrue(malformedStore.entries.value.isEmpty())
    malformedStore.upsert(manualEntry("new", "new.example"))
    assertEquals(malformed, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))

    val missingVersion = """{"entries":[]}"""
    securePrefs.edit().putString(GatewayRegistryStore.STORAGE_KEY, missingVersion).commit()

    val missingVersionStore = GatewayRegistryStore(SecurePrefs(RuntimeEnvironment.getApplication(), securePrefs))
    missingVersionStore.upsert(manualEntry("new", "new.example"))

    assertEquals(missingVersion, securePrefs.getString(GatewayRegistryStore.STORAGE_KEY, null))
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
