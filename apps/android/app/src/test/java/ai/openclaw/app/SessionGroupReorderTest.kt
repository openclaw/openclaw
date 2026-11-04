package ai.openclaw.app

import ai.openclaw.app.chat.SessionGroupCatalogSnapshot
import ai.openclaw.app.chat.reorderSessionSection
import ai.openclaw.app.chat.reorderSharedSessionSection
import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionGroupReorderTest {
  @Test fun reappliesOnlyRelativeIntentToFreshCatalog() {
    val fresh =
      SessionGroupCatalogSnapshot(
        names = listOf("One", "Concurrent", "Two"),
        sectionOrder = listOf("work", "category:One", "category:Concurrent", "category:Two", "groups", "ungrouped"),
      )
    val result = reorderSessionSection(fresh, "category:Two", "category:One", true)!!
    assertEquals(listOf("Two", "One", "Concurrent"), result.names)
    assertEquals(listOf("work", "category:Two", "category:One", "category:Concurrent", "groups", "ungrouped"), result.sectionOrder)
  }

  @Test fun doesNotResurrectDeletedOrRenamedSections() {
    val fresh = SessionGroupCatalogSnapshot(listOf("Renamed"), listOf("category:Renamed", "work"))
    assertNull(reorderSessionSection(fresh, "category:Old", "work", true))
    assertNull(reorderSessionSection(fresh, "work", "category:Old", false))
  }

  private val initial = """{"groups":[{"name":"One","position":0},{"name":"Two","position":1}],"sectionOrder":["category:One","category:Two","work"]}"""

  private fun conflict() =
    GatewayRequestRejected(
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "catalog changed",
        details = GatewayErrorDetails(code = "SESSION_GROUP_CATALOG_CHANGED", canRetryWithDeviceToken = false, recommendedNextStep = null),
      ),
    )

  @Test fun retriesOnlyTheIntentAgainstFreshCatalog() =
    runBlocking {
      var puts = 0
      val fresh = """{"groups":[{"name":"One","position":0},{"name":"Concurrent","position":1},{"name":"Two","position":2}],"sectionOrder":["work","category:One","category:Concurrent","category:Two"]}"""
      reorderSharedSessionSection("category:Two", "category:One", true) { method, params ->
        if (method == "sessions.groups.list") {
          if (puts == 0) initial else fresh
        } else {
          puts++
          if (puts == 1) throw conflict()
          val names =
            Json
              .parseToJsonElement(params)
              .jsonObject["names"]!!
              .jsonArray
              .map { it.jsonPrimitive.content }
          assertEquals(listOf("Two", "One", "Concurrent"), names)
          "{}"
        }
      }
      assertEquals(2, puts)
    }

  @Test fun stopsAfterThreeDefinitiveConflicts() {
    var puts = 0
    val error =
      assertThrows(IllegalStateException::class.java) {
        runBlocking {
          reorderSharedSessionSection("category:Two", "category:One", true) { method, _ ->
            if (method == "sessions.groups.list") {
              initial
            } else {
              puts++
              throw conflict()
            }
          }
        }
      }
    assertEquals(3, puts)
    assertEquals("Folders changed repeatedly. Reload and try again.", error.message)
  }

  @Test fun neverRetriesPermissionOrNetworkFailures() {
    val denial = GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "missing scope"))
    for (failure in listOf(denial, java.io.IOException("disconnected"))) {
      var puts = 0
      val actual =
        assertThrows(Exception::class.java) {
          runBlocking {
            reorderSharedSessionSection("category:Two", "category:One", true) { method, _ ->
              if (method == "sessions.groups.list") {
                initial
              } else {
                puts++
                throw failure
              }
            }
          }
        }
      assertSame(failure, actual)
      assertEquals(1, puts)
    }
  }
}
