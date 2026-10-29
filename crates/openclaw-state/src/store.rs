use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::id::SessionId;
use openclaw_core::message::{InboundMessage, ReplyPayload};
use openclaw_core::traits::StateStore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Pairing entry for untrusted DM senders (`openclaw pairing approve <channel> <code>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub code: String,
    pub channel: String,
    pub account_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub chat_id: String,
    pub status: String, // "pending" | "approved" | "dismissed"
    pub created_at: String,
    /// True only when this call inserted a new request, so the channel knows
    /// whether to send a pairing notice.
    #[serde(skip)]
    pub created: bool,
}

/// Documented lifetime of a pending DM pairing code (1 hour).
pub const PAIRING_CODE_TTL_SECS: u64 = 60 * 60;

/// Documented cap on pending DM pairing requests per channel account.
pub const PAIRING_MAX_PENDING: i64 = 3;

/// Code alphabet: uppercase alphanumeric without ambiguous `0 O 1 I`.
const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_CODE_LEN: usize = 8;

/// Generate an 8-character pairing code.
///
/// The alphabet matches the documented set (no `0O1I`). Entropy comes from
/// `uuid` v4, which draws from the OS CSPRNG: the code is the only secret that
/// authorizes a sender, so a time-seeded PRNG would let an attacker who can guess
/// the issue time narrow the search space. Collisions are retried on insert.
fn random_pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut code = String::with_capacity(PAIRING_CODE_LEN);
    for byte in &bytes[..PAIRING_CODE_LEN] {
        // 256 % 32 == 0, so modulo over the 32-symbol alphabet is unbiased.
        code.push(PAIRING_ALPHABET[(*byte as usize) % PAIRING_ALPHABET.len()] as char);
    }
    code
}

/// Long-term agent memory entry stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: i64,
    pub key: String,
    pub content: String,
    pub created_at: String,
}

/// Scheduled automation/cron job stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobRecord {
    pub id: String,
    pub name: String,
    pub interval_secs: u64,
    pub prompt: String,
    pub session_id: String,
    pub enabled: bool,
    pub last_run: Option<String>,
}

/// SQLite-backed state store.
#[derive(Debug)]
pub struct SqliteStateStore {
    pub(crate) conn: Mutex<Connection>,
}

impl SqliteStateStore {
    /// Open (or create) a SQLite database at the given path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        let conn = Connection::open(path)
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    /// Open an in-memory database (useful for tests).
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                session_id TEXT NOT NULL,
                author TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

            CREATE TABLE IF NOT EXISTS replies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_replies_session ON replies(session_id, timestamp);

            CREATE TABLE IF NOT EXISTS pairings (
                code TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                account_id TEXT NOT NULL DEFAULT 'default',
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                interval_secs INTEGER NOT NULL,
                prompt TEXT NOT NULL,
                session_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                last_run TEXT
            );
            ",
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        self.migrate_pairing_columns(&conn)?;
        crate::sessions::create_schema(&conn)?;
        Ok(())
    }

    /// Bring an older `pairings` table up to the account-scoped shape.
    ///
    /// `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table, so a
    /// database created before account scoping would otherwise fail every pairing
    /// query. Existing rows become the `default` account, matching the documented
    /// "omitted account id means the literal default account" rule.
    fn migrate_pairing_columns(&self, conn: &Connection) -> Result<()> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(pairings)")
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();
        drop(stmt);
        if !columns.iter().any(|column| column == "account_id") {
            conn.execute(
                "ALTER TABLE pairings ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default'",
                [],
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_pairings_sender
                 ON pairings(channel, account_id, sender_id, status);
             CREATE INDEX IF NOT EXISTS idx_pairings_pending
                 ON pairings(channel, account_id, status, created_at);",
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }
    /// Save a long-term memory entry.
    pub fn add_memory(&self, key: &str, content: &str) -> Result<MemoryRecord> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO memories (key, content, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, content, now],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let id = conn.last_insert_rowid();
        Ok(MemoryRecord {
            id,
            key: key.to_owned(),
            content: content.to_owned(),
            created_at: now,
        })
    }

    /// List all long-term memories.
    pub fn list_memories(&self) -> Result<Vec<MemoryRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare("SELECT id, key, content, created_at FROM memories ORDER BY id DESC LIMIT 100")
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MemoryRecord {
                    id: row.get(0)?,
                    key: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|error| openclaw_core::Error::state(error.to_string()))?);
        }
        Ok(out)
    }

    /// Add or update a scheduled cron job.
    pub fn upsert_cron_job(&self, job: &CronJobRecord) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        conn.execute(
            "INSERT OR REPLACE INTO cron_jobs (id, name, interval_secs, prompt, session_id, enabled, last_run)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                job.id,
                job.name,
                job.interval_secs as i64,
                job.prompt,
                job.session_id,
                i32::from(job.enabled),
                job.last_run,
            ],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }

    /// List all scheduled cron jobs.
    pub fn list_cron_jobs(&self) -> Result<Vec<CronJobRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, interval_secs, prompt, session_id, enabled, last_run FROM cron_jobs ORDER BY name ASC",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let secs: i64 = row.get(2)?;
                let en: i32 = row.get(5)?;
                Ok(CronJobRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    interval_secs: secs.max(1) as u64,
                    prompt: row.get(3)?,
                    session_id: row.get(4)?,
                    enabled: en != 0,
                    last_run: row.get(6)?,
                })
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|error| openclaw_core::Error::state(error.to_string()))?);
        }
        Ok(out)
    }

    /// Check if a sender is already approved on a channel account.
    pub fn is_sender_approved(&self, channel: &str, sender_id: &str) -> Result<bool> {
        self.is_sender_approved_in(channel, "default", sender_id)
    }

    /// Account-scoped approval check. Approving on one account must not admit the
    /// sender on another (official pairing is keyed by channel and account).
    pub fn is_sender_approved_in(
        &self,
        channel: &str,
        account_id: &str,
        sender_id: &str,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*) FROM pairings
                 WHERE channel = ?1 AND account_id = ?2 AND sender_id = ?3 AND status = 'approved'",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let count: i64 = stmt
            .query_row(rusqlite::params![channel, account_id, sender_id], |row| {
                row.get(0)
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(count > 0)
    }

    /// Get or create a pending pairing code for a sender.
    ///
    /// Official rules: 8 uppercase characters without `0O1I`, a code expires
    /// after one hour, and at most 3 pending requests exist per channel account.
    /// A repeat message from the same sender reuses its live code and must not
    /// produce another notice.
    pub fn get_or_create_pairing(
        &self,
        channel: &str,
        sender_id: &str,
        sender_name: &str,
        chat_id: &str,
    ) -> Result<PairingRequest> {
        self.get_or_create_pairing_in(channel, "default", sender_id, sender_name, chat_id)
    }

    /// Account-scoped variant of [`Self::get_or_create_pairing`].
    pub fn get_or_create_pairing_in(
        &self,
        channel: &str,
        account_id: &str,
        sender_id: &str,
        sender_name: &str,
        chat_id: &str,
    ) -> Result<PairingRequest> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let now = chrono::Utc::now();
        let cutoff = (now - chrono::Duration::seconds(PAIRING_CODE_TTL_SECS as i64)).to_rfc3339();
        let now_text = now.to_rfc3339();

        // Expired pending rows are dead weight and must not occupy the cap.
        conn.execute(
            "DELETE FROM pairings WHERE status = 'pending' AND created_at < ?1",
            rusqlite::params![cutoff],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;

        // Reuse a live pending request for this sender instead of re-notifying.
        let existing = conn
            .prepare(
                "SELECT code, channel, account_id, sender_id, sender_name, chat_id, status, created_at
                 FROM pairings
                 WHERE channel = ?1 AND account_id = ?2 AND sender_id = ?3 AND status = 'pending'
                 ORDER BY created_at DESC LIMIT 1",
            )
            .and_then(|mut stmt| {
                stmt.query_row(rusqlite::params![channel, account_id, sender_id], |row| {
                    Ok(PairingRequest {
                        code: row.get(0)?,
                        channel: row.get(1)?,
                        account_id: row.get(2)?,
                        sender_id: row.get(3)?,
                        sender_name: row.get(4)?,
                        chat_id: row.get(5)?,
                        status: row.get(6)?,
                        created_at: row.get(7)?,
                        created: false,
                    })
                })
            });
        if let Ok(request) = existing {
            return Ok(request);
        }

        // Cap pending requests per channel account.
        let pending: i64 = conn
            .prepare(
                "SELECT COUNT(*) FROM pairings
                 WHERE channel = ?1 AND account_id = ?2 AND status = 'pending'",
            )
            .and_then(|mut stmt| {
                stmt.query_row(rusqlite::params![channel, account_id], |row| row.get(0))
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        if pending >= PAIRING_MAX_PENDING {
            return Err(openclaw_core::Error::state(format!(
                "pairing request limit reached ({PAIRING_MAX_PENDING} pending for {channel}:{account_id})"
            )));
        }

        let mut code = random_pairing_code();
        if code.is_empty() {
            return Err(openclaw_core::Error::state(
                "no OS entropy available for pairing code generation".to_owned(),
            ));
        }
        // Retry on primary-key conflict instead of surfacing a storage error.
        for _ in 0..16 {
            match conn.execute(
                "INSERT INTO pairings (code, channel, account_id, sender_id, sender_name, chat_id, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
                rusqlite::params![code, channel, account_id, sender_id, sender_name, chat_id, now_text],
            ) {
                Ok(_) => {
                    return Ok(PairingRequest {
                        code,
                        channel: channel.to_owned(),
                        account_id: account_id.to_owned(),
                        sender_id: sender_id.to_owned(),
                        sender_name: sender_name.to_owned(),
                        chat_id: chat_id.to_owned(),
                        status: "pending".to_owned(),
                        created_at: now_text,
                        created: true,
                    });
                }
                Err(rusqlite::Error::SqliteFailure(error, _))
                    if error.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    code = random_pairing_code();
                }
                Err(error) => {
                    return Err(openclaw_core::Error::state(error.to_string()));
                }
            }
        }
        Err(openclaw_core::Error::state(
            "could not allocate a unique pairing code".to_owned(),
        ))
    }

    /// Number of live pending requests for a channel account.
    pub fn pending_pairing_count(&self, channel: &str, account_id: &str) -> Result<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let cutoff = (chrono::Utc::now()
            - chrono::Duration::seconds(PAIRING_CODE_TTL_SECS as i64))
        .to_rfc3339();
        let count: i64 = conn
            .prepare(
                "SELECT COUNT(*) FROM pairings
                 WHERE channel = ?1 AND account_id = ?2 AND status = 'pending' AND created_at >= ?3",
            )
            .and_then(|mut stmt| {
                stmt.query_row(
                    rusqlite::params![channel, account_id, cutoff],
                    |row| row.get(0),
                )
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(count)
    }

    /// Approve a pending pairing request by channel and code.
    ///
    /// Only a live pending request can be approved: an expired or already-approved
    /// code returns `None` rather than reporting a fresh approval.
    pub fn approve_pairing(&self, channel: &str, code: &str) -> Result<Option<PairingRequest>> {
        self.approve_pairing_in(channel, None, code)
    }

    /// Approve within a specific account, or across the channel when `account_id`
    /// is `None` (the request's own account is used).
    pub fn approve_pairing_in(
        &self,
        channel: &str,
        account_id: Option<&str>,
        code: &str,
    ) -> Result<Option<PairingRequest>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let cutoff = (chrono::Utc::now()
            - chrono::Duration::seconds(PAIRING_CODE_TTL_SECS as i64))
        .to_rfc3339();

        let account_clause = if account_id.is_some() {
            "AND account_id = ?4"
        } else {
            ""
        };
        let sql = format!(
            "UPDATE pairings SET status = 'approved'
             WHERE LOWER(channel) = LOWER(?1) AND UPPER(code) = UPPER(?2)
               AND status = 'pending' AND created_at >= ?3 {account_clause}"
        );
        let updated = match account_id {
            Some(account) => conn.execute(
                &sql,
                rusqlite::params![channel, code, cutoff, account],
            ),
            None => conn.execute(&sql, rusqlite::params![channel, code, cutoff]),
        }
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        if updated == 0 {
            return Ok(None);
        }

        let mut stmt = conn
            .prepare(
                "SELECT code, channel, account_id, sender_id, sender_name, chat_id, status, created_at
                 FROM pairings WHERE UPPER(code) = UPPER(?1)",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let request = stmt
            .query_row(rusqlite::params![code], |row| {
                Ok(PairingRequest {
                    code: row.get(0)?,
                    channel: row.get(1)?,
                    account_id: row.get(2)?,
                    sender_id: row.get(3)?,
                    sender_name: row.get(4)?,
                    chat_id: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                    created: false,
                })
            })
            .ok();
        Ok(request)
    }

    /// Dismiss a pending request. Not a block: the sender may request again.
    pub fn dismiss_pairing(
        &self,
        channel: &str,
        account_id: &str,
        code: &str,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let updated = conn
            .execute(
                "UPDATE pairings SET status = 'dismissed'
                 WHERE LOWER(channel) = LOWER(?1) AND account_id = ?2
                   AND UPPER(code) = UPPER(?3) AND status = 'pending'",
                rusqlite::params![channel, account_id, code],
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(updated > 0)
    }

    /// List pending pairing requests, optionally for one channel/account.
    pub fn list_pairings(&self) -> Result<Vec<PairingRequest>> {
        self.list_pairings_filtered(None, None)
    }

    /// List pairing requests with optional channel and account filters.
    pub fn list_pairings_filtered(
        &self,
        channel: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Vec<PairingRequest>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let cutoff = (chrono::Utc::now()
            - chrono::Duration::seconds(PAIRING_CODE_TTL_SECS as i64))
        .to_rfc3339();
        let mut stmt = conn
            .prepare(
                "SELECT code, channel, account_id, sender_id, sender_name, chat_id, status, created_at
                 FROM pairings
                 WHERE status = 'pending' AND created_at >= ?1
                   AND (?2 IS NULL OR LOWER(channel) = LOWER(?2))
                   AND (?3 IS NULL OR account_id = ?3)
                 ORDER BY created_at DESC",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![cutoff, channel, account_id], |row| {
                Ok(PairingRequest {
                    code: row.get(0)?,
                    channel: row.get(1)?,
                    account_id: row.get(2)?,
                    sender_id: row.get(3)?,
                    sender_name: row.get(4)?,
                    chat_id: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                    created: false,
                })
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| openclaw_core::Error::state(error.to_string()))?);
        }
        Ok(out)
    }

    /// Insert a pairing row with an explicit timestamp. Test-only helper for
    /// expiry rules, which cannot be exercised without controlling the clock.
    #[doc(hidden)]
    pub fn insert_pairing_for_test(
        &self,
        channel: &str,
        account_id: &str,
        sender_id: &str,
        code: &str,
        created_at: &str,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        conn.execute(
            "INSERT INTO pairings (code, channel, account_id, sender_id, sender_name, chat_id, status, created_at)
             VALUES (?1, ?2, ?3, ?4, 'Test', 'chat', 'pending', ?5)",
            rusqlite::params![code, channel, account_id, sender_id, created_at],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }

    /// Clear conversation history for a session (`/reset` or `/new`).
    pub fn clear_session_history(&self, session: &SessionId) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            rusqlite::params![session.as_str()],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        conn.execute(
            "DELETE FROM replies WHERE session_id = ?1",
            rusqlite::params![session.as_str()],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }

    /// Load recent conversation turns (both user messages and assistant replies) in chronological order.
    pub fn load_conversation_turns(
        &self,
        session: &SessionId,
        limit: usize,
    ) -> Result<Vec<(String, String, String)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT role, text, timestamp FROM (
                    SELECT 'user' AS role, content AS text, timestamp FROM messages WHERE session_id = ?1
                    UNION ALL
                    SELECT 'assistant' AS role, payload AS text, timestamp FROM replies WHERE session_id = ?1
                 ) ORDER BY timestamp DESC LIMIT ?2",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![session.as_str(), limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;

        let mut turns = Vec::new();
        for r in rows {
            let (role, raw_json, ts) =
                r.map_err(|error| openclaw_core::Error::state(error.to_string()))?;
            let text = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw_json) {
                v.get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or(&raw_json)
                    .to_owned()
            } else {
                raw_json
            };
            turns.push((role, text, ts));
        }
        turns.reverse();
        Ok(turns)
    }
}

#[async_trait]
impl StateStore for SqliteStateStore {    async fn save_inbound(&self, message: &InboundMessage) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let content = serde_json::to_string(&message.content)
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, channel, session_id, author, content, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                message.id.as_str(),
                message.channel.as_str(),
                message.session.as_str(),
                message.author.as_str(),
                content,
                message.timestamp.to_rfc3339(),
            ],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }

    async fn load_history(&self, session: &SessionId, limit: usize) -> Result<Vec<InboundMessage>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, channel, session_id, author, content, timestamp
                 FROM messages WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;

        let rows = stmt
            .query_map(rusqlite::params![session.as_str(), limit as i64], |row| {
                let content_str: String = row.get(4)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    content_str,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;

        let mut messages = Vec::new();
        for row in rows {
            let (id, channel, session_id, author, content, timestamp) =
                row.map_err(|error| openclaw_core::Error::state(error.to_string()))?;
            let content: openclaw_core::message::MessageContent = serde_json::from_str(&content)
                .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&timestamp)
                .map(|parsed| parsed.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now());

            messages.push(InboundMessage {
                id: openclaw_core::id::MessageId::from_raw(id),
                channel: openclaw_core::id::ChannelId::from_raw(channel),
                session: SessionId::from_raw(session_id),
                author: openclaw_core::id::UserId::from_raw(author),
                content,
                timestamp,
                raw: None,
                mentions_assistant: false,
                reply_to: None,
            });
        }

        messages.reverse();
        Ok(messages)
    }

    async fn save_reply(&self, session: &SessionId, reply: &ReplyPayload) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let payload = serde_json::to_string(reply)
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        conn.execute(
            "INSERT INTO replies (session_id, payload, timestamp) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                session.as_str(),
                payload,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openclaw_core::message::MessageContent;

    #[tokio::test]
    async fn save_and_load_history() {
        let store = SqliteStateStore::in_memory().unwrap();
        let session = SessionId::new();

        for i in 0..3 {
            let message = InboundMessage {
                id: openclaw_core::id::MessageId::from_raw(format!("m{i}")),
                channel: openclaw_core::id::ChannelId::from_raw("c1"),
                session: session.clone(),
                author: openclaw_core::id::UserId::from_raw("u1"),
                content: MessageContent::Text {
                    text: format!("hello {i}"),
                },
                timestamp: chrono::Utc::now(),
                raw: None,
                mentions_assistant: false,
                reply_to: None,
            };
            store.save_inbound(&message).await.unwrap();
        }

        let history = store.load_history(&session, 10).await.unwrap();
        assert_eq!(history.len(), 3);
    }

    #[tokio::test]
    async fn pairing_workflow_approves_sender() {
        let store = SqliteStateStore::in_memory().unwrap();
        assert!(!store.is_sender_approved("telegram", "tg_123").unwrap());
        let req = store
            .get_or_create_pairing("telegram", "tg_123", "Vito", "123")
            .unwrap();
        assert_eq!(req.status, "pending");
        assert_eq!(req.code.chars().count(), 8);
        assert!(req.created);
        let approved = store
            .approve_pairing("telegram", &req.code)
            .unwrap()
            .unwrap();
        assert_eq!(approved.status, "approved");
        assert!(store.is_sender_approved("telegram", "tg_123").unwrap());
    }
}
