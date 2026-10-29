use dashmap::DashMap;
use openclaw_core::id::{ChannelId, SessionId, UserId};
use openclaw_core::session::{Session, SessionKind, SessionState};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Tracks active sessions and connection count.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: DashMap<SessionId, Session>,
    connections: AtomicUsize,
}

impl SessionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Current number of open client connections.
    pub fn connection_count(&self) -> usize {
        self.connections.load(Ordering::Acquire)
    }

    /// Increment the connection counter. Returns the new count.
    pub fn add_connection(&self) -> usize {
        self.connections.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Decrement the connection counter.
    pub fn remove_connection(&self) {
        self.connections.fetch_sub(1, Ordering::AcqRel);
    }

    /// Insert or update a session.
    pub fn upsert(&self, session: Session) {
        self.sessions.insert(session.id.clone(), session);
    }

    /// Look up a session by id.
    #[must_use]
    pub fn get(&self, id: &SessionId) -> Option<Session> {
        self.sessions.get(id).map(|entry| entry.value().clone())
    }

    /// Remove a session.
    pub fn remove(&self, id: &SessionId) -> Option<Session> {
        self.sessions.remove(id).map(|(_, session)| session)
    }

    /// List all sessions.
    #[must_use]
    pub fn list(&self) -> Vec<Session> {
        self.sessions.iter().map(|entry| entry.value().clone()).collect()
    }

    /// Create a new session.
    #[must_use]
    pub fn create(
        &self,
        kind: SessionKind,
        channel: ChannelId,
        agent: openclaw_core::id::AgentId,
        participants: Vec<UserId>,
    ) -> Session {
        self.create_with_id(SessionId::new(), kind, channel, agent, participants)
    }

    /// Create a session under a caller-chosen id (idempotent for existing ids).
    ///
    /// Used by transports that own their session key (WebChat, channels) so a
    /// single turn never leaves an orphaned random-id entry behind.
    pub fn create_with_id(
        &self,
        id: SessionId,
        kind: SessionKind,
        channel: ChannelId,
        agent: openclaw_core::id::AgentId,
        participants: Vec<UserId>,
    ) -> Session {
        let now = chrono::Utc::now();
        let session = Session {
            id,
            kind,
            state: SessionState::Active,
            channel,
            agent,
            participants,
            created_at: now,
            updated_at: now,
            turn_count: 0,
        };
        self.upsert(session.clone());
        session
    }

    /// End a session, marking it as ended.
    pub fn end(&self, id: &SessionId) -> Option<Session> {
        let mut session = self.get(id)?;
        session.state = SessionState::Ended;
        session.updated_at = chrono::Utc::now();
        self.upsert(session.clone());
        Some(session)
    }

    /// Snapshot every resident session for durable storage.
    #[must_use]
    pub fn export_rows(&self) -> Vec<Session> {
        self.list()
    }

    /// Hydrate the registry from durable rows (startup recovery).
    ///
    /// Returns how many rows were imported. Import is idempotent: an existing
    /// session with the same id is replaced, never duplicated.
    pub fn import_rows(&self, rows: Vec<Session>) -> usize {
        let mut count = 0;
        for session in rows {
            self.upsert(session);
            count += 1;
        }
        count
    }
}
