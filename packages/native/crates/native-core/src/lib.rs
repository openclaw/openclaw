use napi::bindgen_prelude::*;
use once_cell::sync::OnceCell;
use rusqlite::Connection;
use std::sync::Mutex;
use std::time::Instant;

static START_TIME: OnceCell<Instant> = OnceCell::new();

// Global SQLite connection pool for session store (Rust-owned, outside V8 heap)
static SESSION_DB: OnceCell<Mutex<Connection>> = OnceCell::new();

fn start_time() -> Instant {
  *START_TIME.get_or_init(Instant::now)
}

// ── Core utilities ──

#[napi]
pub fn version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn uptime_ms() -> f64 {
  start_time().elapsed().as_secs_f64() * 1000.0
}

#[napi]
pub fn hardware_concurrency() -> i32 {
  std::thread::available_parallelism()
    .map(|n| n.get() as i32)
    .unwrap_or(1)
}

#[napi]
pub fn parse_json(input: String) -> Result<String> {
  let value: serde_json::Value =
    serde_json::from_str(&input).map_err(|e| Error::from_reason(format!("JSON parse error: {e}")))?;
  serde_json::to_string_pretty(&value)
    .map_err(|e| Error::from_reason(format!("JSON serialize error: {e}")))
}

// ── SQLite Session Store ──

/// Opens (or creates) a SQLite database at the given path and initializes schema.
/// The connection is held in Rust-owned memory; JS gets a session handle.
/// Returns the number of sessions in the store.
#[napi]
pub fn session_store_open(db_path: String) -> Result<i32> {
  let conn = Connection::open(&db_path)
    .map_err(|e| Error::from_reason(format!("Failed to open SQLite: {e}")))?;

  conn
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec'))
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        entry_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')),
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_session
        ON transcript_entries(session_id, seq);
      ",
    )
    .map_err(|e| Error::from_reason(format!("Schema init failed: {e}")))?;

  let count: i32 = conn
    .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
    .unwrap_or(0);

  SESSION_DB
    .set(Mutex::new(conn))
    .map_err(|_| Error::from_reason("Session store already open"))?;

  Ok(count)
}

/// Returns true if a session store connection is open.
#[napi]
pub fn session_store_is_open() -> bool {
  SESSION_DB.get().is_some()
}

/// Stores or updates a session entry. `data` is a JSON string of the session metadata.
#[napi]
pub fn session_store_upsert(session_id: String, data: String) -> Result<()> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  conn
    .execute(
      "INSERT INTO sessions (id, data, updated_at) VALUES (?1, ?2, unixepoch('subsec'))
       ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = unixepoch('subsec')",
      rusqlite::params![session_id, data],
    )
    .map_err(|e| Error::from_reason(format!("Upsert failed: {e}")))?;
  Ok(())
}

/// Retrieves a session entry as JSON string, or null if not found.
#[napi]
pub fn session_store_get(session_id: String) -> Result<Option<String>> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  let result: Result<String, _> = conn.query_row(
    "SELECT data FROM sessions WHERE id = ?1",
    rusqlite::params![session_id],
    |r| r.get(0),
  );
  match result {
    Ok(data) => Ok(Some(data)),
    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
    Err(e) => Err(Error::from_reason(format!("Get failed: {e}"))),
  }
}

/// Lists all session IDs in the store.
#[napi]
pub fn session_store_list_ids() -> Result<Vec<String>> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  let mut stmt = conn
    .prepare("SELECT id FROM sessions ORDER BY updated_at DESC")
    .map_err(|e| Error::from_reason(format!("Prepare failed: {e}")))?;
  let rows = stmt
    .query_map([], |r| r.get(0))
    .map_err(|e| Error::from_reason(format!("Query failed: {e}")))?;
  let mut ids = Vec::new();
  for row in rows {
    ids.push(row.map_err(|e| Error::from_reason(format!("Row error: {e}")))?);
  }
  Ok(ids)
}

/// Deletes a session and all its transcript entries.
#[napi]
pub fn session_store_delete(session_id: String) -> Result<bool> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  let deleted = conn
    .execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![session_id])
    .map_err(|e| Error::from_reason(format!("Delete failed: {e}")))?;
  Ok(deleted > 0)
}

/// Appends a transcript entry to a session. Returns the entry id.
#[napi]
pub fn transcript_append(
  session_id: String,
  seq: i32,
  entry_type: String,
  data: String,
) -> Result<i64> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  conn
    .execute(
      "INSERT INTO transcript_entries (session_id, seq, entry_type, data)
       VALUES (?1, ?2, ?3, ?4)",
      rusqlite::params![session_id, seq, entry_type, data],
    )
    .map_err(|e| Error::from_reason(format!("Append failed: {e}")))?;
  Ok(conn.last_insert_rowid())
}

/// Retrieves all transcript entries for a session as a JSON array string.
#[napi]
pub fn transcript_get_all(session_id: String) -> Result<String> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  let mut stmt = conn
    .prepare(
      "SELECT seq, entry_type, data FROM transcript_entries
       WHERE session_id = ?1 ORDER BY seq",
    )
    .map_err(|e| Error::from_reason(format!("Prepare failed: {e}")))?;
  let rows = stmt
    .query_map(rusqlite::params![session_id], |r| {
      let seq: i32 = r.get(0)?;
      let entry_type: String = r.get(1)?;
      let data: String = r.get(2)?;
      Ok(format!(
        r#"{{"seq":{seq},"type":"{entry_type}","data":{data}}}"#,
        seq = seq,
        entry_type = serde_json::to_string(&entry_type).unwrap_or_default(),
        data = data
      ))
    })
    .map_err(|e| Error::from_reason(format!("Query failed: {e}")))?;

  let mut entries = Vec::new();
  for row in rows {
    entries.push(row.map_err(|e| Error::from_reason(format!("Row error: {e}")))?);
  }
  Ok(format!("[{}]", entries.join(",")))
}

/// Returns transcript count for a session.
#[napi]
pub fn transcript_count(session_id: String) -> Result<i32> {
  let db = SESSION_DB
    .get()
    .ok_or_else(|| Error::from_reason("Session store not open"))?;
  let conn = db.lock().map_err(|e| Error::from_reason(format!("Lock error: {e}")))?;
  let count: i32 = conn
    .query_row(
      "SELECT COUNT(*) FROM transcript_entries WHERE session_id = ?1",
      rusqlite::params![session_id],
      |r| r.get(0),
    )
    .map_err(|e| Error::from_reason(format!("Count failed: {e}")))?;
  Ok(count)
}

/// Closes the session store. Returns true if a connection was open.
#[napi]
pub fn session_store_close() -> Result<bool> {
  if let Some(mutex) = SESSION_DB.get() {
    if let Ok(conn) = mutex.lock() {
      let _ = conn.close();
    }
    // Can't remove from OnceCell, but we can poison it
    // The Mutex is dropped when the lock guard goes out of scope
    Ok(true)
  } else {
    Ok(false)
  }
}
