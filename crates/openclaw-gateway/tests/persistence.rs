//! Sessions must survive a Gateway restart.
//!
//! Official reference: `docs/gateway/AGENTS.md` — the Gateway owns its files and
//! serves sessions from the durable store; `sessions.list` after a restart still
//! returns prior sessions. The Rust registry was an in-memory `DashMap` built
//! fresh in `Gateway::new`, so every restart emptied the roster.

use openclaw_core::id::{AgentId, ChannelId, UserId};
use openclaw_core::session::SessionKind;
use openclaw_gateway::SessionRegistry;

#[test]
fn sessions_can_be_restored_from_persisted_rows() {
    let registry = SessionRegistry::new();
    let created = registry.create(
        SessionKind::Direct,
        ChannelId::from_raw("webchat"),
        AgentId::from_raw("default"),
        vec![UserId::from_raw("operator")],
    );

    // A restart is modelled as a fresh registry hydrated from storage.
    let snapshot = registry.export_rows();
    assert_eq!(snapshot.len(), 1, "one session should be exported");

    let restarted = SessionRegistry::new();
    let restored = restarted.import_rows(snapshot);
    assert_eq!(restored, 1, "import must report the row count");
    assert_eq!(
        restarted.list().len(),
        1,
        "sessions.list must survive a restart"
    );
    assert_eq!(
        restarted.get(&created.id).map(|s| s.id),
        Some(created.id.clone()),
        "restored session must keep its id"
    );
}

#[test]
fn import_is_idempotent() {
    let registry = SessionRegistry::new();
    registry.create(
        SessionKind::Direct,
        ChannelId::from_raw("webchat"),
        AgentId::from_raw("default"),
        vec![],
    );
    let rows = registry.export_rows();

    let restarted = SessionRegistry::new();
    assert_eq!(restarted.import_rows(rows.clone()), 1);
    assert_eq!(
        restarted.import_rows(rows),
        1,
        "re-importing the same rows must not duplicate them"
    );
    assert_eq!(restarted.list().len(), 1);
}
