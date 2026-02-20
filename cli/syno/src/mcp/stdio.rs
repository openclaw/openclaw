//! MCP stdio mode entry point.

use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::api::{auth, client::SynoClient};

use super::dispatch::{handle_jsonrpc_stdio, JsonRpcRequest, JsonRpcResponse};
use super::session::*;

pub async fn run_stdio(host: &str, port: u16, https: bool, username: &str, password: &str) -> anyhow::Result<()> {
    let scheme = if https { "https" } else { "http" };
    let base_url = format!("{scheme}://{host}:{port}");
    let client = SynoClient::new(&base_url, https)?;
    let data = auth::login(&client, username, password, None).await?;
    let sid = data.sid;
    let synotoken = data.synotoken;

    let state = Arc::new(AppState::new());

    let nas_session_id = "__stdio__".to_string();
    state.nas_sessions.lock().await.insert(
        nas_session_id.clone(),
        NasSession {
            client,
            sid,
            synotoken,
            created: Instant::now(),
        },
    );

    eprintln!("Synology MCP stdio mode ready");

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err = JsonRpcResponse::error(Value::Null, -32700, &format!("Parse error: {e}"));
                let out = serde_json::to_string(&err)? + "\n";
                stdout.write_all(out.as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };

        let response = handle_jsonrpc_stdio(&state, req, &nas_session_id).await;
        let out = serde_json::to_string(&response)? + "\n";
        stdout.write_all(out.as_bytes()).await?;
        stdout.flush().await?;
    }

    Ok(())
}
