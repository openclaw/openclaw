use crate::ui::DASHBOARD_HTML;
use openclaw_config::GatewayAuth;
use openclaw_core::id::{AgentId, ChannelId, MessageId, SessionId, UserId};
use openclaw_core::message::{InboundMessage, MessageContent};
use openclaw_core::session::SessionKind;
use openclaw_core::traits::{CompletionMessage, CompletionRequest, CompletionRole, StateStore};
use openclaw_gateway::SessionRegistry;
use openclaw_llm::ProviderRegistry;
use openclaw_skills::SkillRegistry;
use openclaw_state::SqliteStateStore;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{info, warn};

/// Largest request body the Control UI accepts (25 MiB, matching the Gateway frame limit).
const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

/// A parsed HTTP request line plus headers.
#[derive(Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpRequest {
    /// Parse one request from a buffer. Returns the request and how many bytes
    /// it consumed; `Ok(None)` means more bytes are needed.
    pub fn parse(buf: &[u8]) -> Result<Option<(Self, usize)>, &'static str> {
        let header_end = match buf.windows(4).position(|window| window == b"\r\n\r\n") {
            Some(index) => index,
            None => return Ok(None),
        };
        let head = std::str::from_utf8(&buf[..header_end]).map_err(|_| "invalid utf-8")?;
        let mut lines = head.split("\r\n");
        let first = lines.next().ok_or("empty request")?;
        let mut parts = first.split_whitespace();
        let method = parts.next().ok_or("missing method")?.to_ascii_uppercase();
        let target = parts.next().ok_or("missing target")?;
        if !matches!(parts.next(), None | Some("HTTP/1.0") | Some("HTTP/1.1")) {
            return Err("unsupported http version");
        }
        // RFC 7230: absolute-form targets carry their own origin.
        let target = target
            .strip_prefix("http://")
            .or_else(|| target.strip_prefix("https://"))
            .map_or(target, |rest| {
                rest.split_once('/').map_or("/", |(_, path)| path)
            });
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect::<Vec<_>>();

        let content_length: usize = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        if content_length > MAX_BODY_BYTES {
            return Err("payload too large");
        }
        let total = header_end + 4 + content_length;
        if buf.len() < total {
            return Ok(None);
        }
        let body = std::str::from_utf8(&buf[header_end + 4..total]).map_err(|_| "invalid utf-8")?;
        Ok(Some((
            Self {
                method,
                path: path.to_owned(),
                query: query.to_owned(),
                headers,
                body: body.to_owned(),
            },
            total,
        )))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Credential presented by this request, if any.
    fn bearer(&self) -> Option<&str> {
        self.header("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
    }
}

/// Control UI & HTTP API server (WebChat, Skills, Memories, Pairing Approval, Sessions, `/v1/chat/completions`, `/healthz`).
pub struct DashboardServer {
    listen: SocketAddr,
    registry: Arc<SessionRegistry>,
    state: Arc<SqliteStateStore>,
    providers: Arc<ProviderRegistry>,
    skills: Arc<SkillRegistry>,
    channels: Vec<String>,
    auth: GatewayAuth,
}

#[derive(Deserialize)]
struct WebChatRequest {
    session_id: Option<String>,
    message: String,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovePairingBody {
    channel: String,
    code: String,
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DismissPairingBody {
    channel: String,
    code: String,
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct ResetSessionBody {
    session_id: String,
}

impl DashboardServer {
    /// Create a new Control UI server.
    #[must_use]
    pub fn new(
        listen: impl Into<String>,
        registry: Arc<SessionRegistry>,
        state: Arc<SqliteStateStore>,
        providers: Arc<ProviderRegistry>,
        skills: Arc<SkillRegistry>,
        channels: Vec<String>,
    ) -> Self {
        let listen = listen
            .into()
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:18790".parse().unwrap());
        Self {
            listen,
            registry,
            state,
            providers,
            skills,
            channels,
            auth: GatewayAuth::None,
        }
    }

    /// Credential the Control UI enforces, shared with the Gateway policy.
    #[must_use]
    pub fn with_auth(mut self, auth: GatewayAuth) -> Self {
        self.auth = auth;
        self
    }

    /// Run the Control UI server until shutdown.
    pub async fn run(self) -> std::io::Result<()> {
        let listener = TcpListener::bind(self.listen).await?;
        info!(listen = %self.listen, "control-ui listening");
        let channels = Arc::new(self.channels);

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    warn!(%error, "control-ui accept failed");
                    continue;
                }
            };
            let registry = Arc::clone(&self.registry);
            let state = Arc::clone(&self.state);
            let providers = Arc::clone(&self.providers);
            let skills = Arc::clone(&self.skills);
            let channels = Arc::clone(&channels);
            let auth = self.auth.clone();
            tokio::spawn(async move {
                if let Err(error) = handle_request(
                    stream, &registry, &state, &providers, &skills, &channels, &auth,
                )
                .await
                {
                    warn!(%peer, %error, "control-ui request failed");
                }
            });
        }
    }
}

/// FNV-1a. Used only to derive a non-reversible UI handle from a pairing code;
/// this is not a security primitive and the code never leaves the server.
fn simple_hash(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// Serialize the canonical channel catalog for the Control UI.
fn openclaw_channels_catalog() -> Vec<serde_json::Value> {
    openclaw_channels::CHANNEL_CATALOG
        .iter()
        .map(|spec| {
            serde_json::json!({
                "id": spec.id,
                "label": spec.label,
                "support": match spec.support {
                    openclaw_channels::ChannelSupport::Native => "native",
                    openclaw_channels::ChannelSupport::Webhook => "webhook",
                    openclaw_channels::ChannelSupport::PluginOnly => "plugin",
                },
            })
        })
        .collect()
}

async fn handle_request(
    mut stream: TcpStream,
    registry: &SessionRegistry,
    state: &SqliteStateStore,
    providers: &ProviderRegistry,
    skills: &SkillRegistry,
    channels: &[String],
    auth: &GatewayAuth,
) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let request = loop {
        if let Some((request, consumed)) = match HttpRequest::parse(&buf) {
            Ok(parsed) => parsed,
            Err(reason) => {
                let status = if reason == "payload too large" { "413" } else { "400" };
                return respond(&mut stream, status, "application/json", r#"{"error":"bad request"}"#).await;
            }
        } {
            buf.drain(..consumed);
            break request;
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..read]);
        if buf.len() > MAX_BODY_BYTES + 8192 {
            return respond(&mut stream, "413", "application/json", r#"{"error":"payload too large"}"#).await;
        }
    };

    let method = request.method.as_str();
    let path = request.path.as_str();
    let query = request.query.as_str();
    let body_part = request.body.as_str();

    // Authentication is checked at the boundary, before any state is read or
    // mutated. Unauthenticated callers may reach health probes and the static
    // UI shell (which contains no data); every API path requires the credential.
    let public = matches!(
        path,
        "/healthz" | "/readyz" | "/" | "/index.html" | "/dashboard"
    ) || method == "OPTIONS";
    if !public && !auth.permits(request.bearer()) {
        return respond(
            &mut stream,
            "401",
            "application/json",
            r#"{"error":"authentication required"}"#,
        )
        .await;
    }

    let (status, content_type, body) = match (method, path) {
        ("OPTIONS", _) => ("204 No Content", "text/plain", String::new()),
        ("GET", "/") | ("GET", "/index.html") | ("GET", "/dashboard") => (
            "200 OK",
            "text/html; charset=utf-8",
            DASHBOARD_HTML.to_owned(),
        ),
        ("GET", "/healthz") | ("GET", "/readyz") => (
            "200 OK",
            "application/json",
            r#"{"status":"ok","ready":true}"#.to_owned(),
        ),
        ("GET", "/api/status") => {
            let status = serde_json::json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "connections": registry.connection_count(),
                "sessions": registry.list().len(),
                "skills": skills.len(),
                "methods": openclaw_protocol::core_methods::CORE_METHODS.len(),
                "channelsCatalog": openclaw_channels::CHANNEL_CATALOG.len(),
                "providers": providers.list(),
                "channels": channels,
            });
            ("200 OK", "application/json", status.to_string())
        }
        ("GET", "/api/skills") => {
            let list: Vec<serde_json::Value> = skills
                .list()
                .into_iter()
                .map(|s| {
                    serde_json::json!({
                        "name": s.name,
                        "description": s.description,
                        "emoji": s.emoji,
                        "source": s.source,
                        "homepage": s.homepage,
                    })
                })
                .collect();
            (
                "200 OK",
                "application/json",
                serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_owned()),
            )
        }
        ("GET", "/api/memories") => {
            let mems = state.list_memories().unwrap_or_default();
            (
                "200 OK",
                "application/json",
                serde_json::to_string(&mems).unwrap_or_else(|_| "[]".to_owned()),
            )
        }
        ("GET", "/api/cron") => {
            let jobs = state.list_cron_jobs().unwrap_or_default();
            (
                "200 OK",
                "application/json",
                serde_json::to_string(&jobs).unwrap_or_else(|_| "[]".to_owned()),
            )
        }
        ("GET", "/api/sessions") => {
            let sessions = registry.list();
            let body = serde_json::to_string(&sessions).unwrap_or_else(|_| "[]".to_owned());
            ("200 OK", "application/json", body)
        }
        ("GET", "/api/sessions/history") => {
            let sid = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("id="))
                .unwrap_or("web_main");
            let turns = state
                .load_conversation_turns(&SessionId::from_raw(sid), 50)
                .unwrap_or_default();
            let items: Vec<serde_json::Value> = turns
                .into_iter()
                .map(|(role, text, timestamp)| {
                    serde_json::json!({"role": role, "text": text, "timestamp": timestamp})
                })
                .collect();
            (
                "200 OK",
                "application/json",
                serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_owned()),
            )
        }
        ("POST", "/api/sessions/reset") => {
            if let Ok(req) = serde_json::from_str::<ResetSessionBody>(body_part) {
                let sid = SessionId::from_raw(&req.session_id);
                let _ = state.clear_session_history(&sid);
                registry.remove(&sid);
                ("200 OK", "application/json", r#"{"ok":true}"#.to_owned())
            } else {
                (
                    "400 Bad Request",
                    "application/json",
                    r#"{"error":"invalid body"}"#.to_owned(),
                )
            }
        }
        ("GET", "/api/channels") => {
            let body = serde_json::json!({ "channels": channels }).to_string();
            ("200 OK", "application/json", body)
        }
        ("GET", "/api/channels/catalog") => {
            let list: Vec<serde_json::Value> = openclaw_channels_catalog();
            (
                "200 OK",
                "application/json",
                serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_owned()),
            )
        }
        ("GET", "/api/methods") => {
            let list: Vec<serde_json::Value> = openclaw_protocol::core_methods::CORE_METHODS
                .iter()
                .map(|spec| {
                    serde_json::json!({
                        "name": spec.name,
                        "scope": spec.scope.as_str(),
                    })
                })
                .collect();
            (
                "200 OK",
                "application/json",
                serde_json::json!({
                    "count": list.len(),
                    "methods": list,
                })
                .to_string(),
            )
        }
        ("GET", "/api/pairings") => {
            let pairings = state.list_pairings().unwrap_or_default();
            // The pairing code is the approval secret; the UI approves by code,
            // but listing it to every dashboard reader widens the blast radius.
            // Return the sender facts and a stable id instead.
            let view: Vec<serde_json::Value> = pairings
                .into_iter()
                .map(|p| {
                    // Opaque, stable id derived from the code so the UI can act on a
                    // request without ever receiving the approval secret.
                    let id = format!("{}:{}:{:x}", p.channel, p.account_id, simple_hash(&p.code));
                    serde_json::json!({
                        "id": id,
                        "channel": p.channel,
                        "accountId": p.account_id,
                        "senderId": p.sender_id,
                        "senderName": p.sender_name,
                        "chatId": p.chat_id,
                        "status": p.status,
                        "createdAt": p.created_at,
                    })
                })
                .collect();
            let body = serde_json::to_string(&view).unwrap_or_else(|_| "[]".to_owned());
            ("200 OK", "application/json", body)
        }
        ("POST", "/api/pairings/approve") => {
            match serde_json::from_str::<ApprovePairingBody>(body_part) {
                Ok(req) => {
                    let account = req.account_id.as_deref();
                    match state.approve_pairing_in(&req.channel, account, &req.code) {
                        Ok(Some(approved)) => (
                            "200 OK",
                            "application/json",
                            serde_json::json!({
                                "channel": approved.channel,
                                "accountId": approved.account_id,
                                "senderId": approved.sender_id,
                                "senderName": approved.sender_name,
                                "status": approved.status,
                            })
                            .to_string(),
                        ),
                        Ok(None) => (
                            "404 Not Found",
                            "application/json",
                            r#"{"error":"pairing code not found or expired"}"#.to_owned(),
                        ),
                        Err(e) => (
                            "500 Internal Server Error",
                            "application/json",
                            serde_json::json!({"error": e.to_string()}).to_string(),
                        ),
                    }
                }
                Err(e) => (
                    "400 Bad Request",
                    "application/json",
                    serde_json::json!({"error": e.to_string()}).to_string(),
                ),
            }
        }
        ("POST", "/api/pairings/dismiss") => {
            match serde_json::from_str::<DismissPairingBody>(body_part) {
                Ok(req) => {
                    let account = req.account_id.as_deref().unwrap_or("default");
                    match state.dismiss_pairing(&req.channel, account, &req.code) {
                        Ok(true) => ("200 OK", "application/json", r#"{"ok":true}"#.to_owned()),
                        Ok(false) => (
                            "404 Not Found",
                            "application/json",
                            r#"{"error":"pairing code not found or expired"}"#.to_owned(),
                        ),
                        Err(e) => (
                            "500 Internal Server Error",
                            "application/json",
                            serde_json::json!({"error": e.to_string()}).to_string(),
                        ),
                    }
                }
                Err(e) => (
                    "400 Bad Request",
                    "application/json",
                    serde_json::json!({"error": e.to_string()}).to_string(),
                ),
            }
        }
        ("POST", "/api/chat") | ("POST", "/v1/chat/completions") => {
            let (session_id, user_text, provider_override) =
                if let Ok(chat_req) = serde_json::from_str::<WebChatRequest>(body_part) {
                    (
                        chat_req.session_id.unwrap_or_else(|| "web_main".to_owned()),
                        chat_req.message,
                        chat_req.model,
                    )
                } else if let Ok(oai) = serde_json::from_str::<serde_json::Value>(body_part) {
                    let msg = oai
                        .get("messages")
                        .and_then(|m| m.as_array())
                        .and_then(|arr| arr.last())
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_str())
                        .unwrap_or_default()
                        .to_owned();
                    ("openai_http".to_owned(), msg, None)
                } else {
                    ("web_main".to_owned(), String::new(), None)
                };

            if user_text.trim().is_empty() {
                (
                    "400 Bad Request",
                    "application/json",
                    r#"{"error":"message must not be empty"}"#.to_owned(),
                )
            } else {
                let sid = SessionId::from_raw(&session_id);
                let inbound = InboundMessage {
                    id: MessageId::new(),
                    channel: ChannelId::from_raw("webchat"),
                    session: sid.clone(),
                    author: UserId::from_raw("operator"),
                    content: MessageContent::Text {
                        text: user_text.clone(),
                    },
                    timestamp: chrono::Utc::now(),
                    raw: None,
                    mentions_assistant: true,
                    reply_to: None,
                };
                let _ = state.save_inbound(&inbound).await;

                if registry.get(&sid).is_none() {
                    let created = registry.create_with_id(
                        sid.clone(),
                        SessionKind::Direct,
                        ChannelId::from_raw("webchat"),
                        AgentId::from_raw("default"),
                        vec![UserId::from_raw("operator")],
                    );
                    // Write through so a restart can restore this session.
                    if let Err(error) = state.upsert_session(&created) {
                        warn!(%error, "could not persist session");
                    }
                }
                if let Some(mut s) = registry.get(&sid) {
                    s.turn_count += 1;
                    s.updated_at = chrono::Utc::now();
                    registry.upsert(s.clone());
                    if let Err(error) = state.upsert_session(&s) {
                        warn!(%error, "could not persist session turn");
                    }
                }

                // Built-in direct tool / skill commands in WebChat
                let trimmed = user_text.trim();
                let reply_text = if let Some(loc) = trimmed.strip_prefix("/weather") {
                    let loc = if loc.trim().is_empty() { "Jakarta" } else { loc.trim() };
                    openclaw_skills::fetch_weather(loc)
                        .await
                        .unwrap_or_else(|e| format!("Weather lookup failed: {e}"))
                } else if let Some(fact) = trimmed.strip_prefix("/remember ") {
                    let _ = state.add_memory("note", fact.trim());
                    format!("🧠 Saved to long-term memory: {}", fact.trim())
                } else if trimmed == "/skills" {
                    let names: Vec<String> = skills
                        .list()
                        .into_iter()
                        .map(|s| format!("• {} ({})", s.name, s.source))
                        .collect();
                    format!("🦞 Loaded Skills ({}):\n{}", names.len(), names.join("\n"))
                } else {
                    let history_turns = state.load_conversation_turns(&sid, 20).unwrap_or_default();
                    let mut messages: Vec<CompletionMessage> = history_turns
                        .into_iter()
                        .map(|(role, text, _)| CompletionMessage {
                            role: if role == "assistant" {
                                CompletionRole::Assistant
                            } else {
                                CompletionRole::User
                            },
                            content: text,
                        })
                        .collect();
                    if messages.is_empty() {
                        messages.push(CompletionMessage {
                            role: CompletionRole::User,
                            content: user_text.clone(),
                        });
                    }

                    let chosen_provider = provider_override
                        .as_deref()
                        .and_then(|p| providers.get(p))
                        .or_else(|| providers.list().first().and_then(|p| providers.get(p)));

                    if let Some(provider) = chosen_provider {
                        let mut sys_prompt =
                            String::from("You are OpenClaw, a helpful self-hosted AI assistant.");
                        sys_prompt.push_str(&skills.build_prompt_augmentation(&user_text));
                        if let Ok(mems) = state.list_memories() {
                            if !mems.is_empty() {
                                sys_prompt.push_str("\n<long_term_memories>\n");
                                for m in mems.iter().take(20) {
                                    sys_prompt.push_str(&format!("- {}: {}\n", m.key, m.content));
                                }
                                sys_prompt.push_str("</long_term_memories>\n");
                            }
                        }

                        let req = CompletionRequest {
                            session: sid.clone(),
                            system_prompt: sys_prompt,
                            messages,
                            max_tokens: Some(2048),
                            temperature: None,
                        };
                        match provider.complete(req).await {
                            Ok(reply) => reply.text.unwrap_or_default(),
                            Err(e) => format!("Provider error: {e}"),
                        }
                    } else {
                        format!(
                            "OpenClaw Gateway ({} skills loaded; no LLM provider API key configured yet). Echo: {user_text}",
                            skills.len()
                        )
                    }
                };

                let reply_payload = openclaw_core::message::ReplyPayload {
                    text: Some(reply_text.clone()),
                    ..Default::default()
                };
                let _ = state.save_reply(&sid, &reply_payload).await;

                let res_json = serde_json::json!({
                    "sessionId": session_id,
                    "reply": reply_text,
                    "choices": [{"message": {"role": "assistant", "content": reply_text}}]
                });
                ("200 OK", "application/json", res_json.to_string())
            }
        }
        _ => (
            "404 Not Found",
            "application/json",
            r#"{"error":"not found"}"#.to_owned(),
        ),
    };

    respond(&mut stream, status, content_type, &body).await
}

/// Write one HTTP response and close the connection.
///
/// CORS is same-origin only: a credentialed Control UI must never be readable
/// by a cross-origin page, and `Authorization` is not a wildcard-safe header.
async fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nVary: Origin\r\n\r\n{body}",
        body.len(),
        control_ui_origin()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

/// Origin allowed for credentialed Control UI requests. Defaults to the
/// loopback origin the UI is served from; operators can widen it explicitly.
fn control_ui_origin() -> String {
    std::env::var("OPENCLAW_CONTROL_UI_ORIGIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn dashboard_serves_status_skills_and_webchat() {
        let registry = Arc::new(SessionRegistry::new());
        let state = Arc::new(SqliteStateStore::in_memory().unwrap());
        let providers = Arc::new(ProviderRegistry::new());
        let skills = Arc::new(SkillRegistry::discover_default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reg = Arc::clone(&registry);
        let st = Arc::clone(&state);
        let pr = Arc::clone(&providers);
        let sk = Arc::clone(&skills);
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    let _ = handle_request(
                        stream,
                        &reg,
                        &st,
                        &pr,
                        &sk,
                        &["telegram".to_owned()],
                        &GatewayAuth::None,
                    )
                    .await;
                }
            }
        });

        // 1. Test /api/status
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /api/status HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).await.unwrap();
        assert!(out.contains("200 OK"));
        assert!(out.contains(r#""status":"ok""#));

        // 2. Test /api/skills
        let mut client_sk = TcpStream::connect(addr).await.unwrap();
        client_sk
            .write_all(b"GET /api/skills HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut out_sk = String::new();
        client_sk.read_to_string(&mut out_sk).await.unwrap();
        assert!(out_sk.contains("200 OK"));
        assert!(out_sk.contains("weather"));

        // 3. Test /api/chat (WebChat multi-turn)
        let body = r#"{"session_id":"test_ses","message":"Hello OpenClaw"}"#;
        let req = format!(
            "POST /api/chat HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let mut client2 = TcpStream::connect(addr).await.unwrap();
        client2.write_all(req.as_bytes()).await.unwrap();
        let mut out2 = String::new();
        client2.read_to_string(&mut out2).await.unwrap();
        assert!(out2.contains("200 OK"));
        assert!(out2.contains("Hello OpenClaw"));
    }
}
