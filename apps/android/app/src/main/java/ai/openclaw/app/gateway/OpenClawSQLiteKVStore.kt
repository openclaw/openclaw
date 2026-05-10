package ai.openclaw.app.gateway

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

class OpenClawSQLiteKVStore(
  context: Context,
) {
  private val appContext = context.applicationContext
  private val databaseFile = File(appContext.filesDir, "openclaw/state/openclaw.sqlite")

  fun databaseFile(): File = databaseFile

  @Synchronized
  fun readString(
    scope: String,
    key: String,
  ): String? {
    if (!databaseFile.exists()) return null
    return openDatabase().use { db ->
      db
        .rawQuery(
          "SELECT value_json FROM kv WHERE scope = ? AND key = ?",
          arrayOf(scope, key),
        ).use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }
  }

  @Synchronized
  fun writeString(
    scope: String,
    key: String,
    value: String,
  ) {
    openDatabase().use { db ->
      val values =
        ContentValues().apply {
          put("scope", scope)
          put("key", key)
          put("value_json", value)
          put("updated_at", System.currentTimeMillis())
        }
      db.beginTransaction()
      try {
        db.insertWithOnConflict("kv", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        db.setTransactionSuccessful()
      } finally {
        db.endTransaction()
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
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, key)
      )
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
}
