package ai.openclaw.app.chat

import android.database.sqlite.SQLiteDatabase
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatCacheDatabaseMigrationTest {
  @Test
  fun v2AmbiguousRowsMigrateToManualOnlyAndNeverReplay() =
    runTest {
      val context = RuntimeEnvironment.getApplication()
      val databaseName = "chat-cache-migration-${UUID.randomUUID()}.db"
      val databaseFile = context.getDatabasePath(databaseName)
      databaseFile.parentFile?.mkdirs()
      createV2Fixture(databaseFile.path)

      val database = ChatCacheDatabase.open(context, databaseName)
      try {
        // Opening through Room executes the production migration and validates the complete v3
        // schema, including columns, nullability, primary keys, defaults, and indices.
        assertEquals(3, database.openHelper.writableDatabase.version)

        val outbox = RoomChatCommandOutbox(database)
        val rows = outbox.load("gateway-test").associateBy { it.id }
        val pristine = rows.getValue("pristine")
        assertEquals(ChatOutboxStatus.Queued, pristine.status)
        assertNull(pristine.lastError)

        for (id in listOf("legacy-queued-error", "interrupted-send")) {
          val migrated = rows.getValue(id)
          assertEquals(ChatOutboxStatus.Failed, migrated.status)
          assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, migrated.lastError)
        }
        val alreadyFailed = rows.getValue("already-failed")
        assertEquals(ChatOutboxStatus.Failed, alreadyFailed.status)
        assertEquals("original failure", alreadyFailed.lastError)
        assertEquals("Cached session", database.dao().sessions("gateway-test").single().displayName)

        val json = Json { ignoreUnknownKeys = true }
        val sentKeys = mutableListOf<String>()
        val controller =
          ChatController(
            scope = this,
            json = json,
            requestGateway = { method, paramsJson ->
              when (method) {
                "chat.send" -> {
                  val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
                  val key = (params.getValue("idempotencyKey") as JsonPrimitive).content
                  sentKeys += key
                  """{"runId":"$key","status":"started"}"""
                }
                "chat.metadata" -> """{"commands":[],"models":[]}"""
                "chat.history" -> """{"sessionId":"session-1","messages":[]}"""
                else -> "{}"
              }
            },
            cacheScope = { ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = 1L) },
            commandOutbox = outbox,
          )
        advanceUntilIdle()

        controller.handleGatewayEvent("health", null)
        advanceUntilIdle()
        // The pristine offline row sends, but neither migrated ambiguous row may replay.
        assertEquals(listOf("pristine"), sentKeys)
        assertEquals(
          setOf("legacy-queued-error", "interrupted-send", "already-failed"),
          controller.outboxItems.value.map { it.id }.toSet(),
        )

        controller.retryOutboxCommand("legacy-queued-error")
        advanceUntilIdle()
        assertEquals(listOf("pristine", "legacy-queued-error"), sentKeys)
        assertTrue(controller.outboxItems.value.none { it.id == "legacy-queued-error" })
      } finally {
        database.close()
        context.deleteDatabase(databaseName)
      }
    }

  private fun createV2Fixture(path: String) {
    SQLiteDatabase.openOrCreateDatabase(path, null).use { database ->
      val now = System.currentTimeMillis()
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `cached_sessions` " +
          "(`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, `displayName` TEXT, " +
          "`updatedAtMs` INTEGER, `rowOrder` INTEGER NOT NULL, PRIMARY KEY(`gatewayId`, `sessionKey`))",
      )
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `cached_messages` " +
          "(`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, `rowOrder` INTEGER NOT NULL, " +
          "`role` TEXT NOT NULL, `textPartsJson` TEXT NOT NULL, `timestampMs` INTEGER, " +
          "`idempotencyKey` TEXT, PRIMARY KEY(`gatewayId`, `sessionKey`, `rowOrder`))",
      )
      database.execSQL(
        "CREATE TABLE IF NOT EXISTS `outbox_commands` " +
          "(`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
          "`text` TEXT NOT NULL, `thinkingLevel` TEXT NOT NULL, `createdAtMs` INTEGER NOT NULL, " +
          "`status` TEXT NOT NULL, `retryCount` INTEGER NOT NULL, `lastError` TEXT, PRIMARY KEY(`id`))",
      )
      database.execSQL(
        "INSERT INTO cached_sessions " +
          "(gatewayId, sessionKey, displayName, updatedAtMs, rowOrder) VALUES (?, ?, ?, ?, ?)",
        arrayOf("gateway-test", "main", "Cached session", 10L, 0),
      )
      insertOutbox(database, id = "pristine", status = "queued", retryCount = 0, lastError = null, createdAtMs = now)
      insertOutbox(
        database,
        id = "legacy-queued-error",
        status = "queued",
        retryCount = 0,
        lastError = "socket closed after send",
        createdAtMs = now + 1,
      )
      insertOutbox(
        database,
        id = "interrupted-send",
        status = "sending",
        retryCount = 1,
        lastError = null,
        createdAtMs = now + 2,
      )
      insertOutbox(
        database,
        id = "already-failed",
        status = "failed",
        retryCount = 3,
        lastError = "original failure",
        createdAtMs = now + 3,
      )
      database.version = 2
    }
  }

  private fun insertOutbox(
    database: SQLiteDatabase,
    id: String,
    status: String,
    retryCount: Int,
    lastError: String?,
    createdAtMs: Long,
  ) {
    database.execSQL(
      "INSERT INTO outbox_commands " +
        "(id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      arrayOf(id, "gateway-test", "main", id, "off", createdAtMs, status, retryCount, lastError),
    )
  }
}
