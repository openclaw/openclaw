package ai.openclaw.app.chat

import android.content.Context
import android.util.Log
import androidx.room3.Dao
import androidx.room3.Database
import androidx.room3.Entity
import androidx.room3.Insert
import androidx.room3.OnConflictStrategy
import androidx.room3.PrimaryKey
import androidx.room3.Query
import androidx.room3.Room
import androidx.room3.RoomDatabase
import androidx.room3.migration.Migration
import androidx.room3.useReaderConnection
import androidx.room3.withWriteTransaction
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.execSQL
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal const val GATEWAY_CACHE_DB_NAME = "gateway-cache.db"
internal const val CLIENT_STATE_DB_NAME = "client-state.db"
internal const val LEGACY_CHAT_DATABASE_NAME = "chat-transcript-cache.db"

private const val LEGACY_IMPORT_KEY = "legacy-chat-transcript-cache-v8"
private const val LEGACY_IMPORT_COMPLETE = "complete"
private const val LEGACY_IMPORT_CHUNK_PAGE_ROWS = 8
private const val GATEWAY_REMOVAL_STAGED = "staged"
private const val GATEWAY_REMOVAL_COMMITTING = "committing"
private const val GATEWAY_REMOVAL_CACHE_PENDING = "cache-pending"

@Entity(tableName = "client_state_metadata")
internal data class ClientStateMetadataEntity(
  @PrimaryKey val key: String,
  val value: String,
)

@Entity(tableName = "gateway_removals")
internal data class GatewayRemovalEntity(
  @PrimaryKey val gatewayId: String,
  val phase: String,
)

@Dao
internal interface ClientStateControlDao {
  @Query("SELECT value FROM client_state_metadata WHERE `key` = :key")
  suspend fun metadataValue(key: String): String?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertMetadata(row: ClientStateMetadataEntity)

  @Query("SELECT * FROM gateway_removals ORDER BY gatewayId ASC")
  suspend fun gatewayRemovals(): List<GatewayRemovalEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertGatewayRemoval(row: GatewayRemovalEntity)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertGatewayRemovalIfAbsent(row: GatewayRemovalEntity)

  @Query("DELETE FROM gateway_removals WHERE gatewayId = :gatewayId AND phase = :phase")
  suspend fun deleteGatewayRemovalInPhase(
    gatewayId: String,
    phase: String,
  )
}

/** Disposable gateway-derived projections. Schema mismatches and corruption rebuild this file. */
@Database(
  entities = [CachedSessionEntity::class, CachedMessageEntity::class, CachedGatewayOwnerEntity::class],
  version = 3,
  exportSchema = true,
)
internal abstract class GatewayCacheDatabase : RoomDatabase() {
  abstract fun dao(): ChatCacheDao

  companion object {
    suspend fun open(
      context: Context,
      name: String = GATEWAY_CACHE_DB_NAME,
    ): GatewayCacheDatabase {
      val appContext = context.applicationContext

      fun build(): GatewayCacheDatabase =
        Room
          .databaseBuilder(appContext, GatewayCacheDatabase::class.java, name)
          // Cache rows are gateway-owned projections. A missing migration means rebuild, and
          // dropAllTables also removes obsolete cache tables left by older formats.
          .fallbackToDestructiveMigration(true)
          .build()

      return try {
        build().openValidated()
      } catch (error: CancellationException) {
        // Cancellation is not corruption and must never discard a valid offline cache.
        throw error
      } catch (_: Throwable) {
        appContext.deleteDatabase(name)
        build().openValidated()
      }
    }
  }
}

/** Durable client-owned state. Every future schema change requires an explicit Room migration. */
@Database(
  entities = [
    OutboxCommandEntity::class,
    OutboxAttachmentEntity::class,
    OutboxAttachmentChunkEntity::class,
    ComposerSendAdmissionEntity::class,
    ClientStateMetadataEntity::class,
    GatewayRemovalEntity::class,
  ],
  version = 1,
  exportSchema = true,
)
internal abstract class ClientStateDatabase : RoomDatabase() {
  abstract fun outboxDao(): ChatOutboxDao

  abstract fun controlDao(): ClientStateControlDao

  companion object {
    suspend fun open(
      context: Context,
      name: String = CLIENT_STATE_DB_NAME,
    ): ClientStateDatabase =
      Room
        .databaseBuilder(context.applicationContext, ClientStateDatabase::class.java, name)
        .build()
        // Fail closed and preserve the file if durable state cannot be opened or validated.
        .openValidated()
  }
}

/**
 * Shipped combined database, retained only as the one-time import owner.
 *
 * Runtime reads and writes never use this type after [AndroidClientDatabases.start] completes.
 */
@Entity(tableName = "cached_sessions", primaryKeys = ["gatewayId", "agentId", "sessionKey"])
internal data class LegacyCachedSessionEntity(
  val gatewayId: String,
  val agentId: String,
  val sessionKey: String,
  val displayName: String?,
  val updatedAtMs: Long?,
  val rowOrder: Int,
)

@Database(
  entities = [
    LegacyCachedSessionEntity::class,
    CachedMessageEntity::class,
    OutboxCommandEntity::class,
    OutboxAttachmentEntity::class,
    OutboxAttachmentChunkEntity::class,
    ComposerSendAdmissionEntity::class,
    CachedGatewayOwnerEntity::class,
  ],
  version = 8,
  exportSchema = false,
)
internal abstract class LegacyChatDatabase : RoomDatabase() {
  abstract fun outboxDao(): ChatOutboxDao

  companion object {
    internal val MIGRATION_2_3 =
      object : Migration(2, 3) {
        override suspend fun migrate(connection: SQLiteConnection) {
          // v2 persisted every post-dispatch exception as queued+lastError. Those rows may
          // already have run, so upgrading must park them alongside crash-interrupted sends.
          connection
            .prepare(
              "UPDATE outbox_commands SET status = ?, lastError = ? " +
                "WHERE status = ? OR (status = ? AND lastError IS NOT NULL)",
            ).use { statement ->
              statement.bindText(1, ChatOutboxStatus.Failed.dbValue)
              statement.bindText(2, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
              statement.bindText(3, ChatOutboxStatus.Sending.dbValue)
              statement.bindText(4, ChatOutboxStatus.Queued.dbValue)
              statement.step()
            }
        }
      }

    internal val MIGRATION_3_4 =
      object : Migration(3, 4) {
        override suspend fun migrate(connection: SQLiteConnection) {
          connection.execSQL("ALTER TABLE `outbox_commands` ADD COLUMN `gatedEpoch` INTEGER")
          // Legacy queued command-shaped rows predate connection epochs; the sentinel makes
          // them park for explicit retry instead of silently replaying on the next reconnect.
          connection
            .prepare(
              "UPDATE outbox_commands SET gatedEpoch = ? WHERE status = ? AND text LIKE '/%'",
            ).use { statement ->
              statement.bindLong(1, OUTBOX_GATED_EPOCH_NEVER)
              statement.bindText(2, ChatOutboxStatus.Queued.dbValue)
              statement.step()
            }
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox_attachments` (`id` TEXT NOT NULL, `commandId` TEXT NOT NULL, " +
              "`position` INTEGER NOT NULL, `type` TEXT NOT NULL, `mimeType` TEXT NOT NULL, `fileName` TEXT NOT NULL, " +
              "`durationMs` INTEGER, `byteLength` INTEGER NOT NULL, PRIMARY KEY(`id`))",
          )
          connection.execSQL("CREATE INDEX IF NOT EXISTS `index_outbox_attachments_commandId` ON `outbox_attachments` (`commandId`)")
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox_attachment_chunks` (`attachmentId` TEXT NOT NULL, " +
              "`chunkIndex` INTEGER NOT NULL, `bytes` BLOB NOT NULL, PRIMARY KEY(`attachmentId`, `chunkIndex`))",
          )
        }
      }

    internal val MIGRATION_4_5 =
      object : Migration(4, 5) {
        override suspend fun migrate(connection: SQLiteConnection) {
          connection.execSQL("ALTER TABLE `outbox_commands` ADD COLUMN `ownerAgentId` TEXT")
          // Agent-qualified keys carry a durable owner in the key itself. Backfill it so session
          // deletion and replay keep working after upgrade without consulting mutable defaults.
          connection.execSQL(
            "UPDATE outbox_commands SET ownerAgentId = " +
              "substr(sessionKey, 7, instr(substr(sessionKey, 7), ':') - 1) " +
              "WHERE sessionKey LIKE 'agent:%:%' AND instr(substr(sessionKey, 7), ':') > 1",
          )
          // Earlier rows did not persist the default agent that owned an unscoped key. Never
          // guess after upgrade: queued input stays visible for manual resend, while accepted
          // input remains delivery-ambiguous and must not be replayed under a different owner.
          connection
            .prepare(
              "UPDATE outbox_commands SET status = ?, lastError = ? " +
                "WHERE status = ? AND sessionKey NOT LIKE 'agent:%'",
            ).use { statement ->
              statement.bindText(1, ChatOutboxStatus.Failed.dbValue)
              statement.bindText(2, OUTBOX_OWNER_CHANGED_ERROR)
              statement.bindText(3, ChatOutboxStatus.Queued.dbValue)
              statement.step()
            }
          connection
            .prepare(
              "UPDATE outbox_commands SET status = ?, lastError = ? " +
                "WHERE status = ? AND sessionKey NOT LIKE 'agent:%'",
            ).use { statement ->
              statement.bindText(1, ChatOutboxStatus.Failed.dbValue)
              statement.bindText(2, OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
              statement.bindText(3, ChatOutboxStatus.Accepted.dbValue)
              statement.step()
            }
        }
      }

    internal val MIGRATION_5_6 =
      object : Migration(5, 6) {
        override suspend fun migrate(connection: SQLiteConnection) {
          // Session and transcript caches are disposable, and legacy unscoped rows have no
          // provable owner. Rebuild both; the durable outbox remains intact across the upgrade.
          connection.execSQL("DROP TABLE IF EXISTS `cached_sessions`")
          connection.execSQL("DROP TABLE IF EXISTS `cached_messages`")
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `cached_sessions` " +
              "(`gatewayId` TEXT NOT NULL, `agentId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
              "`displayName` TEXT, `updatedAtMs` INTEGER, `rowOrder` INTEGER NOT NULL, " +
              "PRIMARY KEY(`gatewayId`, `agentId`, `sessionKey`))",
          )
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `cached_messages` " +
              "(`gatewayId` TEXT NOT NULL, `agentId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
              "`rowOrder` INTEGER NOT NULL, `role` TEXT NOT NULL, `textPartsJson` TEXT NOT NULL, " +
              "`timestampMs` INTEGER, `idempotencyKey` TEXT, " +
              "PRIMARY KEY(`gatewayId`, `agentId`, `sessionKey`, `rowOrder`))",
          )
        }
      }

    internal val MIGRATION_6_7 =
      object : Migration(6, 7) {
        override suspend fun migrate(connection: SQLiteConnection) {
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `cached_gateway_owners` " +
              "(`gatewayId` TEXT NOT NULL, `agentId` TEXT NOT NULL, PRIMARY KEY(`gatewayId`))",
          )
        }
      }

    internal val MIGRATION_7_8 =
      object : Migration(7, 8) {
        override suspend fun migrate(connection: SQLiteConnection) {
          connection.execSQL(
            "CREATE TABLE IF NOT EXISTS `composer_send_admissions` " +
              "(`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, `ownerAgentId` TEXT NOT NULL, " +
              "`sessionKey` TEXT NOT NULL, PRIMARY KEY(`id`))",
          )
        }
      }

    suspend fun open(
      context: Context,
      name: String,
    ): LegacyChatDatabase =
      Room
        .databaseBuilder(context.applicationContext, LegacyChatDatabase::class.java, name)
        .addMigrations(MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8)
        // v1 contains only disposable transcripts. Durable state starts in v2.
        .fallbackToDestructiveMigrationFrom(true, 1)
        .build()
        .openValidated()
  }
}

private suspend fun <T : RoomDatabase> T.openValidated(): T {
  try {
    // Acquiring a connection forces Room's lazy schema validation before publishing the store.
    useReaderConnection { }
    return this
  } catch (error: Throwable) {
    close()
    throw error
  }
}

private class OpenedAndroidClientDatabases private constructor(
  private val context: Context,
  val gatewayCache: GatewayCacheDatabase,
  val clientState: ClientStateDatabase,
) : AutoCloseable {
  companion object {
    suspend fun inMemory(context: Context): OpenedAndroidClientDatabases {
      val appContext = context.applicationContext
      val state = Room.inMemoryDatabaseBuilder(appContext, ClientStateDatabase::class.java).build().openValidated()
      return try {
        val cache = Room.inMemoryDatabaseBuilder(appContext, GatewayCacheDatabase::class.java).build().openValidated()
        OpenedAndroidClientDatabases(appContext, cache, state)
      } catch (error: Throwable) {
        state.close()
        throw error
      }
    }

    suspend fun open(
      context: Context,
      gatewayCacheName: String = GATEWAY_CACHE_DB_NAME,
      clientStateName: String = CLIENT_STATE_DB_NAME,
      legacyName: String = LEGACY_CHAT_DATABASE_NAME,
      registeredGatewayIds: Set<String>? = null,
    ): OpenedAndroidClientDatabases {
      val appContext = context.applicationContext
      val state = ClientStateDatabase.open(appContext, clientStateName)
      var cache: GatewayCacheDatabase? = null
      return try {
        cache = GatewayCacheDatabase.open(appContext, gatewayCacheName)
        OpenedAndroidClientDatabases(appContext, cache, state).also { databases ->
          databases.importLegacyStateIfNeeded(legacyName)
          databases.resolvePendingGatewayRemovals(registeredGatewayIds)
        }
      } catch (error: Throwable) {
        cache?.close()
        state.close()
        throw error
      }
    }
  }

  val transcriptCache = RoomChatTranscriptCache(gatewayCache)

  val commandOutbox = RoomChatCommandOutbox(clientState)

  suspend fun stageGatewayRemoval(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    // A retry may race an interrupted committed purge. Never downgrade that irreversible marker.
    clientState.controlDao().insertGatewayRemovalIfAbsent(GatewayRemovalEntity(gateway, GATEWAY_REMOVAL_STAGED))
  }

  suspend fun cancelGatewayRemoval(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    clientState.controlDao().deleteGatewayRemovalInPhase(gateway, GATEWAY_REMOVAL_STAGED)
  }

  /**
   * Marks cleanup irreversible before touching either file. A crash can leave one database ahead
   * of the other, so startup resumes this idempotent operation before publishing the stores.
   */
  suspend fun commitGatewayRemoval(
    gatewayId: String,
    requireCacheRemoval: Boolean = false,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    withContext(NonCancellable) {
      // State deletion and its phase advance are atomic. A rollback leaves no irreversible marker;
      // after commit, startup may clear only disposable cache and must preserve any newer outbox rows.
      clientState.withWriteTransaction {
        clientState.controlDao().upsertGatewayRemoval(GatewayRemovalEntity(gateway, GATEWAY_REMOVAL_COMMITTING))
        commandOutbox.clearGateway(gateway)
        clientState.controlDao().upsertGatewayRemoval(GatewayRemovalEntity(gateway, GATEWAY_REMOVAL_CACHE_PENDING))
      }
      completeCacheRemoval(gateway, propagateFailure = requireCacheRemoval)
    }
  }

  override fun close() {
    gatewayCache.close()
    clientState.close()
  }

  private suspend fun importLegacyStateIfNeeded(legacyName: String) {
    val control = clientState.controlDao()
    if (control.metadataValue(LEGACY_IMPORT_KEY) == LEGACY_IMPORT_COMPLETE) {
      context.deleteDatabase(legacyName)
      return
    }
    val legacyFile = context.getDatabasePath(legacyName)
    if (!legacyFile.exists()) {
      control.upsertMetadata(ClientStateMetadataEntity(LEGACY_IMPORT_KEY, LEGACY_IMPORT_COMPLETE))
      return
    }

    val legacy = LegacyChatDatabase.open(context, legacyName)
    try {
      val source = legacy.outboxDao()
      val commands = source.allCommands()
      val admissions = source.allAdmissionReceipts()
      val attachments = source.allAttachments()
      clientState.withWriteTransaction {
        val destination = clientState.outboxDao()
        if (commands.isNotEmpty()) destination.upsertImportedCommands(commands)
        if (admissions.isNotEmpty()) destination.upsertImportedAdmissionReceipts(admissions)
        if (attachments.isNotEmpty()) destination.upsertImportedAttachments(attachments)
      }

      var afterAttachmentId: String? = null
      var afterChunkIndex = -1
      while (true) {
        val chunks = source.attachmentChunkPage(afterAttachmentId, afterChunkIndex, LEGACY_IMPORT_CHUNK_PAGE_ROWS)
        if (chunks.isEmpty()) break
        clientState.withWriteTransaction {
          clientState.outboxDao().upsertImportedAttachmentChunks(chunks)
        }
        chunks.last().let { cursor ->
          afterAttachmentId = cursor.attachmentId
          afterChunkIndex = cursor.chunkIndex
        }
      }
      clientState.withWriteTransaction {
        // Earlier page commits are idempotent. This marker publishes them only after the source
        // cursor is exhausted, so a crash simply replays REPLACE inserts on the next start.
        control.upsertMetadata(ClientStateMetadataEntity(LEGACY_IMPORT_KEY, LEGACY_IMPORT_COMPLETE))
      }
    } finally {
      legacy.close()
    }
    // If deletion fails, the next open sees the completion marker and retries only deletion.
    context.deleteDatabase(legacyName)
  }

  private suspend fun resolvePendingGatewayRemovals(registeredGatewayIds: Set<String>?) {
    for (removal in clientState.controlDao().gatewayRemovals()) {
      when {
        removal.phase == GATEWAY_REMOVAL_CACHE_PENDING -> {
          completeCacheRemoval(removal.gatewayId, propagateFailure = false)
        }

        removal.phase == GATEWAY_REMOVAL_COMMITTING -> {
          commitGatewayRemoval(removal.gatewayId)
        }

        registeredGatewayIds != null && removal.gatewayId !in registeredGatewayIds -> {
          commitGatewayRemoval(removal.gatewayId)
        }

        registeredGatewayIds != null -> {
          cancelGatewayRemoval(removal.gatewayId)
        }
      }
    }
  }

  private suspend fun completeCacheRemoval(
    gatewayId: String,
    propagateFailure: Boolean,
  ) {
    try {
      transcriptCache.clearGateway(gatewayId)
    } catch (error: Exception) {
      if (propagateFailure) throw error
      // Cache is disposable. Keep cache-pending for the next open, but the durable purge has
      // committed and callers may safely retire auth without risking later outbox deletion.
      Log.w("ClientDatabases", "Deferring gateway cache cleanup", error)
      return
    }
    clientState.controlDao().deleteGatewayRemovalInPhase(gatewayId, GATEWAY_REMOVAL_CACHE_PENDING)
  }
}

/**
 * One installation-wide pair of multi-gateway databases initialized on a private IO scope.
 * Every facade operation awaits the one-time legacy import before reaching either Room store.
 */
internal class AndroidClientDatabases private constructor(
  private val scope: CoroutineScope,
  private val initialization: Deferred<OpenedAndroidClientDatabases>,
  private val openedReference: AtomicReference<OpenedAndroidClientDatabases?>,
  private val closed: AtomicBoolean,
) : AutoCloseable {
  companion object {
    fun start(
      context: Context,
      gatewayCacheName: String = GATEWAY_CACHE_DB_NAME,
      clientStateName: String = CLIENT_STATE_DB_NAME,
      legacyName: String = LEGACY_CHAT_DATABASE_NAME,
      registeredGatewayIds: Set<String>? = null,
    ): AndroidClientDatabases =
      start {
        OpenedAndroidClientDatabases.open(
          context = context.applicationContext,
          gatewayCacheName = gatewayCacheName,
          clientStateName = clientStateName,
          legacyName = legacyName,
          registeredGatewayIds = registeredGatewayIds,
        )
      }

    fun inMemory(context: Context): AndroidClientDatabases = start { OpenedAndroidClientDatabases.inMemory(context) }

    private fun start(open: suspend () -> OpenedAndroidClientDatabases): AndroidClientDatabases {
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
      val openedReference = AtomicReference<OpenedAndroidClientDatabases?>()
      val closed = AtomicBoolean(false)
      val initialization =
        scope.async {
          val opened = open()
          if (closed.get()) {
            opened.close()
            throw CancellationException("Android client databases closed during initialization")
          }
          openedReference.set(opened)
          if (closed.get() && openedReference.compareAndSet(opened, null)) {
            opened.close()
            throw CancellationException("Android client databases closed during initialization")
          }
          opened
        }
      return AndroidClientDatabases(scope, initialization, openedReference, closed)
    }
  }

  private val transcriptCache = RoomChatTranscriptCache { ready().gatewayCache }
  private val commandOutbox = RoomChatCommandOutbox { ready().clientState }

  fun transcriptCache(): ChatTranscriptCache = transcriptCache

  fun commandOutbox(): ChatCommandOutbox = commandOutbox

  suspend fun stageGatewayRemoval(gatewayId: String) = ready().stageGatewayRemoval(gatewayId)

  suspend fun cancelGatewayRemoval(gatewayId: String) = ready().cancelGatewayRemoval(gatewayId)

  suspend fun commitGatewayRemoval(
    gatewayId: String,
    requireCacheRemoval: Boolean = false,
  ) = ready().commitGatewayRemoval(gatewayId, requireCacheRemoval)

  internal suspend fun gatewayCacheDatabase(): GatewayCacheDatabase = ready().gatewayCache

  internal suspend fun clientStateDatabase(): ClientStateDatabase = ready().clientState

  private suspend fun ready(): OpenedAndroidClientDatabases {
    check(!closed.get()) { "Android client databases are closed" }
    val opened = initialization.await()
    check(!closed.get()) { "Android client databases are closed" }
    return opened
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    scope.cancel()
    openedReference.getAndSet(null)?.close()
  }
}

private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }
