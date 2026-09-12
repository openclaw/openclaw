use crate::gateway_ws::{
    AgentsListResult, ChatHistoryPage, ChatSendResult, GatewayClient, GatewayGeneration,
};
use crate::quickchat_widgets::QuickChatWidgetState;
use crate::{tray, DesktopState};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, Webview, WebviewUrl,
    WebviewWindowBuilder, Window,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use uuid::Uuid;

pub const QUICKCHAT_LABEL: &str = "quickchat";
// Alt+Space is GNOME's window-menu grab; a second X11 grab for it always fails.
pub const QUICKCHAT_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";
const QUICKCHAT_SHORTCUT_FILE: &str = "quickchat-shortcut";
const QUICKCHAT_SHORTCUT_DISABLED_MARKER: &str = "quickchat-shortcut-disabled";
const QUICKCHAT_WIDTH: f64 = 640.0;
const QUICKCHAT_HEIGHT: f64 = 92.0;
const QUICKCHAT_EXPANDED_HEIGHT: f64 = 360.0;
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const RECOVERY_MAX_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatAgent {
    id: String,
    name: String,
    emoji: Option<String>,
    avatar_url: Option<String>,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatShortcutStatus {
    supported: bool,
    enabled: bool,
    accelerator: String,
}

#[derive(Clone)]
struct ActiveShortcut {
    accelerator: String,
    shortcut: Shortcut,
    registered: bool,
}

#[derive(Clone)]
struct QuickChatRetryIdentity {
    message: String,
    agent_id: String,
    scope: String,
    main_key: String,
    idempotency_key: String,
    gateway_generation: GatewayGeneration,
    attempt: Uuid,
    terminal: Option<ChatSendResult>,
    session_id: Option<String>,
}

pub(crate) struct QuickChatShortcutPreference {
    pub accelerator: String,
    pub shortcut: Shortcut,
}

#[derive(Clone)]
pub struct QuickChatState {
    selected_agent_id: Arc<Mutex<Option<String>>>,
    active_shortcut: Arc<Mutex<ActiveShortcut>>,
    shortcuts_supported: bool,
    hide_requested: Arc<AtomicBool>,
    retry_identity: Arc<Mutex<Option<QuickChatRetryIdentity>>>,
    widget_state: QuickChatWidgetState,
}

impl QuickChatState {
    pub fn new(shortcuts_supported: bool) -> Self {
        let shortcut = parse_shortcut(QUICKCHAT_SHORTCUT)
            .expect("the built-in Quick Chat shortcut must be valid");
        Self {
            selected_agent_id: Arc::new(Mutex::new(None)),
            active_shortcut: Arc::new(Mutex::new(ActiveShortcut {
                accelerator: QUICKCHAT_SHORTCUT.to_string(),
                shortcut,
                registered: false,
            })),
            shortcuts_supported,
            hide_requested: Arc::new(AtomicBool::new(true)),
            retry_identity: Arc::new(Mutex::new(None)),
            widget_state: QuickChatWidgetState::default(),
        }
    }

    pub(crate) fn widget_state(&self) -> &QuickChatWidgetState {
        &self.widget_state
    }

    fn begin_send(
        &self,
        message: &str,
        agent_id: &str,
        scope: &str,
        main_key: &str,
        gateway_generation: GatewayGeneration,
    ) -> Result<QuickChatRetryIdentity, String> {
        let mut retry = self
            .retry_identity
            .lock()
            .map_err(|_| "Quick Chat retry state is unavailable.".to_string())?;
        if let Some(current) = retry.as_mut() {
            if current.message == message
                && current.gateway_generation == gateway_generation
                && current.agent_id == agent_id
                && current.scope == scope
                && current.main_key == main_key
            {
                current.attempt = Uuid::new_v4();
                return Ok(current.clone());
            }
        }
        let idempotency_key = Uuid::new_v4().to_string();
        *retry = Some(QuickChatRetryIdentity {
            message: message.to_string(),
            agent_id: agent_id.to_string(),
            scope: scope.to_string(),
            main_key: main_key.to_string(),
            idempotency_key: idempotency_key.clone(),
            gateway_generation,
            attempt: Uuid::new_v4(),
            terminal: None,
            session_id: None,
        });
        Ok(retry.as_ref().expect("retry initialized").clone())
    }

    fn clear_send_retry(&self, identity: &QuickChatRetryIdentity) {
        if let Ok(mut retry) = self.retry_identity.lock() {
            if retry
                .as_ref()
                .is_some_and(|current| current.attempt == identity.attempt)
            {
                *retry = None;
            }
        }
    }

    fn update_retry<T>(
        &self,
        identity: &QuickChatRetryIdentity,
        update: impl FnOnce(&mut QuickChatRetryIdentity) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut retry = self
            .retry_identity
            .lock()
            .map_err(|_| "Quick Chat retry state is unavailable.".to_string())?;
        let current = retry
            .as_mut()
            .filter(|current| current.attempt == identity.attempt)
            .ok_or_else(|| "A newer Quick Chat request replaced this retry.".to_string())?;
        update(current)
    }

    async fn send(
        &self,
        gateway: &GatewayClient,
        message: String,
    ) -> Result<ChatSendResult, String> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err("Message cannot be empty.".to_string());
        }
        let generation = gateway.generation();
        let generation = gateway.with_generation(generation, || Ok(generation))?;
        // Once the server confirms completion, every retry is history-only, even if
        // its dedupe entry expires or the agent catalog changes during recovery.
        let terminal_retry = {
            let mut retry = self
                .retry_identity
                .lock()
                .map_err(|_| "Quick Chat retry state is unavailable.".to_string())?;
            retry
                .as_mut()
                .filter(|current| {
                    current.gateway_generation == generation
                        && current.message == message
                        && current.terminal.is_some()
                })
                .map(|current| {
                    current.attempt = Uuid::new_v4();
                    current.clone()
                })
        };
        let (identity, mut result) = if let Some(identity) = terminal_retry {
            let result = identity.terminal.clone().expect("terminal retry");
            (identity, result)
        } else {
            let (agent, catalog) = self.selected_agent(gateway, MissingSelection::Fail).await?;
            let identity = gateway.with_generation(generation, || {
                self.begin_send(
                    &message,
                    &agent.id,
                    &catalog.scope,
                    &catalog.main_key,
                    generation,
                )
            })?;
            let result = gateway
                .chat_send(
                    message,
                    &identity.agent_id,
                    &identity.scope,
                    &identity.main_key,
                    &identity.idempotency_key,
                    identity.gateway_generation,
                )
                .await?;
            gateway.with_generation(generation, || {
                if result.gateway_generation != generation
                    || result.run_id != identity.idempotency_key
                {
                    return Err("Gateway acknowledged a different Quick Chat request.".to_string());
                }
                if result.status == "ok" {
                    self.update_retry(&identity, |current| {
                        current.terminal = Some(result.clone());
                        Ok(())
                    })?;
                }
                Ok(())
            })?;
            (identity, result)
        };
        if result.status == "ok" {
            let deadline = Instant::now() + RECOVERY_TIMEOUT;
            let recovered = tokio::time::timeout(
                RECOVERY_TIMEOUT, self.recover_reply(gateway, &identity, &result, deadline),
            ).await.map_err(|_| "Reply recovery timed out.".to_string())
                .and_then(|result| result)
                .map_err(|error| format!(
                    "The message completed, but its reply could not be recovered. Retry to load the reply without sending again. {error}"
                ))?;
            result.recovered_messages = Some(recovered);
        }
        gateway.with_generation(generation, || {
            self.update_retry(&identity, |_| Ok(()))?;
            self.clear_send_retry(&identity);
            Ok(result)
        })
    }

    async fn recover_reply(
        &self,
        gateway: &GatewayClient,
        identity: &QuickChatRetryIdentity,
        result: &ChatSendResult,
        deadline: Instant,
    ) -> Result<Vec<Value>, String> {
        let mut offset = None;
        let mut messages = Vec::new();
        let mut accepted_bytes = 0;
        let mut snapshot = None;
        for _ in 0..2 {
            let page = gateway
                .chat_history(
                    &result.target,
                    identity.gateway_generation,
                    offset,
                    deadline,
                )
                .await?;
            gateway.with_generation(identity.gateway_generation, || {
                self.update_retry(identity, |current| {
                    if page.session_key != result.target.session_key || page.session_id.is_empty() {
                        return Err(
                            "Gateway history returned a different routing target.".to_string()
                        );
                    }
                    if current
                        .session_id
                        .as_ref()
                        .is_some_and(|id| id != &page.session_id)
                    {
                        return Err(
                            "The physical session changed during reply recovery.".to_string()
                        );
                    }
                    current.session_id = Some(page.session_id.clone());
                    Ok(())
                })
            })?;
            let bytes = serde_json::to_vec(&page.messages)
                .map_err(|_| "Gateway history could not be read.".to_string())?
                .len();
            accepted_bytes += bytes;
            if page.messages.len() > 200 || accepted_bytes > RECOVERY_MAX_BYTES {
                return Err("Gateway history exceeded the Quick Chat recovery limit.".to_string());
            }
            let bounds = recovery_page_bounds(&page, offset)?;
            let current_snapshot = (bounds.source.clone(), bounds.total);
            if snapshot
                .as_ref()
                .is_some_and(|previous| previous != &current_snapshot)
            {
                return Err("Gateway history changed during reply recovery.".to_string());
            }
            snapshot = Some(current_snapshot);
            let next_offset = page.next_offset;
            let has_more = page.has_more == Some(true);
            let mut older = page.messages;
            older.append(&mut messages);
            messages = older;
            if let Some(recovered) = recovered_reply_messages(&messages, &identity.idempotency_key)?
            {
                return Ok(recovered);
            }
            if !has_more {
                break;
            }
            // A replay cursor means the oldest raw record lost projected siblings.
            // Do not join two partial views and infer that all commentary was recovered.
            if !bounds.oldest_complete {
                return Err(
                    "Gateway history split a reply record at the page boundary.".to_string()
                );
            }
            offset = next_offset;
        }
        Err("The exact user turn and completed reply were not found within the bounded history window.".to_string())
    }

    async fn agent_catalog(
        &self,
        gateway: &GatewayClient,
    ) -> Result<(AgentsListResult, Vec<QuickChatAgent>), String> {
        let generation = gateway.generation();
        let catalog = gateway.agents_list().await?;
        let agents = build_agents(&catalog)?;
        gateway.with_generation(generation, || {
            let mut selection = self
                .selected_agent_id
                .lock()
                .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())?;
            if selection
                .as_ref()
                .is_some_and(|selected| !agents.iter().any(|agent| agent.id == selected.as_str()))
            {
                *selection = None;
            }
            Ok(())
        })?;
        Ok((catalog, agents))
    }

    async fn agents(&self, gateway: &GatewayClient) -> Result<Vec<QuickChatAgent>, String> {
        self.agent_catalog(gateway).await.map(|(_, agents)| agents)
    }

    async fn selected_agent(
        &self,
        gateway: &GatewayClient,
        on_missing: MissingSelection,
    ) -> Result<(QuickChatAgent, AgentsListResult), String> {
        // Snapshot the pin before agents() refreshes the cache: a refresh clears a
        // stale pin, and the send path must see that the pin existed so it can fail
        // instead of silently rerouting the message to the default agent.
        let pinned = self
            .selected_agent_id
            .lock()
            .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())?
            .clone();
        let (catalog, agents) = self.agent_catalog(gateway).await?;
        resolve_selected_agent(pinned.as_deref(), &agents, on_missing).map(|agent| (agent, catalog))
    }

    async fn select_agent(
        &self,
        gateway: &GatewayClient,
        agent_id: &str,
    ) -> Result<QuickChatAgent, String> {
        let agent_id = agent_id.trim();
        let generation = gateway.generation();
        let agents = self.agents(gateway).await?;
        let selected = agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .ok_or_else(|| format!("Unknown Quick Chat agent \"{agent_id}\"."))?;
        gateway.with_generation(generation, || {
            let mut selection = self
                .selected_agent_id
                .lock()
                .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())?;
            let mut retry = self
                .retry_identity
                .lock()
                .map_err(|_| "Quick Chat retry state is unavailable.".to_string())?;
            // Explicitly changing agents also invalidates a pending ACK's retry identity.
            // Passive catalog changes and selecting the same resolved agent retain it.
            if retry
                .as_ref()
                .is_some_and(|current| current.agent_id != selected.id)
            {
                *retry = None;
            }
            *selection = if selected.is_default {
                None
            } else {
                Some(selected.id.clone())
            };
            Ok(())
        })?;
        Ok(selected)
    }

    fn shortcut_status(&self) -> Result<QuickChatShortcutStatus, String> {
        let active = self
            .active_shortcut
            .lock()
            .map_err(|_| "Quick Chat shortcut state is unavailable.".to_string())?;
        Ok(QuickChatShortcutStatus {
            supported: self.shortcuts_supported,
            enabled: active.registered,
            accelerator: active.accelerator.clone(),
        })
    }

    fn active_shortcut(&self) -> Result<ActiveShortcut, String> {
        self.active_shortcut
            .lock()
            .map_err(|_| "Quick Chat shortcut state is unavailable.".to_string())
            .map(|active| active.clone())
    }

    pub(crate) fn set_active_shortcut(
        &self,
        accelerator: String,
        shortcut: Shortcut,
        registered: bool,
    ) {
        if let Ok(mut active) = self.active_shortcut.lock() {
            *active = ActiveShortcut {
                accelerator,
                shortcut,
                registered,
            };
        }
    }

    pub(crate) fn set_shortcut_registered(&self, registered: bool) {
        if let Ok(mut active) = self.active_shortcut.lock() {
            active.registered = registered;
        }
    }

    pub(crate) fn shortcut(&self) -> Option<Shortcut> {
        self.active_shortcut
            .lock()
            .ok()
            .map(|active| active.shortcut)
    }

    pub fn matches_shortcut(&self, shortcut: &Shortcut) -> bool {
        self.active_shortcut
            .lock()
            .is_ok_and(|active| active.registered && active.shortcut == *shortcut)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum MissingSelection {
    FallBackToDefault,
    Fail,
}

struct RecoveryPosition<'a> {
    id: &'a str,
    source: &'a str,
    seq: u64,
    raw_seq: u64,
}

fn recovery_position(message: &Value) -> Result<RecoveryPosition<'_>, String> {
    let metadata = &message["__openclaw"];
    let position = &metadata["transcriptPosition"];
    let id = metadata["id"].as_str().filter(|id| !id.is_empty());
    let source = position["source"]
        .as_str()
        .filter(|source| !source.is_empty() && source.len() <= 128);
    let seq = metadata["seq"].as_u64().filter(|seq| *seq > 0);
    match (id, source, seq, position["rawSeq"].as_u64()) {
        (Some(id), Some(source), Some(seq), Some(raw_seq)) => Ok(RecoveryPosition {
            id,
            source,
            seq,
            raw_seq,
        }),
        _ => Err("Gateway history lacks stable transcript identity and order.".to_string()),
    }
}

struct RecoveryPageBounds {
    source: String,
    total: u64,
    oldest_complete: bool,
}

fn recovery_page_bounds(
    page: &ChatHistoryPage,
    offset: Option<u64>,
) -> Result<RecoveryPageBounds, String> {
    if page.offset != offset && !(offset.is_none() && page.offset == Some(0)) {
        return Err("Gateway history returned a different page offset.".to_string());
    }
    let total = page
        .total_messages
        .filter(|total| *total > 0)
        .ok_or_else(|| "Gateway history lacks bounded pagination metadata.".to_string())?;
    let newest = total
        .checked_sub(offset.unwrap_or(0))
        .ok_or_else(|| "Gateway history returned an invalid page offset.".to_string())?;
    let mut positions = page
        .messages
        .iter()
        .map(recovery_position)
        .collect::<Result<Vec<_>, _>>()?;
    positions.sort_by_key(|position| position.seq);
    let first = positions
        .first()
        .ok_or_else(|| "Gateway history contains no recoverable transcript records.".to_string())?;
    let source = first.source.to_string();
    for position in &positions {
        if position.source != source || position.seq > newest {
            return Err(
                "Gateway history changed its transcript source or page window.".to_string(),
            );
        }
    }
    for pair in positions.windows(2) {
        let (left, right) = (&pair[0], &pair[1]);
        if (left.seq == right.seq && (left.id != right.id || left.raw_seq != right.raw_seq))
            || (left.seq < right.seq && (left.raw_seq >= right.raw_seq || left.id == right.id))
        {
            return Err("Gateway history returned conflicting transcript order.".to_string());
        }
    }
    let record_offset = total - first.seq + 1;
    let oldest_complete = match (page.has_more, page.next_offset) {
        (Some(false), None) => true,
        (Some(true), Some(next)) if next > offset.unwrap_or(0) && next < total => {
            if next != record_offset && next != record_offset - 1 {
                return Err(
                    "Gateway history returned an inconsistent continuation offset.".to_string(),
                );
            }
            next == record_offset
        }
        _ => return Err("Gateway history pagination did not advance.".to_string()),
    };
    Ok(RecoveryPageBounds {
        source,
        total,
        oldest_complete,
    })
}

fn recovery_identity_matches(fields: &[Option<&Value>], expected: &str) -> Result<bool, String> {
    let claims_identity = fields
        .iter()
        .flatten()
        .any(|value| value.as_str() == Some(expected));
    if claims_identity
        && fields
            .iter()
            .flatten()
            .any(|value| value.as_str() != Some(expected))
    {
        return Err("Gateway history returned conflicting reply identities.".to_string());
    }
    Ok(claims_identity)
}

fn reject_incomplete_history_message(message: &Value) -> Result<(), String> {
    let placeholder = |text: &str| {
        text == "[chat.history omitted: message too large]"
            || text.starts_with("[chat.history unavailable:")
    };
    if message["__openclaw"]["truncated"].as_bool() == Some(true)
        || message["content"].as_str().is_some_and(placeholder)
        || message["text"].as_str().is_some_and(placeholder)
        || message["content"].as_array().is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block["text"].as_str().is_some_and(placeholder))
        })
    {
        return Err("The completed reply was truncated in Gateway history.".to_string());
    }
    Ok(())
}

fn is_completed_history_reply(message: &Value) -> bool {
    let transcript_only = (message["provider"] == "openclaw"
        && message["model"] == "delivery-mirror")
        || matches!(
            message["openclawDeliveryMirror"]["kind"].as_str(),
            Some(
                "channel-final"
                    | "channel-final-suppressed"
                    | "message-tool-source-reply"
                    | "cron-direct-delivery-context"
            )
        );
    matches!(message["stopReason"].as_str(), Some("stop" | "length"))
        && !transcript_only
        && message.get("openclawStreamFallback").is_none()
        && message.get("openclawAbort").is_none()
        && !message["content"].as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                matches!(
                    block["type"].as_str(),
                    Some("toolCall" | "toolUse" | "functionCall")
                )
            })
        })
}

fn recovered_reply_messages(messages: &[Value], key: &str) -> Result<Option<Vec<Value>>, String> {
    let mut ordered = messages
        .iter()
        .map(|message| recovery_position(message).map(|position| (position, message)))
        .collect::<Result<Vec<_>, _>>()?;
    ordered.sort_by_key(|(position, _)| position.raw_seq);
    let mut anchor: Option<(&RecoveryPosition<'_>, &Value)> = None;
    let user_key = format!("{key}:user");
    for (position, message) in &ordered {
        if message["role"] == "user"
            && recovery_identity_matches(
                &[
                    message.get("idempotencyKey"),
                    message["__openclaw"].get("idempotencyKey"),
                ],
                &user_key,
            )?
        {
            reject_incomplete_history_message(message)?;
            if anchor.is_some_and(|(previous, value)| {
                previous.id != position.id
                    || previous.raw_seq != position.raw_seq
                    || value != *message
            }) {
                return Err("Gateway history returned conflicting user turn anchors.".to_string());
            }
            anchor = Some((position, message));
        }
    }
    let mut recovered = Vec::new();
    let mut identities = HashMap::new();
    let mut completed = false;
    for (position, message) in &ordered {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let metadata = message.get("__openclaw");
        let keys = [
            metadata.and_then(|meta| meta.get("runId")),
            metadata.and_then(|meta| meta.get("idempotencyKey")),
            message.get("idempotencyKey"),
        ];
        if !recovery_identity_matches(&keys, key)? {
            continue;
        }
        reject_incomplete_history_message(message)?;
        let Some((anchor, _)) = anchor else { continue };
        if position.source != anchor.source {
            return Err("Gateway history changed during reply recovery.".to_string());
        }
        if position.raw_seq <= anchor.raw_seq {
            continue;
        }
        if message.get("stopReason").and_then(Value::as_str) == Some("error") {
            return Err("Gateway history contains a failed reply.".to_string());
        }
        {
            // A projected commentary item and the final row can share the transcript ID.
            let item = message
                .get("openclawStreamFallback")
                .and_then(|fallback| fallback.get("itemId"))
                .and_then(Value::as_str);
            let identity = (position.id.to_string(), item.map(str::to_string));
            if let Some(previous) = identities.insert(identity, message) {
                if previous != message {
                    return Err("Gateway history returned conflicting reply records.".to_string());
                }
                continue;
            }
        }
        let content = message.get("content");
        let presentable = content
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
            || message
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            || content.and_then(Value::as_array).is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("text" | "canvas")
                    )
                })
            });
        if presentable {
            completed = is_completed_history_reply(message);
            recovered.push((*message).clone());
        }
    }
    Ok((completed && !recovered.is_empty()).then_some(recovered))
}

fn resolve_selected_agent(
    pinned: Option<&str>,
    agents: &[QuickChatAgent],
    on_missing: MissingSelection,
) -> Result<QuickChatAgent, String> {
    if let Some(id) = pinned {
        if let Some(agent) = agents.iter().find(|agent| agent.id == id) {
            return Ok(agent.clone());
        }
        if on_missing == MissingSelection::Fail {
            return Err("The selected agent is no longer available.".to_string());
        }
    }
    agents
        .iter()
        .find(|agent| agent.is_default)
        .cloned()
        .ok_or_else(|| "OpenClaw did not report a default agent.".to_string())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_agents(catalog: &AgentsListResult) -> Result<Vec<QuickChatAgent>, String> {
    let agents = catalog
        .agents
        .iter()
        .filter(|summary| summary.kind.as_deref() != Some("system"))
        .map(|summary| {
            let id = summary.id.clone();
            let identity = summary.identity.as_ref();
            let name = non_empty(identity.and_then(|identity| identity.name.clone()))
                .or_else(|| non_empty(summary.name.clone()))
                .unwrap_or_else(|| id.clone());
            QuickChatAgent {
                id,
                name,
                emoji: non_empty(identity.and_then(|identity| identity.emoji.clone())),
                avatar_url: non_empty(identity.and_then(|identity| identity.avatar_url.clone())),
                is_default: summary.id == catalog.default_id,
            }
        })
        .collect::<Vec<_>>();
    if agents.iter().any(|agent| agent.is_default) {
        Ok(agents)
    } else {
        Err("OpenClaw did not report a default agent.".to_string())
    }
}

fn parse_shortcut(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut \"{accelerator}\": {error}"))
}

fn validate_quickchat_shortcut(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = parse_shortcut(accelerator)?;
    let dashboard_shortcut = parse_shortcut(tray::GLOBAL_SHORTCUT)
        .expect("the built-in dashboard shortcut must be valid");
    if shortcut == dashboard_shortcut {
        return Err(format!(
            "Shortcut \"{accelerator}\" is reserved for Open Dashboard."
        ));
    }
    Ok(shortcut)
}

fn shortcut_preference_from_path(path: &Path) -> QuickChatShortcutPreference {
    let configured = fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(accelerator) = configured {
        if let Ok(shortcut) = validate_quickchat_shortcut(&accelerator) {
            return QuickChatShortcutPreference {
                accelerator,
                shortcut,
            };
        }
    }
    default_shortcut_preference()
}

fn default_shortcut_preference() -> QuickChatShortcutPreference {
    QuickChatShortcutPreference {
        accelerator: QUICKCHAT_SHORTCUT.to_string(),
        shortcut: parse_shortcut(QUICKCHAT_SHORTCUT)
            .expect("the built-in Quick Chat shortcut must be valid"),
    }
}

fn persist_shortcut_preference(path: &Path, accelerator: Option<&str>) -> std::io::Result<()> {
    match accelerator {
        Some(accelerator) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, accelerator.as_bytes())
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

fn quickchat_config_file(
    app: &impl Manager<tauri::Wry>,
    filename: &str,
) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(filename))
        .map_err(|error| format!("Could not resolve Quick Chat preference path: {error}"))
}

pub(crate) fn load_shortcut_preference(
    app: &impl Manager<tauri::Wry>,
) -> QuickChatShortcutPreference {
    match quickchat_config_file(app, QUICKCHAT_SHORTCUT_FILE) {
        Ok(path) => shortcut_preference_from_path(&path),
        Err(error) => {
            eprintln!("{error}");
            default_shortcut_preference()
        }
    }
}

fn quickchat_shortcut_disabled_marker(app: &impl Manager<tauri::Wry>) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(path) => Some(path.join(QUICKCHAT_SHORTCUT_DISABLED_MARKER)),
        Err(error) => {
            eprintln!("Could not resolve Quick Chat shortcut preference path: {error}");
            None
        }
    }
}

pub(crate) fn quickchat_shortcut_marker_exists(path: &Path) -> bool {
    match path.try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            eprintln!("Could not read Quick Chat shortcut preference: {error}");
            false
        }
    }
}

pub(crate) fn quickchat_shortcut_enabled(app: &impl Manager<tauri::Wry>) -> bool {
    !quickchat_shortcut_disabled_marker(app)
        .as_deref()
        .is_some_and(quickchat_shortcut_marker_exists)
}

pub(crate) fn persist_quickchat_shortcut_state(app: &AppHandle, registered: bool) {
    let Some(marker) = quickchat_shortcut_disabled_marker(app) else {
        return;
    };
    let result = if registered {
        match fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        marker
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| fs::write(&marker, b""))
    };
    if let Err(error) = result {
        eprintln!("Could not persist Quick Chat shortcut preference: {error}");
    }
}

pub fn quickchat_position(
    monitor_pos: (f64, f64),
    monitor_size: (f64, f64),
    window_size: (f64, f64),
) -> (f64, f64) {
    let max_x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0);
    let max_y = monitor_pos.1 + (monitor_size.1 - window_size.1).max(0.0);
    let x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0) / 2.0;
    let y = monitor_pos.1 + monitor_size.1 * 0.22;
    (x.clamp(monitor_pos.0, max_x), y.clamp(monitor_pos.1, max_y))
}

fn ensure_quickchat_window(app: &AppHandle) -> Result<Window, String> {
    // Widget children make Quick Chat multi-WebView; the native window remains its stable owner.
    if let Some(window) = app.get_window(QUICKCHAT_LABEL) {
        app.state::<GatewayClient>().activate(app.clone());
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        QUICKCHAT_LABEL,
        WebviewUrl::App("quickchat.html".into()),
    )
    .title("Quick Chat")
    .inner_size(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Could not create Quick Chat window: {error}"))?;
    app.state::<GatewayClient>().activate(app.clone());
    Ok(window.as_ref().window())
}

/// Re-express a window's physical size in a target monitor's physical pixels.
///
/// `inner_size()` reports physical pixels at the scale of the monitor the
/// window is on *now*, while `work_area()` is physical pixels of the monitor we
/// are about to move to. Comparing them directly misplaces Quick Chat across a
/// mixed-DPI boundary: a 640pt window on a 2x display reports 1280px, so
/// centring it on a 1x display uses double its real width. Scales that are
/// equal (the single-monitor case) give a ratio of 1 and change nothing.
pub(crate) fn quickchat_target_size(
    window_physical: (f64, f64),
    window_scale: f64,
    monitor_scale: f64,
) -> (f64, f64) {
    let usable = |scale: f64| scale.is_finite() && scale > 0.0;
    if !usable(window_scale) || !usable(monitor_scale) {
        return window_physical;
    }
    let ratio = monitor_scale / window_scale;
    (window_physical.0 * ratio, window_physical.1 * ratio)
}

pub(crate) fn position_quickchat(app: &AppHandle, window: &Window) -> Result<(), String> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "Could not determine a monitor for Quick Chat.".to_string())?;
    let work_area = monitor.work_area();
    let window_size = window
        .inner_size()
        .map_err(|error| format!("Could not read Quick Chat size: {error}"))?;
    let window_scale = window
        .scale_factor()
        .map_err(|error| format!("Could not read Quick Chat scale: {error}"))?;
    let target_size = quickchat_target_size(
        (window_size.width as f64, window_size.height as f64),
        window_scale,
        monitor.scale_factor(),
    );
    let (x, y) = quickchat_position(
        (work_area.position.x as f64, work_area.position.y as f64),
        (work_area.size.width as f64, work_area.size.height as f64),
        target_size,
    );
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| format!("Could not position Quick Chat: {error}"))
}

pub fn request_hide(app: &AppHandle) {
    app.state::<QuickChatState>()
        .hide_requested
        .store(true, Ordering::SeqCst);
    let _ = app.emit_to(QUICKCHAT_LABEL, "quickchat:hide-requested", ());
}

pub fn toggle_quickchat(app: &AppHandle) {
    if let Some(window) = app.get_window(QUICKCHAT_LABEL) {
        if window.is_visible().unwrap_or(false) {
            request_hide(app);
            return;
        }
    }
    if let Err(error) = show_quickchat(app) {
        eprintln!("Quick Chat unavailable: {error}");
    }
}

fn show_quickchat(app: &AppHandle) -> Result<(), String> {
    let window = ensure_quickchat_window(app)?;
    app.state::<GatewayClient>().resume_paused_reconnect();
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT))
        .map_err(|error| format!("Could not reset Quick Chat size: {error}"))?;
    position_quickchat(app, &window)?;
    app.state::<QuickChatState>()
        .hide_requested
        .store(false, Ordering::SeqCst);
    window
        .show()
        .map_err(|error| format!("Could not show Quick Chat: {error}"))?;
    if let Err(error) = window.set_focus() {
        // X11 focus-stealing prevention can reject the focus grab; retract the bar
        // instead of leaving an unfocusable always-on-top window on screen. If even
        // hide fails, destroy the window rather than strand it; the next toggle rebuilds.
        app.state::<QuickChatState>()
            .hide_requested
            .store(true, Ordering::SeqCst);
        if window.hide().is_err() {
            let _ = window.destroy();
        }
        return Err(format!("Could not focus Quick Chat: {error}"));
    }
    window
        .emit("quickchat:shown", ())
        .map_err(|error| format!("Could not activate Quick Chat: {error}"))
}

// Commands take the calling WebView, not WebviewWindow: once widgets are attached the
// host becomes multi-WebView and Tauri intentionally rejects WebviewWindow command args.
pub(crate) fn require_quickchat_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() == QUICKCHAT_LABEL && webview.window().label() == QUICKCHAT_LABEL {
        Ok(())
    } else {
        Err("Quick Chat command is available only to the Quick Chat webview.".to_string())
    }
}

#[tauri::command]
pub async fn quickchat_agents(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
) -> Result<Vec<QuickChatAgent>, String> {
    require_quickchat_webview(&webview)?;
    state.agents(gateway.inner()).await
}

#[tauri::command]
pub async fn quickchat_identity(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
) -> Result<QuickChatAgent, String> {
    require_quickchat_webview(&webview)?;
    state
        .selected_agent(gateway.inner(), MissingSelection::FallBackToDefault)
        .await
        .map(|(agent, _)| agent)
}

#[tauri::command]
pub async fn quickchat_select_agent(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
    agent_id: String,
) -> Result<QuickChatAgent, String> {
    require_quickchat_webview(&webview)?;
    state.select_agent(gateway.inner(), &agent_id).await
}

#[tauri::command]
pub async fn quickchat_send(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
    message: String,
) -> Result<ChatSendResult, String> {
    require_quickchat_webview(&webview)?;
    state.send(gateway.inner(), message).await
}

#[tauri::command]
pub fn quickchat_shortcut(
    webview: Webview,
    state: State<'_, QuickChatState>,
) -> Result<QuickChatShortcutStatus, String> {
    require_quickchat_webview(&webview)?;
    state.shortcut_status()
}

#[tauri::command]
pub fn quickchat_set_shortcut(
    webview: Webview,
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, QuickChatState>,
    accelerator: Option<String>,
) -> Result<QuickChatShortcutStatus, String> {
    require_quickchat_webview(&webview)?;
    if !state.shortcuts_supported {
        return state.shortcut_status();
    }

    let configured = accelerator.and_then(|value| non_empty(Some(value)));
    let candidate_accelerator = configured
        .clone()
        .unwrap_or_else(|| QUICKCHAT_SHORTCUT.to_string());
    let candidate = validate_quickchat_shortcut(&candidate_accelerator)?;
    let current = state.active_shortcut()?;
    let preference_path = quickchat_config_file(&app, QUICKCHAT_SHORTCUT_FILE)?;
    let manager = app.global_shortcut();
    let current_registered = manager.is_registered(current.shortcut);
    let should_register = quickchat_shortcut_enabled(&app);
    let candidate_already_registered = current.shortcut == candidate && current_registered;

    if !candidate_already_registered {
        manager.register(candidate).map_err(|error| {
            format!("Could not register shortcut \"{candidate_accelerator}\": {error}")
        })?;
    }
    if current.shortcut != candidate && current_registered {
        if let Err(error) = manager.unregister(current.shortcut) {
            let _ = manager.unregister(candidate);
            return Err(format!(
                "Could not replace shortcut \"{}\": {error}",
                current.accelerator
            ));
        }
    }
    if !should_register {
        if let Err(error) = manager.unregister(candidate) {
            if current.shortcut != candidate && current_registered {
                let _ = manager.register(current.shortcut);
            }
            return Err(format!(
                "Could not finish validating shortcut \"{candidate_accelerator}\": {error}"
            ));
        }
    }

    if let Err(error) = persist_shortcut_preference(&preference_path, configured.as_deref()) {
        if manager.is_registered(candidate) {
            let _ = manager.unregister(candidate);
        }
        if current_registered && !manager.is_registered(current.shortcut) {
            let _ = manager.register(current.shortcut);
        }
        return Err(format!("Could not save the Quick Chat shortcut: {error}"));
    }

    let registered = should_register && manager.is_registered(candidate);
    state.set_active_shortcut(candidate_accelerator, candidate, registered);
    desktop.set_quickchat_shortcut_checked(registered);
    state.shortcut_status()
}

#[tauri::command]
pub fn quickchat_set_expanded(webview: Webview, expanded: bool) -> Result<(), String> {
    require_quickchat_webview(&webview)?;
    let window = webview.window();
    let height = if expanded {
        QUICKCHAT_EXPANDED_HEIGHT
    } else {
        QUICKCHAT_HEIGHT
    };
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, height))
        .map_err(|error| format!("Could not resize Quick Chat: {error}"))?;
    position_quickchat(window.app_handle(), &window)
}

#[tauri::command]
pub async fn quickchat_activate(
    webview: Webview,
    state: State<'_, QuickChatState>,
    session_id: String,
    renderer_epoch: u64,
    generation: u64,
) -> Result<bool, String> {
    require_quickchat_webview(&webview)?;
    state
        .widget_state()
        .set_visible(
            &webview.window(),
            true,
            &session_id,
            renderer_epoch,
            generation,
            &state.hide_requested,
        )
        .await
}

#[tauri::command]
pub async fn quickchat_hide(
    webview: Webview,
    session_id: String,
    renderer_epoch: u64,
    generation: u64,
) -> Result<bool, String> {
    require_quickchat_webview(&webview)?;
    let window = webview.window();
    let app = window.app_handle();
    let state = app.state::<QuickChatState>();
    state
        .widget_state()
        .set_visible(
            &window,
            false,
            &session_id,
            renderer_epoch,
            generation,
            &state.hide_requested,
        )
        .await
}

#[tauri::command]
pub async fn quickchat_ready(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
    session_id: String,
    renderer_epoch: u64,
) -> Result<bool, String> {
    require_quickchat_webview(&webview)?;
    if !state
        .widget_state()
        .start_session(&webview, &session_id, renderer_epoch)
        .await?
    {
        return Ok(false);
    }
    gateway.emit_current_state(&webview)?;
    Ok(!state.hide_requested.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn quickchat_show_dashboard(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_quickchat_webview(&webview)?;
    tray::open_dashboard(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_ws::tests::RpcFixture;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn start_send(
        state: &QuickChatState,
        fixture: &RpcFixture,
        message: &str,
    ) -> tokio::task::JoinHandle<Result<ChatSendResult, String>> {
        let state = state.clone();
        let gateway = fixture.client.clone();
        let message = message.to_string();
        tokio::spawn(async move { state.send(&gateway, message).await })
    }

    async fn answer_catalog(fixture: &mut RpcFixture) {
        fixture
            .request("agents.list")
            .await
            .1
            .send(Ok(json!({
                "defaultId": "work", "mainKey": "main", "scope": "global",
                "agents": [{"id": "work", "name": "Work"}],
            })))
            .unwrap();
    }

    #[tokio::test]
    async fn catalog_completion_cannot_relabel_a_draft_after_route_replacement() {
        for replacements in [1, 2] {
            let mut fixture = RpcFixture::new().await;
            let state = QuickChatState::new(true);
            let sending = start_send(&state, &fixture, "original draft");
            let (_, reply) = fixture.request("agents.list").await;
            for _ in 0..replacements {
                fixture.replace_route();
            }
            reply
                .send(Ok(json!({
                    "defaultId": "work", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "work"}],
                })))
                .unwrap();
            assert!(sending.await.unwrap().is_err());
            fixture.no_request().await;
            assert!(fixture.chat_frames().is_empty());
        }
    }

    #[tokio::test]
    async fn reconnect_without_reconfiguration_retains_the_failed_draft_key() {
        let mut fixture = RpcFixture::new().await;
        let state = QuickChatState::new(true);
        let owner = fixture.client.generation();
        let first = start_send(&state, &fixture, "same draft");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        let key = request["params"]["idempotencyKey"].clone();
        drop(reply); // Close the real fixture transport without acknowledging this send.
        assert!(first.await.unwrap().is_err());
        fixture.reconnect().await;
        assert_eq!(fixture.client.generation(), owner);
        let retry = start_send(&state, &fixture, "same draft");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        assert_eq!(request["params"]["idempotencyKey"], key);
        reply
            .send(Ok(json!({"runId": key, "status": "in_flight"})))
            .unwrap();
        assert!(retry.await.unwrap().is_ok());
        fixture.no_request().await;
        assert_eq!(fixture.chat_frames().len(), 2);
    }

    #[tokio::test]
    async fn old_history_completion_cannot_clear_a_newer_failed_draft() {
        let mut fixture = RpcFixture::new().await;
        let state = QuickChatState::new(true);
        let first = start_send(&state, &fixture, "first draft");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        let first_key = request["params"]["idempotencyKey"].clone();
        reply
            .send(Ok(json!({"runId": first_key, "status": "ok"})))
            .unwrap();
        let (_, history) = fixture.request("chat.history").await;
        let newer = start_send(&state, &fixture, "newer draft");
        fixture.wait_until_queued().await;
        history
            .send(Ok(history_page(
                json!([{
                    "role": "assistant", "content": "old answer", "idempotencyKey": first_key,
                }]),
                "physical",
                false,
                None,
            )))
            .unwrap();
        assert!(first
            .await
            .unwrap()
            .unwrap_err()
            .contains("newer Quick Chat request"));
        let (request, reply) = fixture.request("chat.send").await;
        let newer_key = request["params"]["idempotencyKey"].clone();
        reply.send(Err("second ACK unavailable".into())).unwrap();
        assert!(newer.await.unwrap().is_err());
        let retry = start_send(&state, &fixture, "newer draft");
        let (request, reply) = fixture.request("chat.send").await;
        assert_eq!(request["params"]["idempotencyKey"], newer_key);
        reply
            .send(Ok(json!({"runId": newer_key, "status": "started"})))
            .unwrap();
        assert!(retry.await.unwrap().is_ok());
        fixture.no_request().await;
    }

    fn history_page(messages: Value, session: &str, more: bool, next: Option<u64>) -> Value {
        json!({
            "sessionKey": "global", "sessionId": session, "messages": messages,
            "hasMore": more, "nextOffset": next, "totalMessages": 1000,
        })
    }

    fn history_record(mut message: Value, seq: u64) -> Value {
        if message["__openclaw"]["id"].is_null() {
            message["__openclaw"]["id"] = json!(format!("row-{seq}"));
        }
        message["__openclaw"]["seq"] = json!(seq);
        message["__openclaw"]["transcriptPosition"] =
            json!({"source": "transcript-generation-1", "rawSeq": seq * 2});
        message
    }

    fn history_anchor(key: &str, seq: u64) -> Value {
        history_record(
            json!({
                "role": "user", "content": "hello", "idempotencyKey": format!("{key}:user"),
                "__openclaw": {"idempotencyKey": format!("{key}:user")},
            }),
            seq,
        )
    }

    fn history_reply(key: &str, seq: u64, text: &str) -> Value {
        history_record(
            json!({
                "role": "assistant", "content": text, "stopReason": "stop",
                "__openclaw": {"runId": key},
            }),
            seq,
        )
    }

    #[tokio::test]
    async fn terminal_retries_recover_exact_history_without_resending() {
        let mut fixture = RpcFixture::new().await;
        let state = QuickChatState::new(true);
        let first = start_send(&state, &fixture, "hello");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        let key = request["params"]["idempotencyKey"]
            .as_str()
            .unwrap()
            .to_string();
        reply.send(Err("ACK unavailable".to_string())).unwrap();
        assert!(first.await.unwrap().is_err());

        let retry = start_send(&state, &fixture, "hello");
        let (request, reply) = fixture.request("chat.send").await;
        assert_eq!(request["params"]["idempotencyKey"], key);
        reply
            .send(Ok(json!({"runId": key, "status": "ok"})))
            .unwrap();
        let (request, reply) = fixture.request("chat.history").await;
        assert_eq!(
            request["params"],
            json!({
                "sessionKey": "global", "agentId": "work",
                "limit": 200, "maxBytes": 262144, "maxChars": 65536,
            })
        );
        reply
            .send(Ok(history_page(
                json!([history_record(
                    json!({
                        "role": "assistant", "content": "partial",
                        "__openclaw": {"runId": key, "truncated": true, "reason": "display-cap"},
                    }),
                    999
                )]),
                "physical-a",
                false,
                None,
            )))
            .unwrap();
        assert!(retry.await.unwrap().unwrap_err().contains("truncated"));

        let retry = start_send(&state, &fixture, "hello");
        let (_, reply) = fixture.request("chat.history").await;
        reply
            .send(Ok(history_page(
                json!([{
                    "role": "assistant", "content": "wrong physical session",
                    "idempotencyKey": key,
                }]),
                "physical-b",
                false,
                None,
            )))
            .unwrap();
        assert!(retry
            .await
            .unwrap()
            .unwrap_err()
            .contains("physical session changed"));

        let retry = start_send(&state, &fixture, "hello");
        let (_, reply) = fixture.request("chat.history").await;
        reply
            .send(Err("unknown method chat.history".to_string()))
            .unwrap();
        assert!(retry
            .await
            .unwrap()
            .unwrap_err()
            .contains("without sending again"));
        // A method-level recovery failure must not mark the connection broken.
        assert!(fixture.client.agents_list().await.is_ok());

        let retry = start_send(&state, &fixture, "hello");
        let (_, reply) = fixture.request("chat.history").await;
        let final_message = history_record(
            json!({
                "role": "assistant", "content": [{"type": "text", "text": "Final answer"}],
                "stopReason": "stop",
                "__openclaw": {"id": "row-final", "idempotencyKey": key},
            }),
            984,
        );
        reply
            .send(Ok(history_page(
                json!([final_message]),
                "physical-a",
                true,
                Some(17),
            )))
            .unwrap();
        let (request, reply) = fixture.request("chat.history").await;
        assert_eq!(request["params"]["offset"], 17);
        assert!(request["params"].get("sessionId").is_none());
        assert!(request["params"].get("cursor").is_none());
        let mut older = history_page(
            json!([
                history_reply("other", 980, "Not this run"),
                history_anchor(&key, 981),
                history_record(
                    json!({
                        "role": "assistant", "content": "Commentary", "__openclaw": {"runId": key},
                        "openclawStreamFallback": {"source": "segment", "itemId": "commentary-1"},
                    }),
                    983
                ),
            ]),
            "physical-a",
            true,
            Some(21),
        );
        older["offset"] = json!(17);
        reply.send(Ok(older)).unwrap();
        let recovered = retry.await.unwrap().unwrap().recovered_messages.unwrap();
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[0]["content"], "Commentary");
        assert_eq!(recovered[1]["content"][0]["text"], "Final answer");
        fixture.no_request().await;
        // Completion clears only this attempt; an intentional new turn gets a fresh key.
        let next = start_send(&state, &fixture, "hello");
        let (request, reply) = fixture.request("chat.send").await;
        let next_key = request["params"]["idempotencyKey"].as_str().unwrap();
        assert_ne!(next_key, key);
        reply
            .send(Ok(json!({"runId": next_key, "status": "started"})))
            .unwrap();
        assert!(next.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn explicit_agent_selection_owns_retry_invalidation() {
        #[derive(Clone, Copy, Debug)]
        enum Selection {
            SameAgent,
            UnknownAgent,
            PassiveCatalog,
            SameAgentBecomesDefault,
            DifferentAgent,
            PendingAck,
            PendingHistory,
        }
        for selection in [
            Selection::SameAgent,
            Selection::UnknownAgent,
            Selection::PassiveCatalog,
            Selection::SameAgentBecomesDefault,
            Selection::DifferentAgent,
            Selection::PendingAck,
            Selection::PendingHistory,
        ] {
            let mut fixture = RpcFixture::new().await;
            let state = QuickChatState::new(true);
            let selecting = {
                let state = state.clone();
                let gateway = fixture.client.clone();
                tokio::spawn(async move { state.select_agent(&gateway, "work").await })
            };
            fixture
                .request("agents.list")
                .await
                .1
                .send(Ok(json!({
                    "defaultId": "personal", "mainKey": "main", "scope": "global",
                    "agents": [{"id": "work"}, {"id": "personal"}],
                })))
                .unwrap();
            assert_eq!(selecting.await.unwrap().unwrap().id, "work");

            let mut first = Some(start_send(&state, &fixture, "hello"));
            let (request, reply) = fixture.request("chat.send").await;
            assert_eq!(request["params"]["agentId"], "work");
            let key = request["params"]["idempotencyKey"]
                .as_str()
                .unwrap()
                .to_string();
            let mut pending = if matches!(selection, Selection::PendingAck) {
                Some(reply)
            } else {
                reply
                    .send(Ok(json!({"runId": key, "status": "ok"})))
                    .unwrap();
                let (_, reply) = fixture.request("chat.history").await;
                if matches!(selection, Selection::PendingHistory) {
                    Some(reply)
                } else {
                    let mut truncated = history_reply(&key, 3, "partial");
                    truncated["__openclaw"]["truncated"] = json!(true);
                    reply
                        .send(Ok(history_page(
                            json!([truncated]),
                            "physical-work",
                            false,
                            None,
                        )))
                        .unwrap();
                    assert!(first
                        .take()
                        .unwrap()
                        .await
                        .unwrap()
                        .unwrap_err()
                        .contains("truncated"));
                    None
                }
            };

            match selection {
                Selection::SameAgent => {
                    assert_eq!(
                        state
                            .select_agent(&fixture.client, "work")
                            .await
                            .unwrap()
                            .id,
                        "work"
                    );
                }
                Selection::UnknownAgent => {
                    assert!(state
                        .select_agent(&fixture.client, "missing")
                        .await
                        .err()
                        .unwrap()
                        .contains("Unknown Quick Chat agent"));
                }
                Selection::PassiveCatalog | Selection::SameAgentBecomesDefault => {
                    // A reconnect clears the real catalog cache without changing its owner.
                    let generation = fixture.client.generation();
                    fixture.reconnect().await;
                    assert_eq!(fixture.client.generation(), generation);
                    let refreshing = {
                        let state = state.clone();
                        let gateway = fixture.client.clone();
                        tokio::spawn(async move { state.agents(&gateway).await })
                    };
                    fixture
                        .request("agents.list")
                        .await
                        .1
                        .send(Ok(json!({
                            "defaultId": "work", "mainKey": "changed", "scope": "per-sender",
                            "agents": [{"id": "work"}, {"id": "personal"}],
                        })))
                        .unwrap();
                    assert!(refreshing.await.unwrap().is_ok());
                    if matches!(selection, Selection::SameAgentBecomesDefault) {
                        let selected = state.select_agent(&fixture.client, "work").await.unwrap();
                        assert!(selected.is_default);
                    }
                }
                _ => {
                    assert_eq!(
                        state
                            .select_agent(&fixture.client, "personal")
                            .await
                            .unwrap()
                            .id,
                        "personal"
                    );
                }
            }
            if matches!(selection, Selection::PendingAck) {
                pending
                    .take()
                    .unwrap()
                    .send(Ok(json!({"runId": key, "status": "ok"})))
                    .unwrap();
                let mut first = first.take().unwrap();
                // B must not replace A's retry before the selection invalidation is tested.
                let result = tokio::select! {
                    result = &mut first => result.unwrap(),
                    _ = fixture.request("chat.history") => {
                        panic!("an invalidated A ACK must not request history");
                    }
                };
                assert!(result.unwrap_err().contains("newer Quick Chat request"));
                fixture.no_request().await;
            }
            let retry = start_send(&state, &fixture, "hello");
            if let Some(reply) = pending {
                fixture.wait_until_queued().await;
                reply
                    .send(Ok(history_page(
                        json!([history_anchor(&key, 1), history_reply(&key, 3, "A reply")]),
                        "physical-work",
                        false,
                        None,
                    )))
                    .unwrap();
                assert!(first
                    .take()
                    .unwrap()
                    .await
                    .unwrap()
                    .unwrap_err()
                    .contains("newer Quick Chat request"));
            }
            if matches!(
                selection,
                Selection::DifferentAgent | Selection::PendingAck | Selection::PendingHistory
            ) {
                let (request, reply) = fixture.request("chat.send").await;
                assert_eq!(request["params"]["agentId"], "personal");
                let new_key = request["params"]["idempotencyKey"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_ne!(new_key, key);
                reply.send(Err("B ACK unavailable".into())).unwrap();
                assert!(retry.await.unwrap().is_err());
                let retry = start_send(&state, &fixture, "hello");
                let (request, reply) = fixture.request("chat.send").await;
                assert_eq!(request["params"]["agentId"], "personal");
                assert_eq!(request["params"]["idempotencyKey"], new_key);
                reply
                    .send(Ok(json!({"runId": new_key, "status": "started"})))
                    .unwrap();
                assert!(retry.await.unwrap().is_ok());
                fixture.no_request().await;
                assert_eq!(fixture.chat_frames().len(), 3);
            } else {
                let (request, reply) = fixture.request("chat.history").await;
                assert_eq!(request["params"]["agentId"], "work");
                assert_eq!(request["params"]["sessionKey"], "global");
                reply
                    .send(Ok(history_page(
                        json!([history_anchor(&key, 1), history_reply(&key, 3, "A reply")]),
                        "physical-work",
                        false,
                        None,
                    )))
                    .unwrap();
                let recovered = retry.await.unwrap().unwrap();
                assert_eq!(recovered.run_id, key);
                assert_eq!(recovered.target.agent_id.as_deref(), Some("work"));
                assert_eq!(
                    recovered.recovered_messages.unwrap()[0]["content"],
                    "A reply"
                );
                fixture.no_request().await;
                assert_eq!(fixture.chat_frames().len(), 1);
            }
            eprintln!("explicit selection control passed: {selection:?}");
        }
    }

    #[test]
    fn history_identity_rejects_conflicts_and_preserves_distinct_commentary() {
        let key = "exact-run";
        for identity in [
            json!({"__openclaw": {"runId": key}}),
            json!({"__openclaw": {"idempotencyKey": key}}),
            json!({"idempotencyKey": key}),
        ] {
            let mut message = identity;
            message["role"] = json!("assistant");
            message["content"] = json!("answer");
            message["stopReason"] = json!("stop");
            assert_eq!(
                recovered_reply_messages(
                    &[history_anchor(key, 1), history_record(message, 3)],
                    key
                )
                .unwrap()
                .unwrap()
                .len(),
                1
            );
        }
        for identity in [
            json!({"__openclaw": {"runId": key, "idempotencyKey": "different"}}),
            json!({"__openclaw": {"runId": key}, "idempotencyKey": "different"}),
            json!({"__openclaw": {"runId": format!("{key}:user")}}),
            json!({"__openclaw": {"id": key}}),
            json!({"idempotencyKey": format!(" {key} ")}),
        ] {
            let mut message = identity;
            message["role"] = json!("assistant");
            message["content"] = json!("must not recover");
            let result = recovered_reply_messages(
                &[history_anchor(key, 1), history_record(message, 3)],
                key,
            );
            assert!(result.is_err() || result.unwrap().is_none());
        }
        let mut messages = vec![history_anchor(key, 1)];
        for (id, item, seq) in [
            ("same", Some("a"), 3),
            ("same", Some("b"), 3),
            ("same", None, 3),
            ("distinct", None, 5),
        ] {
            let mut message = history_record(
                json!({
                    "role": "assistant", "content": "equal text",
                    "__openclaw": {"id": id, "runId": key},
                }),
                seq,
            );
            if let Some(item) = item {
                message["openclawStreamFallback"] = json!({"itemId": item, "source": "segment"});
            } else {
                message["stopReason"] = json!("stop");
            }
            messages.push(message);
        }
        messages.push(messages[1].clone());
        assert_eq!(
            recovered_reply_messages(&messages, key)
                .unwrap()
                .unwrap()
                .len(),
            4
        );
        messages[5]["content"] = json!("conflicting overlap");
        assert!(recovered_reply_messages(&messages, key)
            .unwrap_err()
            .contains("conflicting"));
        for reason in ["display-cap", "oversized"] {
            assert!(recovered_reply_messages(&[history_anchor(key, 1), history_record(json!({
                "role": "assistant", "content": "[chat.history omitted: message too large]",
                "__openclaw": {"idempotencyKey": key, "truncated": true, "reason": reason},
            }), 3)], key).unwrap_err().contains("truncated"));
        }
    }

    async fn assert_anchor_recovery_case(case: &str) {
        let mut fixture = RpcFixture::new().await;
        let state = QuickChatState::new(true);
        let mut send = start_send(&state, &fixture, "hello");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        let key = request["params"]["idempotencyKey"]
            .as_str()
            .unwrap()
            .to_string();
        reply
            .send(Ok(json!({"runId": key, "status": "ok"})))
            .unwrap();
        let (_, reply) = fixture.request("chat.history").await;
        let anchor = history_anchor(&key, 995);
        let mut final_message = history_reply(&key, 997, "Saved answer");
        if case.starts_with("injected") {
            final_message = history_record(
                json!({
                    "role": "assistant", "content": [{"type": "text", "text": "Saved answer"}],
                    "api": "openai-responses", "provider": "openclaw", "model": "gateway-injected",
                    "stopReason": "stop", "idempotencyKey": key,
                    "__openclaw": {"idempotencyKey": key},
                }),
                997,
            );
            assert!(final_message["__openclaw"].get("runId").is_none());
        }
        let commentary = history_record(
            json!({
                "role": "assistant", "content": "Commentary", "__openclaw": {"runId": key},
                "openclawStreamFallback": {"source": "segment", "itemId": "commentary-a"},
            }),
            996,
        );
        let joined = matches!(
            case,
            "two-page" | "source-drift" | "total-drift" | "offset-drift"
        );
        let mut messages = vec![anchor.clone(), commentary.clone(), final_message.clone()];
        match case {
            "length" => messages[2]["stopReason"] = json!("length"),
            "missing-anchor" => {
                messages[0]["idempotencyKey"] = json!("unrelated:user");
                messages[0]["__openclaw"]["idempotencyKey"] = json!("unrelated:user");
            }
            "late-media" => {
                messages[0]["idempotencyKey"] = json!(format!("{key}:user:late-media"));
                messages[0]["__openclaw"]["idempotencyKey"] =
                    json!(format!("{key}:user:late-media"));
            }
            "user-run-id" => {
                messages[0]
                    .as_object_mut()
                    .unwrap()
                    .remove("idempotencyKey");
                messages[0]["__openclaw"]
                    .as_object_mut()
                    .unwrap()
                    .remove("idempotencyKey");
                messages[0]["__openclaw"]["runId"] = json!(key);
            }
            "anchor-conflict" => messages[0]["idempotencyKey"] = json!("different:user"),
            "assistant-conflict" => messages[1]["idempotencyKey"] = json!("different"),
            "commentary-only" => {
                messages[2].as_object_mut().unwrap().remove("stopReason");
                messages[2]["openclawStreamFallback"] =
                    json!({"source": "segment", "itemId": "last"});
            }
            "transcript-only" => {
                messages[2]["provider"] = json!("openclaw");
                messages[2]["model"] = json!("delivery-mirror");
            }
            "wrong-final" => messages[2]["__openclaw"]["runId"] = json!("other"),
            "before-anchor" => {
                messages = vec![
                    history_reply(&key, 990, "Before this user turn"),
                    anchor.clone(),
                ];
            }
            "anchor-truncated" => messages[0]["__openclaw"]["truncated"] = json!(true),
            "reply-truncated" => messages[2]["__openclaw"]["truncated"] = json!(true),
            "placeholder" => {
                messages[2]["content"] = json!("[chat.history omitted: message too large]");
            }
            "missing-position" => {
                messages[0]["__openclaw"]
                    .as_object_mut()
                    .unwrap()
                    .remove("transcriptPosition");
            }
            "injected-aborted" => messages[2]["stopReason"] = json!("aborted"),
            "injected-abort-marker" => messages[2]["openclawAbort"] = json!({"aborted": true}),
            "injected-commentary" => {
                messages[2]["openclawStreamFallback"] =
                    json!({"source": "segment", "itemId": "injected-commentary"});
            }
            "injected-tool" => {
                messages[2]["content"].as_array_mut().unwrap().push(json!({
                    "type": "toolCall", "id": "fixture-tool", "name": "fixture", "arguments": {},
                }));
            }
            "injected-wrong-key" => {
                messages[2]["idempotencyKey"] = json!("other-run");
                messages[2]["__openclaw"]["idempotencyKey"] = json!("other-run");
            }
            "injected-provenance" => {
                messages[2]["openclawDeliveryMirror"] = json!({"kind": "channel-final"});
            }
            _ => {}
        }
        if joined || case == "split" {
            messages = vec![final_message.clone()];
        }
        let success = matches!(case, "recent" | "length" | "two-page" | "injected");
        let mut page = history_page(
            json!(messages),
            "physical",
            success || joined || case == "split",
            if joined {
                Some(4)
            } else if case == "split" {
                Some(3)
            } else if success {
                Some(6)
            } else {
                None
            },
        );
        if case == "split" {
            // The server asks to replay seq 997: this tail is only part of that record.
            page["nextOffset"] = json!(3);
        }
        reply.send(Ok(page)).unwrap();
        if joined {
            let (request, reply) = fixture.request("chat.history").await;
            assert_eq!(request["params"]["offset"], 4, "{case}");
            let mut older = history_page(json!([anchor, commentary]), "physical", true, Some(6));
            older["offset"] = json!(4);
            match case {
                "source-drift" => {
                    for message in older["messages"].as_array_mut().unwrap() {
                        message["__openclaw"]["transcriptPosition"]["source"] =
                            json!("transcript-generation-2");
                    }
                }
                "total-drift" => older["totalMessages"] = json!(1001),
                "offset-drift" => older["offset"] = json!(5),
                _ => {}
            }
            reply.send(Ok(older)).unwrap();
        }
        let result = tokio::select! {
            result = &mut send => result.unwrap(),
            _ = fixture.request("chat.history"), if success && !joined => {
                panic!("{case}: a complete recent turn must not request older history");
            }
        };
        if success {
            let recovered = result
                .unwrap_or_else(|error| panic!("{case}: {error}"))
                .recovered_messages
                .unwrap();
            assert_eq!(recovered.len(), 2, "{case}");
            assert_eq!(recovered[0]["content"], "Commentary", "{case}");
            let content = &recovered[1]["content"];
            assert_eq!(
                content.as_str().or_else(|| content[0]["text"].as_str()),
                Some("Saved answer"),
                "{case}"
            );
        } else {
            assert!(
                result.unwrap_err().contains("without sending again"),
                "{case}"
            );
            // Even a rejected window remains terminal: retry must only load history.
            let retry = start_send(&state, &fixture, "hello");
            let (_, reply) = fixture.request("chat.history").await;
            final_message["content"] = json!("Recovered on history-only retry");
            reply
                .send(Ok(history_page(
                    json!([history_anchor(&key, 995), final_message,]),
                    "physical",
                    true,
                    Some(6),
                )))
                .unwrap();
            assert!(retry.await.unwrap().is_ok(), "{case}");
        }
        fixture.no_request().await;
        assert_eq!(fixture.chat_frames().len(), 1, "{case}");
    }

    #[tokio::test]
    async fn anchored_history_recovers_recent_turns_without_exhausting_the_session() {
        for case in ["recent", "length", "two-page", "injected"] {
            assert_anchor_recovery_case(case).await;
        }
    }

    #[tokio::test]
    async fn anchored_history_rejects_incomplete_windows_without_resending() {
        for case in [
            "missing-anchor",
            "late-media",
            "user-run-id",
            "anchor-conflict",
            "assistant-conflict",
            "commentary-only",
            "transcript-only",
            "wrong-final",
            "before-anchor",
            "split",
            "anchor-truncated",
            "reply-truncated",
            "placeholder",
            "source-drift",
            "total-drift",
            "offset-drift",
            "missing-position",
            "injected-aborted",
            "injected-abort-marker",
            "injected-commentary",
            "injected-tool",
            "injected-wrong-key",
            "injected-provenance",
        ] {
            assert_anchor_recovery_case(case).await;
        }
    }

    #[tokio::test]
    async fn mismatched_ack_does_not_mark_the_draft_terminal() {
        let mut fixture = RpcFixture::new().await;
        let state = QuickChatState::new(true);
        let first = start_send(&state, &fixture, "hello");
        answer_catalog(&mut fixture).await;
        let (request, reply) = fixture.request("chat.send").await;
        let key = request["params"]["idempotencyKey"].clone();
        reply
            .send(Ok(json!({"runId": "different-run", "status": "ok"})))
            .unwrap();
        assert!(first.await.unwrap().unwrap_err().contains("different"));
        let retry = start_send(&state, &fixture, "hello");
        let (request, reply) = fixture.request("chat.send").await;
        assert_eq!(request["params"]["idempotencyKey"], key);
        reply
            .send(Ok(json!({"runId": key, "status": "started"})))
            .unwrap();
        assert!(retry.await.unwrap().is_ok());
        fixture.no_request().await;
    }

    #[tokio::test]
    async fn history_recovery_rejects_oversized_and_partial_pages() {
        for case in ["bytes", "count", "nonadvancing", "partial"] {
            let mut fixture = RpcFixture::new().await;
            let state = QuickChatState::new(true);
            let send = start_send(&state, &fixture, "hello");
            answer_catalog(&mut fixture).await;
            let (request, reply) = fixture.request("chat.send").await;
            let key = request["params"]["idempotencyKey"].clone();
            reply
                .send(Ok(json!({"runId": key, "status": "ok"})))
                .unwrap();
            let (_, reply) = fixture.request("chat.history").await;
            let message = history_record(
                json!({
                    "role": "assistant", "content": "partial answer", "__openclaw": {"runId": key},
                }),
                1000,
            );
            let page = match case {
                "bytes" => history_page(
                    json!([{
                        "role": "assistant", "content": "x".repeat(RECOVERY_MAX_BYTES + 1),
                        "__openclaw": {"runId": key},
                    }]),
                    "physical",
                    false,
                    None,
                ),
                "count" => history_page(json!(vec![message.clone(); 201]), "physical", false, None),
                "nonadvancing" => history_page(json!([message.clone()]), "physical", true, Some(0)),
                "partial" => history_page(json!([message.clone()]), "physical", true, Some(1)),
                _ => unreachable!(),
            };
            reply.send(Ok(page)).unwrap();
            if case == "partial" {
                let (request, reply) = fixture.request("chat.history").await;
                assert_eq!(request["params"]["offset"], 1);
                let mut older = history_page(
                    json!([history_record(message, 999)]),
                    "physical",
                    true,
                    Some(2),
                );
                older["offset"] = json!(1);
                reply.send(Ok(older)).unwrap();
            }
            assert!(
                send.await
                    .unwrap()
                    .unwrap_err()
                    .contains("without sending again"),
                "{case}"
            );
            fixture.no_request().await;
        }
    }

    fn assert_position(actual: (f64, f64), expected: (f64, f64)) {
        assert!((actual.0 - expected.0).abs() < 1e-9);
        assert!((actual.1 - expected.1).abs() < 1e-9);
    }

    fn test_agent(id: &str, is_default: bool) -> QuickChatAgent {
        QuickChatAgent {
            id: id.to_string(),
            name: id.to_string(),
            emoji: None,
            avatar_url: None,
            is_default,
        }
    }

    fn test_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openclaw-quickchat-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn unchanged_failed_draft_reuses_idempotency_key() {
        let state = QuickChatState::new(true);
        let generation = GatewayClient::new().generation();
        let first = state
            .begin_send("hello", "main", "per-sender", "main", generation)
            .expect("first key");
        let retry = state
            .begin_send("hello", "main", "per-sender", "main", generation)
            .expect("retry key");
        let edited = state
            .begin_send("hello again", "main", "per-sender", "main", generation)
            .expect("edited key");

        assert_eq!(first.idempotency_key, retry.idempotency_key);
        assert_ne!(first.idempotency_key, edited.idempotency_key);
        state.clear_send_retry(&first);
        assert!(state.update_retry(&edited, |_| Ok(())).is_ok());
        state.clear_send_retry(&edited);
        assert_ne!(
            state
                .begin_send("hello again", "main", "per-sender", "main", generation)
                .expect("post-ack key")
                .idempotency_key,
            edited.idempotency_key
        );
    }

    #[test]
    fn position_centers_window_at_twenty_two_percent_of_work_area() {
        assert_position(
            quickchat_position((0.0, 0.0), (1920.0, 1080.0), (640.0, 92.0)),
            (640.0, 237.6),
        );
        assert_position(
            quickchat_position((-1280.0, 40.0), (1280.0, 984.0), (640.0, 92.0)),
            (-960.0, 256.48),
        );
    }

    #[test]
    fn position_stays_inside_small_work_area() {
        assert_eq!(
            quickchat_position((10.0, 20.0), (500.0, 80.0), (640.0, 92.0)),
            (10.0, 20.0)
        );
    }

    #[test]
    fn agents_use_identity_precedence_and_render_fields() {
        let catalog = AgentsListResult {
            default_id: "main".to_string(),
            main_key: "main".to_string(),
            scope: "per-sender".to_string(),
            agents: vec![
                crate::gateway_ws::GatewayAgentSummary {
                    id: "main".to_string(),
                    kind: Some("agent".to_string()),
                    name: Some("Configured".to_string()),
                    identity: Some(crate::gateway_ws::GatewayAgentIdentity {
                        name: Some("Molty".to_string()),
                        emoji: Some("🦞".to_string()),
                        avatar_url: Some("data:image/png;base64,AA==".to_string()),
                    }),
                },
                crate::gateway_ws::GatewayAgentSummary {
                    id: "other".to_string(),
                    kind: None,
                    name: None,
                    identity: None,
                },
                crate::gateway_ws::GatewayAgentSummary {
                    id: "ordinary-looking-id".to_string(),
                    kind: Some("system".to_string()),
                    name: Some("System".to_string()),
                    identity: None,
                },
            ],
        };
        let agents = build_agents(&catalog).expect("agent list");

        assert_eq!(agents[0].name, "Molty");
        assert_eq!(agents[0].emoji.as_deref(), Some("🦞"));
        assert_eq!(
            agents[0].avatar_url.as_deref(),
            Some("data:image/png;base64,AA==")
        );
        assert_eq!(agents[1].name, "other");
        assert_eq!(agents.len(), 2);
    }

    #[test]
    fn shortcut_preference_round_trips_and_resets() {
        let directory = test_directory("shortcut-roundtrip");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);

        persist_shortcut_preference(&path, Some("Ctrl+Alt+KeyK")).expect("write shortcut");
        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, "Ctrl+Alt+KeyK");
        assert!(loaded
            .shortcut
            .matches(loaded.shortcut.mods, loaded.shortcut.key));

        persist_shortcut_preference(&path, None).expect("reset shortcut");
        assert!(!path.exists());
        assert_eq!(
            shortcut_preference_from_path(&path).accelerator,
            QUICKCHAT_SHORTCUT
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn invalid_shortcut_preference_falls_back_to_default() {
        let directory = test_directory("shortcut-fallback");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);
        fs::write(&path, b"Ctrl+NotAKey").expect("write invalid shortcut");

        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, QUICKCHAT_SHORTCUT);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn dashboard_shortcut_preference_falls_back_to_default() {
        let directory = test_directory("shortcut-reserved");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);
        fs::write(&path, tray::GLOBAL_SHORTCUT).expect("write reserved shortcut");

        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, QUICKCHAT_SHORTCUT);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn missing_pinned_agent_fails_sends_and_heals_identity() {
        let agents = [test_agent("main", true), test_agent("work", false)];

        let pinned = resolve_selected_agent(Some("work"), &agents, MissingSelection::Fail);
        assert_eq!(pinned.expect("pinned agent").id, "work");
        let gone = resolve_selected_agent(Some("gone"), &agents, MissingSelection::Fail);
        assert!(gone.is_err());
        let healed =
            resolve_selected_agent(Some("gone"), &agents, MissingSelection::FallBackToDefault);
        assert_eq!(healed.expect("default agent").id, "main");
    }

    #[test]
    fn shortcut_dispatch_matches_custom_accelerator() {
        let state = QuickChatState::new(true);
        let custom = parse_shortcut("Ctrl+Alt+KeyK").expect("custom shortcut");
        let default = parse_shortcut(QUICKCHAT_SHORTCUT).expect("default shortcut");
        state.set_active_shortcut("Ctrl+Alt+KeyK".to_string(), custom, true);

        assert!(state.matches_shortcut(&custom));
        assert!(!state.matches_shortcut(&default));
        state.set_shortcut_registered(false);
        assert!(!state.matches_shortcut(&custom));
    }

    #[test]
    fn target_size_is_identity_within_one_monitor() {
        // The single-monitor case must not move by even a pixel.
        assert_eq!(
            quickchat_target_size((1280.0, 720.0), 2.0, 2.0),
            (1280.0, 720.0)
        );
        assert_eq!(
            quickchat_target_size((640.0, 360.0), 1.0, 1.0),
            (640.0, 360.0)
        );
        assert_eq!(
            quickchat_target_size((960.0, 540.0), 1.5, 1.5),
            (960.0, 540.0)
        );
    }

    #[test]
    fn target_size_rescales_across_a_dpi_boundary() {
        // A 640pt window on a 2x display reports 1280px; on a 1x display it is
        // really 640px wide, and centring with 1280 would sit it far left.
        assert_eq!(
            quickchat_target_size((1280.0, 720.0), 2.0, 1.0),
            (640.0, 360.0)
        );
        // And the reverse direction.
        assert_eq!(
            quickchat_target_size((640.0, 360.0), 1.0, 2.0),
            (1280.0, 720.0)
        );
        // Fractional scales, as Windows and some Linux compositors report.
        assert_eq!(
            quickchat_target_size((1200.0, 600.0), 2.0, 1.5),
            (900.0, 450.0)
        );
    }

    #[test]
    fn target_size_falls_back_on_unusable_scales() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                quickchat_target_size((800.0, 600.0), scale, 2.0),
                (800.0, 600.0)
            );
            assert_eq!(
                quickchat_target_size((800.0, 600.0), 2.0, scale),
                (800.0, 600.0)
            );
        }
    }

    #[test]
    fn rescaled_window_centers_on_the_target_monitor() {
        // End to end: a 2x-scaled 640pt-wide window invoked on a 1x 1920px
        // monitor. Without the rescale it centers using 1280 and lands at 320.
        let target = quickchat_target_size((1280.0, 720.0), 2.0, 1.0);
        let (x, _) = quickchat_position((0.0, 0.0), (1920.0, 1080.0), target);
        assert_eq!(x, 640.0);
    }
}
