package ai.openclaw.app.gateway

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

data class OpenClawSQLiteDeviceIdentityRow(
  val deviceId: String,
  val publicKeyPem: String,
  val privateKeyPem: String,
  val createdAtMs: Long,
)

data class OpenClawSQLiteDeviceAuthTokenRow(
  val deviceId: String,
  val role: String,
  val token: String,
  val scopesJson: String,
  val updatedAtMs: Long,
)

class OpenClawSQLiteStateStore(
  context: Context,
) {
  private val appContext = context.applicationContext
  private val databaseFile = File(appContext.filesDir, "openclaw/state/openclaw.sqlite")

  fun databaseFile(): File = databaseFile

  @Synchronized
  fun readDeviceIdentity(identityKey: String = "default"): OpenClawSQLiteDeviceIdentityRow? {
    if (!databaseFile.exists()) return null
    return openDatabase().use { db ->
      db
        .rawQuery(
          """
          SELECT device_id, public_key_pem, private_key_pem, created_at_ms
          FROM device_identities
          WHERE identity_key = ?
          """.trimIndent(),
          arrayOf(identityKey),
        ).use { cursor ->
          if (!cursor.moveToFirst()) return@use null
          OpenClawSQLiteDeviceIdentityRow(
            deviceId = cursor.getString(0),
            publicKeyPem = cursor.getString(1),
            privateKeyPem = cursor.getString(2),
            createdAtMs = cursor.getLong(3),
          )
        }
    }
  }

  @Synchronized
  fun writeDeviceIdentity(
    identity: OpenClawSQLiteDeviceIdentityRow,
    identityKey: String = "default",
    updatedAtMs: Long = System.currentTimeMillis(),
  ) {
    openDatabase().use { db ->
      db.inWriteTransaction {
        val values =
          ContentValues().apply {
            put("identity_key", identityKey)
            put("device_id", identity.deviceId)
            put("public_key_pem", identity.publicKeyPem)
            put("private_key_pem", identity.privateKeyPem)
            put("created_at_ms", identity.createdAtMs)
            put("updated_at_ms", updatedAtMs)
          }
        db.insertWithOnConflict("device_identities", null, values, SQLiteDatabase.CONFLICT_REPLACE)
      }
    }
  }

  @Synchronized
  fun readDeviceAuthToken(
    deviceId: String,
    role: String,
  ): OpenClawSQLiteDeviceAuthTokenRow? {
    if (!databaseFile.exists()) return null
    return openDatabase().use { db ->
      db
        .rawQuery(
          """
          SELECT device_id, role, token, scopes_json, updated_at_ms
          FROM device_auth_tokens
          WHERE device_id = ? AND role = ?
          """.trimIndent(),
          arrayOf(deviceId, role),
        ).use { cursor ->
          if (!cursor.moveToFirst()) return@use null
          OpenClawSQLiteDeviceAuthTokenRow(
            deviceId = cursor.getString(0),
            role = cursor.getString(1),
            token = cursor.getString(2),
            scopesJson = cursor.getString(3),
            updatedAtMs = cursor.getLong(4),
          )
        }
    }
  }

  @Synchronized
  fun readLatestDeviceAuthDeviceId(): String? {
    if (!databaseFile.exists()) return null
    return openDatabase().use { db ->
      db
        .rawQuery(
          """
          SELECT device_id
          FROM device_auth_tokens
          ORDER BY updated_at_ms DESC, device_id ASC
          LIMIT 1
          """.trimIndent(),
          emptyArray(),
        ).use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }
  }

  @Synchronized
  fun upsertDeviceAuthToken(row: OpenClawSQLiteDeviceAuthTokenRow) {
    openDatabase().use { db ->
      db.inWriteTransaction {
        val values =
          ContentValues().apply {
            put("device_id", row.deviceId)
            put("role", row.role)
            put("token", row.token)
            put("scopes_json", row.scopesJson)
            put("updated_at_ms", row.updatedAtMs)
          }
        db.insertWithOnConflict("device_auth_tokens", null, values, SQLiteDatabase.CONFLICT_REPLACE)
      }
    }
  }

  @Synchronized
  fun deleteDeviceAuthToken(
    deviceId: String,
    role: String,
  ) {
    openDatabase().use { db ->
      db.inWriteTransaction {
        db.delete("device_auth_tokens", "device_id = ? AND role = ?", arrayOf(deviceId, role))
      }
    }
  }

  @Synchronized
  fun deleteAllDeviceAuthTokens() {
    openDatabase().use { db ->
      db.inWriteTransaction {
        db.delete("device_auth_tokens", null, null)
      }
    }
  }

  @Synchronized
  fun readRecentNotificationPackages(limit: Int = 64): List<String> {
    if (!databaseFile.exists()) return emptyList()
    return openDatabase().use { db ->
      db
        .rawQuery(
          """
          SELECT package_name
          FROM android_notification_recent_packages
          ORDER BY sort_order ASC, package_name ASC
          LIMIT ?
          """.trimIndent(),
          arrayOf(limit.coerceAtLeast(0).toString()),
        ).use { cursor ->
          val packages = mutableListOf<String>()
          while (cursor.moveToNext()) {
            packages += cursor.getString(0)
          }
          packages
        }
    }
  }

  @Synchronized
  fun replaceRecentNotificationPackages(
    packageNames: List<String>,
    limit: Int = 64,
    updatedAtMs: Long = System.currentTimeMillis(),
  ) {
    val normalized =
      packageNames
        .asSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinct()
        .take(limit.coerceAtLeast(0))
        .toList()
    openDatabase().use { db ->
      db.inWriteTransaction {
        db.delete("android_notification_recent_packages", null, null)
        normalized.forEachIndexed { index, packageName ->
          val values =
            ContentValues().apply {
              put("package_name", packageName)
              put("sort_order", index)
              put("updated_at_ms", updatedAtMs)
            }
          db.insertWithOnConflict(
            "android_notification_recent_packages",
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
          )
        }
      }
    }
  }

  private fun openDatabase(): SQLiteDatabase {
    databaseFile.parentFile?.mkdirs()
    val db =
      SQLiteDatabase.openDatabase(
        databaseFile.absolutePath,
        null,
        SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY,
      )
    configure(db)
    return db
  }

  private fun configure(db: SQLiteDatabase) {
    db.enableWriteAheadLogging()
    executePragma(db, "PRAGMA synchronous = NORMAL")
    executePragma(db, "PRAGMA busy_timeout = 30000")
    executePragma(db, "PRAGMA foreign_keys = ON")
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS device_identities (
        identity_key TEXT NOT NULL PRIMARY KEY,
        device_id TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
      """.trimIndent(),
    )
    db.execSQL(
      """
      CREATE INDEX IF NOT EXISTS idx_device_identities_device
      ON device_identities(device_id, updated_at_ms DESC)
      """.trimIndent(),
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS device_auth_tokens (
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (device_id, role)
      )
      """.trimIndent(),
    )
    db.execSQL(
      """
      CREATE INDEX IF NOT EXISTS idx_device_auth_tokens_updated
      ON device_auth_tokens(updated_at_ms DESC, device_id, role)
      """.trimIndent(),
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS android_notification_recent_packages (
        package_name TEXT NOT NULL PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
      """.trimIndent(),
    )
    db.execSQL(
      """
      CREATE INDEX IF NOT EXISTS idx_android_notification_recent_packages_order
      ON android_notification_recent_packages(sort_order, package_name)
      """.trimIndent(),
    )
  }

  private fun executePragma(
    db: SQLiteDatabase,
    sql: String,
  ) {
    db.rawQuery(sql, null).use { cursor ->
      if (cursor.moveToFirst()) {
        // Some PRAGMA assignments return their new value; reading it closes the cursor cleanly.
      }
    }
  }

  private inline fun SQLiteDatabase.inWriteTransaction(body: () -> Unit) {
    beginTransaction()
    try {
      body()
      setTransactionSuccessful()
    } finally {
      endTransaction()
    }
  }
}
