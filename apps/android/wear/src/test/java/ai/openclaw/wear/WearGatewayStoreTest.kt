package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayRegistryStore
import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearGatewayStoreTest {
  @Test
  fun watchAcceptsOnlyBootstrapSetupAndPreservesEndpointPath() {
    val setup = parseWearGatewaySetup(code("bootstrapToken", "watch-bootstrap"))
    assertEquals("/gateway", setup.endpoint.contextPath)
    assertEquals("watch-bootstrap", setup.bootstrapToken)
    for (kind in listOf("token", "password")) {
      assertThrows(IllegalArgumentException::class.java) { parseWearGatewaySetup(code(kind, "phone-secret")) }
    }
    assertThrows(IllegalArgumentException::class.java) {
      parseWearGatewaySetup(
        Base64.getUrlEncoder().withoutPadding().encodeToString(
          """{"url":"https://gateway.example","bootstrapToken":"new","token":"old-phone"}""".toByteArray(),
        ),
      )
    }
  }

  @Test
  fun replacementAndInvalidationFenceBootstrapRetirementAcrossReopen() {
    val prefs = prefs()
    val store = WearGatewayStore(prefs)
    val first = parseWearGatewaySetup(code("bootstrapToken", "first"))
    store.replace(first, "watch-device")
    val old = store.handoff(first.endpoint.stableId, first.bootstrapToken)
    store.replace(first.copy(bootstrapToken = "second"), "watch-device")
    assertFalse(old.complete())
    val current = store.handoff(first.endpoint.stableId, "second")
    current.invalidate()
    assertFalse(current.complete())
    assertEquals("second", WearGatewayStore(prefs).bootstrap(first.endpoint.stableId))
    assertFalse(store.handoff(first.endpoint.stableId, "second").allowStoredTokenRecovery)
  }

  @Test
  fun failedBootstrapCommitRestoresMemoryAndRemainsRetryable() {
    val backing = prefs()
    var fail = false
    val store =
      WearGatewayStore(
        object : SharedPreferences by backing {
          override fun edit(): SharedPreferences.Editor {
            val edit = backing.edit()
            return object : SharedPreferences.Editor by edit {
              override fun putString(
                key: String?,
                value: String?,
              ): SharedPreferences.Editor {
                edit.putString(key, value)
                return this
              }

              override fun remove(key: String?): SharedPreferences.Editor {
                edit.remove(key)
                return this
              }

              override fun commit(): Boolean {
                edit.commit()
                return !fail
              }
            }
          }
        },
      )
    val setup = parseWearGatewaySetup(code("bootstrapToken", "bootstrap"))
    store.replace(setup, "watch-device")
    val handoff = store.handoff(setup.endpoint.stableId, setup.bootstrapToken)
    fail = true
    assertFalse(handoff.complete())
    assertEquals("bootstrap", store.bootstrap(setup.endpoint.stableId))
    fail = false
    assertTrue(handoff.complete())
    assertEquals(null, WearGatewayStore(backing).bootstrap(setup.endpoint.stableId))
  }

  @Test
  fun forgettingOneGatewayKeepsOtherWatchCredentialsAndSelection() {
    val prefs = prefs()
    val store = WearGatewayStore(prefs)
    val first = parseWearGatewaySetup(code("bootstrapToken", "first"))
    val second = parseWearGatewaySetup(code("bootstrapToken", "second", "https://other.example"))
    store.replace(first, "watch-device")
    val tokens = DeviceAuthStore(store)
    tokens.saveToken(first.endpoint.stableId, "watch-device", "operator", "watch-token", listOf("operator.read"))
    store.replace(second, "watch-device")
    store.forget(first.endpoint.stableId, " WATCH-DEVICE ")
    val reopened = WearGatewayStore(prefs)
    assertEquals(second.endpoint.stableId, reopened.registry.activeStableId.value)
    assertEquals("second", reopened.bootstrap(second.endpoint.stableId))
    assertEquals(null, reopened.bootstrap(first.endpoint.stableId))
    assertEquals(null, DeviceAuthStore(reopened).loadEntry(first.endpoint.stableId, "watch-device", "operator"))
    assertEquals(
      1,
      Json.parseToJsonElement(reopened.getString("gateway.registry")!!).let {
        (it as kotlinx.serialization.json.JsonObject)["version"].toString().toInt()
      },
    )
  }

  @Test
  fun failedReplacementCommitKeepsCredentialsAndSelection() = assertRegistryFailure(forget = false, throws = false)

  @Test
  fun failedForgetCommitKeepsCredentialsAndSelection() = assertRegistryFailure(forget = true, throws = false)

  @Test
  fun failedReplacementThrowKeepsCredentialsAndSelection() = assertRegistryFailure(forget = false, throws = true)

  @Test
  fun failedForgetThrowKeepsCredentialsAndSelection() = assertRegistryFailure(forget = true, throws = true)

  private fun assertRegistryFailure(
    forget: Boolean,
    throws: Boolean,
  ) {
    val backing = prefs()
    var failRegistryCommit = false
    val failing =
      object : SharedPreferences by backing {
        override fun edit(): SharedPreferences.Editor {
          val edit = backing.edit()
          var editsRegistry = false
          return object : SharedPreferences.Editor by edit {
            override fun putString(
              key: String?,
              value: String?,
            ): SharedPreferences.Editor {
              editsRegistry = editsRegistry || key == GatewayRegistryStore.STORAGE_KEY
              edit.putString(key, value)
              return this
            }

            override fun remove(key: String?): SharedPreferences.Editor {
              edit.remove(key)
              return this
            }

            override fun commit(): Boolean {
              edit.commit()
              if (failRegistryCommit && editsRegistry && throws) error("Synthetic commit failure after memory update")
              return !(failRegistryCommit && editsRegistry)
            }
          }
        }
      }
    val store = WearGatewayStore(failing)
    val original = parseWearGatewaySetup(code("bootstrapToken", "original"))
    store.replace(original, "watch-device")
    val tokens = DeviceAuthStore(store)
    for (role in listOf("node", "operator")) {
      assertTrue(tokens.saveToken(original.endpoint.stableId, "watch-device", role, "old-$role"))
    }
    assertTrue(store.putStringSynchronously("gateway.tls.${original.endpoint.stableId}", "old-pin"))
    val before = backing.all.toMap()
    val entries = store.registry.entries.value
    val handoff = store.handoff(original.endpoint.stableId, original.bootstrapToken)
    failRegistryCommit = true

    assertThrows(IllegalStateException::class.java) {
      if (forget) {
        store.forget(original.endpoint.stableId, "watch-device")
      } else {
        store.replace(original.copy(bootstrapToken = "replacement"), "watch-device")
      }
    }
    assertEquals("Failed ${if (forget) "forget" else "replacement"} changed stored authority", before, backing.all)
    assertEquals(entries, store.registry.entries.value)
    assertEquals(original.endpoint.stableId, store.registry.activeStableId.value)
    val reopened = WearGatewayStore(backing)
    assertEquals("original", reopened.bootstrap(original.endpoint.stableId))
    assertEquals("old-operator", DeviceAuthStore(reopened).loadToken(original.endpoint.stableId, "watch-device", "operator"))
    failRegistryCommit = false
    assertTrue("Failed mutation must not advance the credential revision", handoff.complete())
  }

  private fun prefs(): SharedPreferences =
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("wear-store-${UUID.randomUUID()}", Context.MODE_PRIVATE)

  private fun code(
    kind: String,
    value: String,
    url: String = "https://gateway.example/gateway",
  ): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(
      buildJsonObject {
        put("url", url)
        put(kind, value)
      }.toString().toByteArray(),
    )
}
