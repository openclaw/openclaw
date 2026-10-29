use openclaw_config::GatewayAuth;
use openclaw_dashboard::DashboardServer;
use openclaw_gateway::SessionRegistry;
use openclaw_llm::ProviderRegistry;
use openclaw_skills::SkillRegistry;
use openclaw_state::SqliteStateStore;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn spawn(auth: GatewayAuth) -> String {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let registry = Arc::new(SessionRegistry::new());
    let state = Arc::new(SqliteStateStore::in_memory().unwrap());
    let providers = Arc::new(ProviderRegistry::new());
    let skills = Arc::new(SkillRegistry::discover_default());
    tokio::spawn(async move {
        DashboardServer::new(
            addr.to_string(),
            registry,
            state,
            providers,
            skills,
            vec!["telegram".to_owned()],
        )
        .with_auth(auth)
        .run()
        .await
        .unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    format!("http://{addr}")
}

async fn request(base: &str, raw: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
        .await
        .unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    let mut out = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.read_to_string(&mut out),
    )
    .await
    .expect("Control UI must answer within the test deadline")
    .unwrap();
    out
}

fn http(method: &str, path: &str, body: &str, headers: &[(&str, &str)]) -> String {
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    request
}

#[tokio::test]
async fn sensitive_endpoints_require_the_configured_credential() {
    let base = spawn(GatewayAuth::Token("synthetic-dashboard-token".to_owned())).await;
    for (method, path, body) in [
        ("GET", "/api/memories", ""),
        ("GET", "/api/pairings", ""),
        ("GET", "/api/sessions/history?id=web_main", ""),
        ("POST", "/api/sessions/reset", r#"{"sessionId":"web_main"}"#),
        (
            "POST",
            "/api/pairings/approve",
            r#"{"channel":"telegram","code":"AAAAAA"}"#,
        ),
        (
            "POST",
            "/api/chat",
            r#"{"sessionId":"web_main","message":"hello"}"#,
        ),
    ] {
        let response = request(&base, &http(method, path, body, &[])).await;
        assert!(
            response.starts_with("HTTP/1.1 401"),
            "{method} {path} answered without a credential: {}",
            response.lines().next().unwrap_or_default()
        );
    }
    let allowed = request(
        &base,
        &http(
            "GET",
            "/api/memories",
            "",
            &[("Authorization", "Bearer synthetic-dashboard-token")],
        ),
    )
    .await;
    assert!(allowed.starts_with("HTTP/1.1 200"), "{allowed}");
    let wrong = request(
        &base,
        &http("GET", "/api/memories", "", &[("Authorization", "Bearer wrong")]),
    )
    .await;
    assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");
}

#[tokio::test]
async fn body_is_read_by_content_length_and_split_requests_are_rejected() {
    let base = spawn(GatewayAuth::None).await;
    let pipelined = format!(
        "{}{}",
        http("GET", "/healthz", "", &[]),
        http("GET", "/api/memories", "", &[])
    );
    let response = request(&base, &pipelined).await;
    assert_eq!(
        response.matches("HTTP/1.1").count(),
        1,
        "pipelining leaked: {response}"
    );
    assert!(response.contains(r#"{"status":"ok""#), "{response}");

    let mut stream = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
        .await
        .unwrap();
    let split_body = br#"{"session_id":"x","message":"split body"}"#;
    let head = format!(
        "POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
        split_body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    stream.write_all(split_body).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    assert!(out.contains("split body"), "body split across segments lost: {out}");

    let huge = http("POST", "/api/chat", "x", &[("Content-Length", "999999999")]);
    let response = request(&base, &huge).await;
    assert!(
        response.starts_with("HTTP/1.1 413") || response.starts_with("HTTP/1.1 400"),
        "oversized body accepted: {}",
        response.lines().next().unwrap_or_default()
    );
}

#[tokio::test]
async fn responses_are_not_interpreted_as_html() {
    let base = spawn(GatewayAuth::None).await;
    let response = request(&base, &http("GET", "/api/skills", "", &[])).await;
    assert!(response.contains("Content-Type: application/json"), "{response}");
    assert!(response.contains("X-Content-Type-Options: nosniff"), "{response}");
}

#[tokio::test]
async fn ui_shell_is_public_but_data_is_not() {
    let base = spawn(GatewayAuth::Token("synthetic-dashboard-token".to_owned())).await;
    let shell = request(&base, &http("GET", "/", "", &[])).await;
    assert!(shell.starts_with("HTTP/1.1 200"), "UI shell must load to accept a token: {shell}");
    assert!(shell.contains("OpenClaw Control UI"), "{shell}");
    assert!(!shell.contains("synthetic-dashboard-token"), "shell leaked a credential");
    let data = request(&base, &http("GET", "/api/status", "", &[])).await;
    assert!(data.starts_with("HTTP/1.1 401"), "{data}");
}

#[tokio::test]
async fn chat_creates_exactly_one_session_record() {
    let base = spawn(GatewayAuth::None).await;
    let body = r#"{"session_id":"synthetic_ses","message":"hello"}"#;
    let response = request(&base, &http("POST", "/api/chat", body, &[])).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    let listed = request(&base, &http("GET", "/api/sessions", "", &[])).await;
    let json = listed.split("\r\n\r\n").nth(1).unwrap_or_default();
    let sessions: serde_json::Value = serde_json::from_str(json).unwrap();
    let sessions = sessions.as_array().unwrap();
    assert_eq!(
        sessions.len(),
        1,
        "a single turn must not leave an orphaned random-id session: {json}"
    );
    assert_eq!(sessions[0]["id"], "synthetic_ses");
}
