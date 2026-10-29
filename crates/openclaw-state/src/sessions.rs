//! Durable session rows, so `sessions.list` survives a Gateway restart.
//!
//! Mirrors the official ownership rule (`docs/gateway/AGENTS.md`): the Gateway is
//! the single writer of its session state, and restart hydration reads what it
//! committed. Stored as a dedicated table rather than reusing transcript rows.

use openclaw_core::error::Result;
use openclaw_core::id::{AgentId, ChannelId, SessionId, UserId};
use openclaw_core::session::{Session, SessionKind, SessionState};
use rusqlite::Connection;

impl crate::SqliteStateStore {
    /// Persist (insert or replace) one session row.
    pub fn upsert_session(&self, session: &Session) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        conn.execute(
            "INSERT INTO sessions (id, kind, state, channel, agent, participants, created_at, updated_at, turn_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 kind = excluded.kind,
                 state = excluded.state,
                 channel = excluded.channel,
                 agent = excluded.agent,
                 participants = excluded.participants,
                 updated_at = excluded.updated_at,
                 turn_count = excluded.turn_count",
            rusqlite::params![
                session.id.as_str(),
                kind_str(session.kind),
                state_str(session.state),
                session.channel.as_str(),
                session.agent.as_str(),
                session.participants.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(","),
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
                session.turn_count,
            ],
        )
        .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        Ok(())
    }

    /// Load every persisted session for startup hydration.
    pub fn load_sessions(&self) -> Result<Vec<Session>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| openclaw_core::Error::state("lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, state, channel, agent, participants, created_at, updated_at, turn_count
                 FROM sessions ORDER BY updated_at DESC",
            )
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let participants: String = row.get(5)?;
                let created: String = row.get(6)?;
                let updated: String = row.get(7)?;
                Ok(Session {
                    id: SessionId::from_raw(row.get::<_, String>(0)?),
                    kind: kind_from_str(&row.get::<_, String>(1)?),
                    state: state_from_str(&row.get::<_, String>(2)?),
                    channel: ChannelId::from_raw(row.get::<_, String>(3)?),
                    agent: AgentId::from_raw(row.get::<_, String>(4)?),
                    participants: participants
                        .split(',')
                        .filter(|value| !value.is_empty())
                        .map(|value| UserId::from_raw(value.to_owned()))
                        .collect(),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    turn_count: row.get::<_, i64>(8)? as u64,
                })
            })
            .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| openclaw_core::Error::state(error.to_string()))?);
        }
        Ok(out)
    }
}

fn kind_str(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Direct => "direct",
        SessionKind::Group => "group",
        SessionKind::Channel => "channel",
        SessionKind::System => "system",
    }
}

fn kind_from_str(value: &str) -> SessionKind {
    match value {
        "group" => SessionKind::Group,
        "channel" => SessionKind::Channel,
        "system" => SessionKind::System,
        _ => SessionKind::Direct,
    }
}

fn state_str(state: SessionState) -> &'static str {
    match state {
        SessionState::Active => "active",
        SessionState::Idle => "idle",
        SessionState::Paused => "paused",
        SessionState::Ended => "ended",
    }
}

fn state_from_str(value: &str) -> SessionState {
    match value {
        "idle" => SessionState::Idle,
        "paused" => SessionState::Paused,
        "ended" => SessionState::Ended,
        _ => SessionState::Active,
    }
}

/// Ensure the sessions table exists. Called from the store migration.
pub(crate) fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL,
             state TEXT NOT NULL,
             channel TEXT NOT NULL,
             agent TEXT NOT NULL,
             participants TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             turn_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);",
    )
    .map_err(|error| openclaw_core::Error::state(error.to_string()))?;
    Ok(())
}
