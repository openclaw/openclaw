//! Pairing API must not leak the approval secret or ignore account scope.
//!
//! Official reference: `docs/channels/pairing.md` — the Control UI works with an
//! opaque request id, never the code, and every request/approval is keyed by
//! channel *and* account. The Rust `/api/pairings` returned the raw code and had
//! no dismiss endpoint.

use openclaw_config::GatewayAuth;
use openclaw_dashboard::DashboardServer;
use openclaw_gateway::SessionRegistry;
use openclaw_llm::ProviderRegistry;
use openclaw_skills::SkillRegistry;
use openclaw_state::SqliteStateStore;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn spawn_with_state() -> (String, Arc<SqliteStateStore>) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let state = Arc::new(SqliteStateStore::in_memory().unwrap());
    let registry = Arc::new(SessionRegistry::new());
    let providers = Arc::new(ProviderRegistry::new());
    let skills = Arc::new(SkillRegistry::discover_default());
    let server_state = Arc::clone(&state);
    tokio::spawn(async move {
        DashboardServer::new(
            addr.to_string(),
            registry,
            server_state,
            providers,
            skills,
            vec!["telegram".to_owned()],
        )
        .with_auth(GatewayAuth::None)
        .run()
        .await
        .unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (format!("http://{addr}"), state)
}

async fn request(base: &str, method: &str, path: &str, body: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
        .await
        .unwrap();
    let raw = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(raw.as_bytes()).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    out
}

fn body_of(response: &str) -> &str {
    response.split("\r\n\r\n").nth(1).unwrap_or_default()
}

#[tokio::test]
async fn listing_never_returns_the_pairing_code() {
    let (base, state) = spawn_with_state().await;
    let created = state
        .get_or_create_pairing_in("telegram", "work", "sender-1", "Name", "chat")
        .unwrap();

    let response = request(&base, "GET", "/api/pairings", "").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let body = body_of(&response);
    assert!(
        !body.contains(&created.code),
        "the approval secret was serialized to the UI:\n{body}"
    );
    assert!(body.contains("sender-1"), "sender facts must remain:\n{body}");
    assert!(body.contains("work"), "account must be reported:\n{body}");
    assert!(body.contains("\"id\""), "an opaque id is required:\n{body}");
}

#[tokio::test]
async fn approve_is_scoped_to_the_requested_account() {
    let (base, state) = spawn_with_state().await;
    let created = state
        .get_or_create_pairing_in("telegram", "work", "sender-1", "Name", "chat")
        .unwrap();

    let wrong = request(
        &base,
        "POST",
        "/api/pairings/approve",
        &serde_json::json!({"channel":"telegram","code":created.code,"accountId":"personal"}).to_string(),
    )
    .await;
    assert!(wrong.starts_with("HTTP/1.1 404"), "cross-account approve succeeded:\n{wrong}");
    assert!(!state
        .is_sender_approved_in("telegram", "personal", "sender-1")
        .unwrap());

    let right = request(
        &base,
        "POST",
        "/api/pairings/approve",
        &serde_json::json!({"channel":"telegram","code":created.code,"accountId":"work"}).to_string(),
    )
    .await;
    assert!(right.starts_with("HTTP/1.1 200"), "{right}");
    assert!(state
        .is_sender_approved_in("telegram", "work", "sender-1")
        .unwrap());
}

#[tokio::test]
async fn dismiss_removes_a_pending_request_without_blocking() {
    let (base, state) = spawn_with_state().await;
    let created = state
        .get_or_create_pairing_in("telegram", "work", "sender-1", "Name", "chat")
        .unwrap();

    let response = request(
        &base,
        "POST",
        "/api/pairings/dismiss",
        &serde_json::json!({"channel":"telegram","code":created.code,"accountId":"work"}).to_string(),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(state.pending_pairing_count("telegram", "work").unwrap(), 0);
    assert!(!state
        .is_sender_approved_in("telegram", "work", "sender-1")
        .unwrap());
    // Not a block: the sender may request again.
    assert!(state
        .get_or_create_pairing_in("telegram", "work", "sender-1", "Name", "chat")
        .unwrap()
        .created);
}

#[tokio::test]
async fn expired_code_is_not_approved() {
    let (base, state) = spawn_with_state().await;
    state
        .insert_pairing_for_test(
            "telegram",
            "work",
            "old",
            "OLDCODE2",
            "2000-01-01T00:00:00+00:00",
        )
        .unwrap();
    let response = request(
        &base,
        "POST",
        "/api/pairings/approve",
        &serde_json::json!({"channel":"telegram","code":"OLDCODE2","accountId":"work"}).to_string(),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 404"), "expired code approved:\n{response}");
}
