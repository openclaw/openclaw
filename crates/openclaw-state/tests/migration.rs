//! Schema migration: an older `pairings` table must keep working.
//!
//! `CREATE TABLE IF NOT EXISTS` does not add columns, so a database created before
//! account scoping failed every pairing query with
//! `no such column: account_id`. This reproduces that exact state and proves the
//! upgrade path keeps existing rows usable as the `default` account.

use openclaw_state::SqliteStateStore;
use rusqlite::Connection;

#[test]
fn legacy_pairings_table_is_upgraded_in_place() {
    let dir = std::env::temp_dir().join(format!("openclaw-migrate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("openclaw.db");

    // Create the pre-account-scoping schema and one pending row.
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE pairings (
                 code TEXT PRIMARY KEY,
                 channel TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 sender_name TEXT NOT NULL,
                 chat_id TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending',
                 created_at TEXT NOT NULL
             );
             INSERT INTO pairings (code, channel, sender_id, sender_name, chat_id, status, created_at)
             VALUES ('LEGACY23', 'telegram', 'sender', 'Name', 'chat', 'pending',
                     strftime('%Y-%m-%dT%H:%M:%S+00:00','now'));",
        )
        .unwrap();
    }

    // Opening through the store must migrate, not fail.
    let store = SqliteStateStore::open(&path).unwrap();
    let listed = store.list_pairings().unwrap();
    assert_eq!(listed.len(), 1, "legacy pending row was lost");
    assert_eq!(listed[0].code, "LEGACY23");
    assert_eq!(
        listed[0].account_id, "default",
        "legacy rows must become the documented default account"
    );

    // And the legacy row is still approvable through the default account.
    let approved = store.approve_pairing("telegram", "LEGACY23").unwrap();
    assert!(approved.is_some(), "legacy row could not be approved after upgrade");
    assert!(store.is_sender_approved("telegram", "sender").unwrap());

    // Re-opening must be idempotent.
    drop(store);
    let reopened = SqliteStateStore::open(&path).unwrap();
    assert!(reopened.is_sender_approved("telegram", "sender").unwrap());
    drop(reopened);

    std::fs::remove_dir_all(&dir).unwrap();
}
