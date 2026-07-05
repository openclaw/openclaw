package ai.openclaw.app.chat

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.withTransaction
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.UUID

/** Upper bound of cached session rows per gateway; oldest list positions are evicted on write. */
internal const val MAX_CACHED_SESSIONS = 50

internal const val CHAT_TRANSCRIPT_CACHE_DB_NAME = "chat-transcript-cache.db"

/**
 * Deletes the cache database file outright. Only safe while no [RoomChatTranscriptCache] is open
 * in this process; used by pairing-reset paths that run before the node runtime exists.
 */
internal fun deleteChatTranscriptCacheDatabase(context: Context) {
  context.deleteDatabase(CHAT_TRANSCRIPT_CACHE_DB_NAME)
}

/** Upper bound of cached transcript rows per session; only the newest messages are kept. */
internal const val MAX_CACHED_MESSAGES_PER_SESSION = 200

/**
 * Read-only offline cache of chat sessions and transcripts.
 *
 * The cache is disposable: it only speeds up cold open and enables offline browsing.
 * Live `chat.history` / `sessions.list` responses always replace cached data wholesale.
 */
interface ChatTranscriptCache {
  suspend fun loadSessions(gatewayId: String): List<ChatSessionEntry>

  suspend fun loadTranscript(
    gatewayId: String,
    sessionKey: String,
  ): List<ChatMessage>

  suspend fun saveSessions(
    gatewayId: String,
    sessions: List<ChatSessionEntry>,
  )

  suspend fun saveTranscript(
    gatewayId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  )

  /** Removes one session and its transcript, so gateway-side deletes also purge offline copies. */
  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  )

  /** Purges every cached row for all gateways; used when pairing/auth state is reset. */
  suspend fun clearAll()
}

@Entity(tableName = "cached_sessions", primaryKeys = ["gatewayId", "sessionKey"])
internal data class CachedSessionEntity(
  val gatewayId: String,
  val sessionKey: String,
  val displayName: String?,
  val updatedAtMs: Long?,
  // Preserves gateway list order so offline session rows render in the familiar order.
  val rowOrder: Int,
)

@Entity(tableName = "cached_messages", primaryKeys = ["gatewayId", "sessionKey", "rowOrder"])
internal data class CachedMessageEntity(
  val gatewayId: String,
  val sessionKey: String,
  val rowOrder: Int,
  val role: String,
  // JSON array of text part strings; attachments/binary parts are never persisted.
  val textPartsJson: String,
  val timestampMs: Long?,
  // Kept so live history reconciliation can match cached rows by identity key.
  val idempotencyKey: String?,
)

@Dao
internal interface ChatCacheDao {
  @Query("SELECT * FROM cached_sessions WHERE gatewayId = :gatewayId ORDER BY rowOrder ASC")
  suspend fun sessions(gatewayId: String): List<CachedSessionEntity>

  @Query(
    "SELECT * FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey ORDER BY rowOrder ASC",
  )
  suspend fun messages(
    gatewayId: String,
    sessionKey: String,
  ): List<CachedMessageEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertSessions(rows: List<CachedSessionEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertSessionStub(row: CachedSessionEntity)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertMessages(rows: List<CachedMessageEntity>)

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId")
  suspend fun deleteSessions(gatewayId: String)

  @Query("DELETE FROM cached_sessions")
  suspend fun deleteAllSessions()

  @Query("DELETE FROM cached_messages")
  suspend fun deleteAllMessages()

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteSessionRow(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteTranscript(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("SELECT COALESCE(MAX(rowOrder), -1) + 1 FROM cached_sessions WHERE gatewayId = :gatewayId")
  suspend fun nextSessionRowOrder(gatewayId: String): Int

  // Keeps the just-written session even when the cache is full: without the exclusion, a stub
  // inserted at the highest rowOrder would be evicted immediately and deep-session transcripts
  // could never be cached once MAX_CACHED_SESSIONS rows exist.
  @Query(
    "DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey != :keepSessionKey AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey != :keepSessionKey " +
      "ORDER BY rowOrder ASC LIMIT :keep)",
  )
  suspend fun evictSessionsBeyondKeeping(
    gatewayId: String,
    keepSessionKey: String,
    keep: Int,
  )

  // Transcripts must never outlive their session row; this keeps total cache size bounded
  // by MAX_CACHED_SESSIONS * MAX_CACHED_MESSAGES_PER_SESSION rows per gateway.
  @Query(
    "DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId)",
  )
  suspend fun evictOrphanedTranscripts(gatewayId: String)
}

@Database(
  entities = [CachedSessionEntity::class, CachedMessageEntity::class],
  version = 1,
  exportSchema = false,
)
internal abstract class ChatCacheDatabase : RoomDatabase() {
  abstract fun dao(): ChatCacheDao

  companion object {
    fun open(context: Context): ChatCacheDatabase =
      Room
        .databaseBuilder(context, ChatCacheDatabase::class.java, CHAT_TRANSCRIPT_CACHE_DB_NAME)
        // The cache is disposable by contract: any schema bump drops and rebuilds instead of migrating.
        .fallbackToDestructiveMigration(dropAllTables = true)
        .build()
  }
}

/**
 * Room-backed [ChatTranscriptCache]. Callers bind every operation to the gateway scope captured
 * before their suspend point, so a connection switch cannot re-scope an old response.
 */
class RoomChatTranscriptCache internal constructor(
  private val database: ChatCacheDatabase,
) : ChatTranscriptCache {
  constructor(context: Context) : this(database = ChatCacheDatabase.open(context))

  private val json = Json
  private val textPartsSerializer = ListSerializer(String.serializer())

  override suspend fun loadSessions(gatewayId: String): List<ChatSessionEntry> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    return database.dao().sessions(gateway).map { row ->
      ChatSessionEntry(
        key = row.sessionKey,
        updatedAtMs = row.updatedAtMs,
        displayName = row.displayName,
      )
    }
  }

  override suspend fun loadTranscript(
    gatewayId: String,
    sessionKey: String,
  ): List<ChatMessage> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return emptyList()
    return database.dao().messages(gateway, key).map { row ->
      ChatMessage(
        id = UUID.randomUUID().toString(),
        role = row.role,
        content = decodeTextParts(row.textPartsJson).map { ChatMessageContent(type = "text", text = it) },
        timestampMs = row.timestampMs,
        idempotencyKey = row.idempotencyKey,
      )
    }
  }

  override suspend fun saveSessions(
    gatewayId: String,
    sessions: List<ChatSessionEntry>,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val rows =
      sessions.take(MAX_CACHED_SESSIONS).mapIndexed { index, session ->
        CachedSessionEntity(
          gatewayId = gateway,
          sessionKey = session.key,
          displayName = session.displayName,
          updatedAtMs = session.updatedAtMs,
          rowOrder = index,
        )
      }
    val dao = database.dao()
    database.withTransaction {
      dao.deleteSessions(gateway)
      dao.insertSessions(rows)
      dao.evictOrphanedTranscripts(gateway)
    }
  }

  override suspend fun saveTranscript(
    gatewayId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    // Text rows only: attachment/binary parts are dropped, and messages without any text are skipped.
    val rows =
      messages
        .mapNotNull { message ->
          val textParts = message.content.filter { it.type == "text" }.mapNotNull { it.text }
          if (textParts.isEmpty()) return@mapNotNull null
          message to textParts
        }.takeLast(MAX_CACHED_MESSAGES_PER_SESSION)
        .mapIndexed { index, (message, textParts) ->
          CachedMessageEntity(
            gatewayId = gateway,
            sessionKey = key,
            rowOrder = index,
            role = message.role,
            textPartsJson = json.encodeToString(textPartsSerializer, textParts),
            timestampMs = message.timestampMs,
            idempotencyKey = message.idempotencyKey,
          )
        }
    val dao = database.dao()
    database.withTransaction {
      dao.deleteTranscript(gateway, key)
      dao.insertMessages(rows)
      // A transcript may arrive for a session missing from the cached list (e.g. deep session
      // switch); keep a stub row so the transcript stays reachable, then re-apply the bounds.
      dao.insertSessionStub(
        CachedSessionEntity(
          gatewayId = gateway,
          sessionKey = key,
          displayName = null,
          updatedAtMs = null,
          rowOrder = dao.nextSessionRowOrder(gateway),
        ),
      )
      dao.evictSessionsBeyondKeeping(gateway, keepSessionKey = key, keep = MAX_CACHED_SESSIONS - 1)
      dao.evictOrphanedTranscripts(gateway)
    }
  }

  override suspend fun clearAll() {
    val dao = database.dao()
    database.withTransaction {
      dao.deleteAllSessions()
      dao.deleteAllMessages()
    }
  }

  override suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    val dao = database.dao()
    database.withTransaction {
      dao.deleteSessionRow(gateway, key)
      dao.deleteTranscript(gateway, key)
    }
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }

  private fun decodeTextParts(encoded: String): List<String> = runCatching { json.decodeFromString(textPartsSerializer, encoded) }.getOrDefault(emptyList())
}
