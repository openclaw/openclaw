use crate::providers::SpeechProvider;
use crate::services::gateway::GatewayService;
use crate::services::runtime::BackgroundService;
use crate::services::ConfigService;
use async_trait::async_trait;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

#[derive(Default)]
struct VoiceAgentTracker {
    pending_requests: HashMap<String, Option<String>>,
    active_runs: HashSet<String>,
}

#[derive(Debug)]
struct WakeCaptureState {
    active: bool,
    generation: u64,
    token: String,
    started_at: Option<Instant>,
    last_heard: Option<Instant>,
    heard_beyond_trigger: bool,
    trigger_phrase: String,
    captured_transcript: String,
    committed_transcript: String,
    volatile_transcript: String,
    cooldown_until: Option<Instant>,
}

#[derive(Debug, Default)]
struct WakePreDetectState {
    revision: u64,
    transcript: String,
}

#[derive(Clone, Debug)]
enum WakePreDetectMode {
    TriggerOnly(String),
    TextFallback,
}

impl Default for WakeCaptureState {
    fn default() -> Self {
        Self {
            active: false,
            generation: 0,
            token: String::new(),
            started_at: None,
            last_heard: None,
            heard_beyond_trigger: false,
            trigger_phrase: String::new(),
            captured_transcript: String::new(),
            committed_transcript: String::new(),
            volatile_transcript: String::new(),
            cooldown_until: None,
        }
    }
}

const WAKE_SILENCE_WINDOW: Duration = Duration::from_secs(2);
const WAKE_TRIGGER_ONLY_SILENCE_WINDOW: Duration = Duration::from_secs(5);
const WAKE_CAPTURE_HARD_STOP: Duration = Duration::from_secs(120);
const WAKE_SEND_COOLDOWN: Duration = Duration::from_millis(350);
const WAKE_PRE_DETECT_SILENCE_WINDOW: Duration = Duration::from_secs(1);
const WAKE_TRIGGER_ONLY_PAUSE_WINDOW: Duration = Duration::from_millis(550);
const VOICE_WAKE_MAX_WORDS: usize = 32;
const VOICE_WAKE_MAX_WORD_LENGTH: usize = 64;
const DEFAULT_VOICE_WAKE_TRIGGER: &str = "openclaw";

pub struct VoiceWakeService {
    provider: Arc<dyn SpeechProvider>,
    gateway: Arc<GatewayService>,
    config: Arc<ConfigService>,
    pub is_enabled: Arc<Mutex<bool>>,
    level_monitor_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    suppress_sync: Arc<std::sync::atomic::AtomicBool>,
    ptt_active: Arc<AtomicBool>,
    ptt_latest_transcript: Arc<std::sync::Mutex<String>>,
    ptt_last_ui_transcript: Arc<std::sync::Mutex<String>>,
    ptt_commit_sender: Arc<std::sync::Mutex<Option<oneshot::Sender<String>>>>,
    ptt_adopted_prefix: Arc<std::sync::Mutex<String>>,
    ptt_session_token: Arc<std::sync::Mutex<String>>,
    recognition_recovery_inflight: Arc<AtomicBool>,
    wake_capture: Arc<std::sync::Mutex<WakeCaptureState>>,
    wake_pre_detect: Arc<std::sync::Mutex<WakePreDetectState>>,
    agent_tracker: Arc<Mutex<VoiceAgentTracker>>,
    machine_name: Arc<String>,
}

impl VoiceWakeService {
    pub fn new(
        provider: Arc<dyn SpeechProvider>,
        gateway: Arc<GatewayService>,
        config: Arc<ConfigService>,
    ) -> Self {
        Self {
            provider,
            gateway,
            config,
            is_enabled: Arc::new(Mutex::new(false)),
            level_monitor_task: Arc::new(Mutex::new(None)),
            suppress_sync: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ptt_active: Arc::new(AtomicBool::new(false)),
            ptt_latest_transcript: Arc::new(std::sync::Mutex::new(String::new())),
            ptt_last_ui_transcript: Arc::new(std::sync::Mutex::new(String::new())),
            ptt_commit_sender: Arc::new(std::sync::Mutex::new(None)),
            ptt_adopted_prefix: Arc::new(std::sync::Mutex::new(String::new())),
            ptt_session_token: Arc::new(std::sync::Mutex::new(String::new())),
            recognition_recovery_inflight: Arc::new(AtomicBool::new(false)),
            wake_capture: Arc::new(std::sync::Mutex::new(WakeCaptureState::default())),
            wake_pre_detect: Arc::new(std::sync::Mutex::new(WakePreDetectState::default())),
            agent_tracker: Arc::new(Mutex::new(VoiceAgentTracker::default())),
            machine_name: Arc::new(
                hostname::get()
                    .ok()
                    .map(|h| h.to_string_lossy().trim().to_string())
                    .filter(|h| !h.is_empty())
                    .unwrap_or_else(|| "this Windows PC".to_string()),
            ),
        }
    }

    fn normalize_session_key(raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            "main".to_string()
        } else {
            trimmed.to_string()
        }
    }

    fn sanitize_triggers(values: Vec<String>) -> Vec<String> {
        let mut sanitized: Vec<String> = values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .take(VOICE_WAKE_MAX_WORDS)
            .map(|value| value.chars().take(VOICE_WAKE_MAX_WORD_LENGTH).collect())
            .collect();

        if sanitized.is_empty() {
            sanitized.push(DEFAULT_VOICE_WAKE_TRIGGER.to_string());
        }
        sanitized
    }

    fn sanitize_locales(values: Vec<String>) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .filter(|value| seen.insert(value.to_lowercase()))
            .collect()
    }

    fn build_voice_message(machine_name: &str, transcript: &str) -> String {
        format!(
            "User talked via voice recognition on {} - repeat prompt first + remember some words might be incorrectly transcribed.\n\n{}",
            machine_name,
            transcript.trim()
        )
    }

    fn starts_with_ci(haystack: &str, needle: &str) -> bool {
        haystack
            .to_lowercase()
            .starts_with(&needle.trim().to_lowercase())
    }

    fn longest_matching_trigger<'a>(transcript: &str, triggers: &'a [String]) -> Option<&'a str> {
        let normalized = transcript.trim();
        triggers
            .iter()
            .map(|t| t.trim())
            .filter(|t| !t.is_empty() && Self::starts_with_ci(normalized, t))
            .max_by_key(|t| t.chars().count())
    }

    fn command_after_trigger(transcript: &str, trigger: &str) -> String {
        let normalized = transcript.trim();
        if !Self::starts_with_ci(normalized, trigger) {
            return normalized.to_string();
        }
        let transcript_chars: Vec<char> = normalized.chars().collect();
        let skip = trigger.trim().chars().count().min(transcript_chars.len());
        transcript_chars
            .into_iter()
            .skip(skip)
            .collect::<String>()
            .trim()
            .to_string()
    }

    fn text_only_fallback_match(transcript: &str, triggers: &[String]) -> Option<(String, String)> {
        let normalized = transcript.trim();
        if normalized.is_empty() {
            return None;
        }
        let lower_transcript = normalized.to_lowercase();

        let mut sorted_triggers: Vec<String> = triggers
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        sorted_triggers.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));

        for trigger in sorted_triggers {
            let lower_trigger = trigger.to_lowercase();
            if let Some(byte_pos) = lower_transcript.find(&lower_trigger) {
                let prefix_chars = lower_transcript[..byte_pos].chars().count();
                let trigger_chars = trigger.chars().count();
                let command: String = normalized
                    .chars()
                    .skip(prefix_chars + trigger_chars)
                    .collect::<String>()
                    .trim()
                    .to_string();
                if command.is_empty() {
                    continue;
                }
                return Some((trigger, command));
            }
        }
        None
    }

    fn delta_after(committed: &str, current: &str) -> String {
        if committed.is_empty() {
            return current.to_string();
        }
        if let Some(rest) = current.strip_prefix(committed) {
            rest.to_string()
        } else {
            current.to_string()
        }
    }

    fn join_parts(committed: &str, volatile: &str) -> String {
        if committed.is_empty() {
            return volatile.to_string();
        }
        if volatile.is_empty() {
            return committed.to_string();
        }
        format!("{}{}", committed, volatile)
    }

    fn join_prefix(prefix: &str, transcript: &str) -> String {
        let p = prefix.trim();
        let t = transcript.trim();
        if p.is_empty() {
            return t.to_string();
        }
        if t.is_empty() {
            return p.to_string();
        }
        format!("{} {}", p, t)
    }

    fn is_trigger_only(transcript: &str, triggers: &[String]) -> Option<String> {
        let trigger = Self::longest_matching_trigger(transcript, triggers)?;
        let remainder = Self::command_after_trigger(transcript, trigger);
        if remainder.trim().is_empty() {
            Some(trigger.to_string())
        } else {
            None
        }
    }

    fn note_pre_detect_transcript(
        wake_pre_detect: &Arc<std::sync::Mutex<WakePreDetectState>>,
        transcript: String,
    ) -> u64 {
        if let Ok(mut state) = wake_pre_detect.lock() {
            state.revision = state.revision.wrapping_add(1);
            state.transcript = transcript;
            state.revision
        } else {
            0
        }
    }

    fn reset_pre_detect(wake_pre_detect: &Arc<std::sync::Mutex<WakePreDetectState>>) {
        if let Ok(mut state) = wake_pre_detect.lock() {
            state.revision = state.revision.wrapping_add(1);
            state.transcript.clear();
        }
    }

    fn reset_wake_capture(&self) {
        if let Ok(mut state) = self.wake_capture.lock() {
            state.active = false;
            state.generation = state.generation.wrapping_add(1);
            state.started_at = None;
            state.last_heard = None;
            state.heard_beyond_trigger = false;
            state.trigger_phrase.clear();
            state.token.clear();
            state.captured_transcript.clear();
            state.committed_transcript.clear();
            state.volatile_transcript.clear();
        }
        Self::reset_pre_detect(&self.wake_pre_detect);
    }

    fn set_wake_cooldown(&self, window: Duration) {
        if let Ok(mut state) = self.wake_capture.lock() {
            state.cooldown_until = Some(Instant::now() + window);
        }
    }

    fn spawn_wake_capture_monitor(
        app: AppHandle,
        wake_capture: Arc<std::sync::Mutex<WakeCaptureState>>,
        gateway: Arc<GatewayService>,
        tracker: Arc<Mutex<VoiceAgentTracker>>,
        machine_name: Arc<String>,
        generation: u64,
        token: String,
        trigger_chime: String,
        send_chime: String,
        session_key: String,
    ) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;

                let decision = {
                    if let Ok(state) = wake_capture.lock() {
                        if !state.active || state.generation != generation {
                            0 // stop
                        } else {
                            let now = Instant::now();
                            let hard_stop_due = state.started_at.is_some_and(|start| {
                                now.saturating_duration_since(start) >= WAKE_CAPTURE_HARD_STOP
                            });
                            let silence_window = if state.heard_beyond_trigger {
                                WAKE_SILENCE_WINDOW
                            } else {
                                WAKE_TRIGGER_ONLY_SILENCE_WINDOW
                            };
                            let silence_due = state.last_heard.is_some_and(|last| {
                                now.saturating_duration_since(last) >= silence_window
                            });
                            if hard_stop_due || silence_due {
                                1 // finalize
                            } else {
                                2 // continue
                            }
                        }
                    } else {
                        0
                    }
                };

                if decision == 0 {
                    return;
                }
                if decision == 1 {
                    Self::finalize_wake_capture(
                        app.clone(),
                        wake_capture.clone(),
                        gateway.clone(),
                        tracker.clone(),
                        machine_name.clone(),
                        generation,
                        token.clone(),
                        trigger_chime.clone(),
                        send_chime.clone(),
                        session_key.clone(),
                    )
                    .await;
                    return;
                }
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_pre_detect_monitor(
        app: AppHandle,
        wake_capture: Arc<std::sync::Mutex<WakeCaptureState>>,
        wake_pre_detect: Arc<std::sync::Mutex<WakePreDetectState>>,
        gateway: Arc<GatewayService>,
        tracker: Arc<Mutex<VoiceAgentTracker>>,
        machine_name: Arc<String>,
        revision: u64,
        mode: WakePreDetectMode,
        triggers: Vec<String>,
        trigger_chime: String,
        send_chime: String,
        session_key: String,
    ) {
        let wait_window = match &mode {
            WakePreDetectMode::TriggerOnly(_) => WAKE_TRIGGER_ONLY_PAUSE_WINDOW,
            WakePreDetectMode::TextFallback => WAKE_PRE_DETECT_SILENCE_WINDOW,
        };

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(wait_window).await;

            let transcript = {
                let state = match wake_pre_detect.lock() {
                    Ok(lock) => lock,
                    Err(_) => return,
                };
                if state.revision != revision {
                    return;
                }
                state.transcript.trim().to_string()
            };
            if transcript.is_empty() {
                return;
            }

            let now = Instant::now();
            let mut emit_text: Option<String> = None;
            let mut emit_token: Option<String> = None;
            let mut start_monitor_generation: Option<u64> = None;
            let mut start_monitor_token: Option<String> = None;

            if let Ok(mut state) = wake_capture.lock() {
                if state.active || state.cooldown_until.is_some_and(|until| now < until) {
                    return;
                }

                match mode {
                    WakePreDetectMode::TriggerOnly(trigger_phrase) => {
                        if !Self::starts_with_ci(&transcript, &trigger_phrase) {
                            return;
                        }
                        let remainder = Self::command_after_trigger(&transcript, &trigger_phrase);
                        if !remainder.trim().is_empty() {
                            return;
                        }

                        state.active = true;
                        state.generation = state.generation.wrapping_add(1);
                        state.token = format!("wake-{}", state.generation);
                        state.started_at = Some(now);
                        state.last_heard = Some(now);
                        state.cooldown_until = None;
                        state.heard_beyond_trigger = false;
                        state.trigger_phrase = trigger_phrase.clone();
                        state.captured_transcript.clear();
                        state.committed_transcript.clear();
                        state.volatile_transcript.clear();
                        emit_text = Some(String::new());
                        emit_token = Some(state.token.clone());
                        start_monitor_generation = Some(state.generation);
                        start_monitor_token = Some(state.token.clone());
                        tracing::info!(
                            "Voice wake capture started via trigger-only pause (trigger='{}').",
                            trigger_phrase
                        );
                    }
                    WakePreDetectMode::TextFallback => {
                        let (fallback_trigger, fallback_command) =
                            match Self::text_only_fallback_match(&transcript, &triggers) {
                                Some(value) => value,
                                None => return,
                            };
                        state.active = true;
                        state.generation = state.generation.wrapping_add(1);
                        state.token = format!("wake-{}", state.generation);
                        state.started_at = Some(now);
                        state.last_heard = Some(now);
                        state.cooldown_until = None;
                        state.heard_beyond_trigger = !fallback_command.is_empty();
                        state.trigger_phrase = fallback_trigger.clone();
                        state.captured_transcript = fallback_command.clone();
                        state.committed_transcript = fallback_command.clone();
                        state.volatile_transcript.clear();
                        emit_text = Some(fallback_command.clone());
                        emit_token = Some(state.token.clone());
                        start_monitor_generation = Some(state.generation);
                        start_monitor_token = Some(state.token.clone());
                        tracing::info!(
                            "Voice wake capture started via silence fallback (trigger='{}', initial_len={}).",
                            fallback_trigger,
                            fallback_command.len()
                        );
                    }
                }
            }

            if let Some(text) = emit_text {
                let _ = app.emit(
                    "voice_wake_active",
                    serde_json::json!({
                        "token": emit_token.clone(),
                        "transcript": text,
                        "rawTranscript": transcript,
                        "triggerChime": trigger_chime.clone(),
                    }),
                );
            }

            if let (Some(generation), Some(token)) = (start_monitor_generation, start_monitor_token)
            {
                Self::spawn_wake_capture_monitor(
                    app,
                    wake_capture,
                    gateway,
                    tracker,
                    machine_name,
                    generation,
                    token,
                    trigger_chime,
                    send_chime,
                    session_key,
                );
            }
        });
    }

    async fn finalize_wake_capture(
        app: AppHandle,
        wake_capture: Arc<std::sync::Mutex<WakeCaptureState>>,
        gateway: Arc<GatewayService>,
        tracker: Arc<Mutex<VoiceAgentTracker>>,
        machine_name: Arc<String>,
        generation: u64,
        token: String,
        trigger_chime: String,
        send_chime: String,
        session_key: String,
    ) {
        let final_text = {
            let mut state = match wake_capture.lock() {
                Ok(lock) => lock,
                Err(_) => return,
            };
            if !state.active || state.generation != generation {
                return;
            }

            state.active = false;
            state.cooldown_until = Some(Instant::now() + WAKE_SEND_COOLDOWN);
            state.started_at = None;
            state.last_heard = None;
            state.heard_beyond_trigger = false;
            state.trigger_phrase.clear();
            let text = state.captured_transcript.trim().to_string();
            state.captured_transcript.clear();
            state.committed_transcript.clear();
            state.volatile_transcript.clear();
            text
        };

        if final_text.is_empty() {
            Self::emit_overlay_session_dismissed(&app, Some(token));
            return;
        }

        let _ = app.emit(
            "voice_wake_triggered",
            serde_json::json!({
                "token": token,
                "command": final_text.clone(),
                "triggerChime": trigger_chime,
                "sendChime": send_chime
            }),
        );

        Self::dispatch_agent_command(
            app,
            gateway,
            tracker,
            machine_name,
            "wake",
            final_text,
            session_key,
        )
        .await;
    }

    fn emit_agent_state(
        app: &AppHandle,
        phase: &str,
        source: &str,
        request_id: Option<&str>,
        run_id: Option<&str>,
        stream: Option<&str>,
        text: Option<&str>,
        error: Option<&str>,
    ) {
        let _ = app.emit(
            "voice_agent_state",
            json!({
                "phase": phase,
                "source": source,
                "requestId": request_id,
                "runId": run_id,
                "stream": stream,
                "text": text,
                "error": error,
            }),
        );
    }

    async fn complete_tracked_request(
        tracker: Arc<Mutex<VoiceAgentTracker>>,
        request_id: &str,
    ) -> Option<String> {
        let mut lock = tracker.lock().await;
        let run_id = lock.pending_requests.remove(request_id).flatten();
        if let Some(run_id) = &run_id {
            lock.active_runs.remove(run_id);
        }
        run_id
    }

    async fn complete_tracked_run(tracker: Arc<Mutex<VoiceAgentTracker>>, run_id: &str) -> bool {
        let mut lock = tracker.lock().await;
        let mut removed = lock.active_runs.remove(run_id);
        let request_ids: Vec<String> = lock
            .pending_requests
            .iter()
            .filter_map(|(request_id, mapped_run)| {
                if mapped_run.as_deref() == Some(run_id) {
                    Some(request_id.clone())
                } else {
                    None
                }
            })
            .collect();
        for request_id in request_ids {
            removed = true;
            lock.pending_requests.remove(&request_id);
        }
        removed
    }

    async fn dispatch_agent_command(
        app: AppHandle,
        gateway: Arc<GatewayService>,
        tracker: Arc<Mutex<VoiceAgentTracker>>,
        machine_name: Arc<String>,
        source: &'static str,
        command: String,
        session_key: String,
    ) {
        let command = command.trim().to_string();
        if command.is_empty() {
            return;
        }

        let request_id = format!("vw_agent_{}", Uuid::new_v4().simple());
        let idempotency_key = Uuid::new_v4().simple().to_string();

        {
            let mut lock = tracker.lock().await;
            lock.pending_requests.insert(request_id.clone(), None);
        }

        Self::set_overlay_visible(&app, true);
        Self::emit_agent_state(
            &app,
            "sending",
            source,
            Some(&request_id),
            None,
            None,
            Some(&command),
            None,
        );

        let request = json!({
            "id": request_id,
            "type": "req",
            "method": "agent",
            "params": {
                "message": Self::build_voice_message(machine_name.as_ref(), &command),
                "sessionKey": session_key,
                "thinking": "low",
                "deliver": true,
                "to": "",
                "channel": "last",
                "idempotencyKey": idempotency_key
            }
        });

        let request_id = request["id"].as_str().unwrap_or_default().to_string();
        match gateway.request(request.to_string()).await {
            Ok(payload) => {
                let status = payload
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("accepted");
                let run_id = payload
                    .get("runId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let summary = payload
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(run_id) = &run_id {
                    let mut lock = tracker.lock().await;
                    if let Some(mapped) = lock.pending_requests.get_mut(&request_id) {
                        *mapped = Some(run_id.clone());
                    }
                    lock.active_runs.insert(run_id.clone());
                }

                match status {
                    "accepted" => {
                        Self::emit_agent_state(
                            &app,
                            "accepted",
                            source,
                            Some(&request_id),
                            run_id.as_deref(),
                            None,
                            Some("Thinking..."),
                            None,
                        );
                    }
                    "ok" => {
                        let text = if summary.is_empty() {
                            "Completed."
                        } else {
                            summary.as_str()
                        };
                        let _ = Self::complete_tracked_request(tracker.clone(), &request_id).await;
                        Self::emit_agent_state(
                            &app,
                            "final",
                            source,
                            Some(&request_id),
                            run_id.as_deref(),
                            None,
                            Some(text),
                            None,
                        );
                    }
                    "error" => {
                        let error_text = if summary.is_empty() {
                            "Voice agent request failed."
                        } else {
                            summary.as_str()
                        };
                        let _ = Self::complete_tracked_request(tracker.clone(), &request_id).await;
                        Self::emit_agent_state(
                            &app,
                            "error",
                            source,
                            Some(&request_id),
                            run_id.as_deref(),
                            None,
                            None,
                            Some(error_text),
                        );
                    }
                    _ => {
                        Self::emit_agent_state(
                            &app,
                            "accepted",
                            source,
                            Some(&request_id),
                            run_id.as_deref(),
                            None,
                            Some("Thinking..."),
                            None,
                        );
                    }
                }
            }
            Err(err) => {
                let _ = Self::complete_tracked_request(tracker.clone(), &request_id).await;
                let error_text = err.to_string();
                tracing::error!("Failed to send voice agent request: {}", error_text);
                Self::emit_agent_state(
                    &app,
                    "error",
                    source,
                    Some(&request_id),
                    None,
                    None,
                    None,
                    Some(&error_text),
                );
            }
        }
    }

    async fn handle_gateway_agent_event(
        &self,
        app: AppHandle,
        payload: serde_json::Value,
    ) -> crate::error::Result<()> {
        let run_id = payload
            .get("runId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if run_id.is_empty() {
            return Ok(());
        }

        let is_tracked_run = {
            let mut lock = self.agent_tracker.lock().await;
            if lock.active_runs.contains(&run_id) {
                true
            } else {
                let unbound: Vec<String> = lock
                    .pending_requests
                    .iter()
                    .filter_map(|(request_id, mapped_run)| {
                        if mapped_run.is_none() {
                            Some(request_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect();

                if unbound.len() == 1 {
                    let request_id = unbound[0].clone();
                    if let Some(mapped) = lock.pending_requests.get_mut(&request_id) {
                        *mapped = Some(run_id.clone());
                    }
                    lock.active_runs.insert(run_id.clone());
                    true
                } else {
                    false
                }
            }
        };
        if !is_tracked_run {
            return Ok(());
        }

        let stream = payload
            .get("stream")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let summary = payload
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let data = payload
            .get("data")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        if stream == "assistant" {
            let text = data
                .get("text")
                .and_then(|v| v.as_str())
                .or_else(|| data.get("delta").and_then(|v| v.as_str()))
                .unwrap_or_default()
                .to_string();
            if !text.is_empty() {
                Self::emit_agent_state(
                    &app,
                    "stream",
                    "voice",
                    None,
                    Some(&run_id),
                    Some(stream),
                    Some(&text),
                    None,
                );
            }
            return Ok(());
        }

        if stream == "lifecycle" {
            let phase = data
                .get("phase")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if phase == "error" {
                let error_text = data
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| {
                        if summary.is_empty() {
                            "Voice agent run failed."
                        } else {
                            summary.as_str()
                        }
                    })
                    .to_string();
                let _ = Self::complete_tracked_run(self.agent_tracker.clone(), &run_id).await;
                Self::emit_agent_state(
                    &app,
                    "error",
                    "voice",
                    None,
                    Some(&run_id),
                    Some(stream),
                    None,
                    Some(&error_text),
                );
            } else if phase == "end" {
                let text = if summary.is_empty() {
                    "Completed."
                } else {
                    summary.as_str()
                };
                let _ = Self::complete_tracked_run(self.agent_tracker.clone(), &run_id).await;
                Self::emit_agent_state(
                    &app,
                    "final",
                    "voice",
                    None,
                    Some(&run_id),
                    Some(stream),
                    Some(text),
                    None,
                );
            }
            return Ok(());
        }

        if stream == "tool" {
            let phase = data
                .get("phase")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let name = data
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !phase.is_empty() || !name.is_empty() {
                let label = if phase.is_empty() {
                    format!("Tool: {}", name)
                } else if name.is_empty() {
                    format!("Tool {}", phase)
                } else {
                    format!("Tool {} {}", phase, name)
                };
                Self::emit_agent_state(
                    &app,
                    "stream",
                    "voice",
                    None,
                    Some(&run_id),
                    Some(stream),
                    Some(&label),
                    None,
                );
            }
        }

        Ok(())
    }

    async fn handle_gateway_response(
        &self,
        app: AppHandle,
        frame: serde_json::Value,
    ) -> crate::error::Result<()> {
        let request_id = frame
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if request_id.is_empty() {
            return Ok(());
        }

        let is_tracked = {
            let lock = self.agent_tracker.lock().await;
            lock.pending_requests.contains_key(&request_id)
        };
        if !is_tracked {
            return Ok(());
        }

        let payload = frame
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let ok = frame.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        let status = payload
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let run_id = payload
            .get("runId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let summary = payload
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if status == "accepted" || (ok && status.is_empty()) {
            if let Some(run_id) = &run_id {
                let mut lock = self.agent_tracker.lock().await;
                if let Some(mapped) = lock.pending_requests.get_mut(&request_id) {
                    *mapped = Some(run_id.clone());
                }
                lock.active_runs.insert(run_id.clone());
            }
            Self::emit_agent_state(
                &app,
                "accepted",
                "voice",
                Some(&request_id),
                run_id.as_deref(),
                None,
                Some("Thinking..."),
                None,
            );
            return Ok(());
        }

        if status == "ok" {
            let _ = Self::complete_tracked_request(self.agent_tracker.clone(), &request_id).await;
            let text = if summary.is_empty() {
                "Completed."
            } else {
                summary.as_str()
            };
            Self::emit_agent_state(
                &app,
                "final",
                "voice",
                Some(&request_id),
                run_id.as_deref(),
                None,
                Some(text),
                None,
            );
            return Ok(());
        }

        if status == "error" || !ok {
            let error_text = frame
                .get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .or_else(|| frame.get("error").and_then(|v| v.as_str()))
                .unwrap_or_else(|| {
                    if summary.is_empty() {
                        "Voice agent request failed."
                    } else {
                        summary.as_str()
                    }
                })
                .to_string();
            let _ = Self::complete_tracked_request(self.agent_tracker.clone(), &request_id).await;
            Self::emit_agent_state(
                &app,
                "error",
                "voice",
                Some(&request_id),
                run_id.as_deref(),
                None,
                None,
                Some(&error_text),
            );
        }

        Ok(())
    }

    async fn apply_enabled(
        &self,
        app: AppHandle,
        enabled: bool,
        persist_setting: bool,
    ) -> crate::error::Result<()> {
        let currently_enabled = {
            let is_enabled = self.is_enabled.lock().await;
            *is_enabled
        };
        if currently_enabled == enabled {
            return Ok(());
        }

        if enabled {
            if persist_setting {
                // Persist explicit UI enable/disable actions.
                self.config.update(|c| c.voice_wake_enabled = true).await?;
            }

            let app_clone = app.clone();
            let gateway_clone = self.gateway.clone();
            let config_clone = self.config.clone();
            let tracker_clone = self.agent_tracker.clone();
            let ptt_active_flag = self.ptt_active.clone();
            let ptt_latest_transcript = self.ptt_latest_transcript.clone();
            let ptt_last_ui_transcript = self.ptt_last_ui_transcript.clone();
            let ptt_commit_sender = self.ptt_commit_sender.clone();
            let ptt_adopted_prefix = self.ptt_adopted_prefix.clone();
            let ptt_session_token = self.ptt_session_token.clone();
            let wake_capture = self.wake_capture.clone();
            let wake_pre_detect = self.wake_pre_detect.clone();
            let machine_name = self.machine_name.clone();

            let start_result: crate::error::Result<()> = async {
                let config = config_clone.load().await?;
                let options = crate::providers::speech::RecognitionOptions {
                    mic_id: if config.voice_wake_mic_id.is_empty() {
                        None
                    } else {
                        Some(config.voice_wake_mic_id.clone())
                    },
                    locale: if config.voice_wake_locale.is_empty() {
                        None
                    } else {
                        Some(config.voice_wake_locale.clone())
                    },
                };

                // Snapshot config values before moving into the sync callback.
                // Avoids block_on inside the speech callback which could deadlock.
                let triggers_snap = Self::sanitize_triggers(config.voice_wake_triggers.clone());
                let trigger_chime_snap = config.voice_wake_trigger_chime.clone();
                let send_chime_snap = config.voice_wake_send_chime.clone();
                let session_key_snap = Self::normalize_session_key(&config.voice_wake_session_key);

                // Start hardware monitoring
                self.start_level_monitor(app.clone()).await;

                // Start listening
                self.provider
                    .start_recognition(
                        options,
                        Box::new(move |event| {
                            if event.session_completed {
                                tracing::warn!(
                                    "Voice recognizer session completed (status={:?}); scheduling restart.",
                                    event.status
                                );
                                let app_for_restart = app_clone.clone();
                                tauri::async_runtime::spawn_blocking(move || {
                                    tauri::async_runtime::block_on(async move {
                                        let service = app_for_restart
                                            .state::<Arc<VoiceWakeService>>()
                                            .inner()
                                            .clone();
                                        service
                                            .recover_recognition_session(app_for_restart.clone())
                                            .await;
                                    });
                                });
                                return;
                            }

                            let transcript = event.transcript.trim().to_string();
                            tracing::info!(
                                "Voice recognizer callback (is_final={}, len={})",
                                event.is_final,
                                transcript.len()
                            );
                            if !transcript.trim().is_empty() {
                                if let Ok(mut latest) = ptt_latest_transcript.lock() {
                                    *latest = transcript.clone();
                                }
                            }

                            let mut sent_to_ptt_commit = false;
                            if !transcript.trim().is_empty() {
                                if let Ok(mut sender_slot) = ptt_commit_sender.lock() {
                                    if let Some(sender) = sender_slot.take() {
                                        let _ = sender.send(transcript.clone());
                                        sent_to_ptt_commit = true;
                                    }
                                }
                            }
                            if sent_to_ptt_commit {
                                tracing::info!(
                                    "PTT commit receiver fulfilled from recognizer callback (len={})",
                                    transcript.len()
                                );
                                return;
                            }

                            let is_ptt_active = ptt_active_flag.load(Ordering::SeqCst);
                            if is_ptt_active {
                                let prefix = ptt_adopted_prefix
                                    .lock()
                                    .map(|v| v.clone())
                                    .unwrap_or_default();
                                let token = ptt_session_token
                                    .lock()
                                    .map(|v| v.clone())
                                    .unwrap_or_default();
                                let ui_text = Self::join_prefix(&prefix, &transcript);
                                if !ui_text.is_empty() {
                                    if let Ok(mut latest_ui) = ptt_last_ui_transcript.lock() {
                                        *latest_ui = ui_text.clone();
                                    }
                                    let _ = app_clone.emit(
                                        "voice_wake_active",
                                        serde_json::json!({
                                            "token": if token.is_empty() { None::<String> } else { Some(token) },
                                            "transcript": ui_text,
                                            "rawTranscript": transcript,
                                            "triggerChime": "None"
                                        }),
                                    );
                                }
                                return;
                            }

                            if transcript.is_empty() {
                                return;
                            }

                            let now = Instant::now();
                            let mut emit_text: Option<String> = None;
                            let mut emit_token: Option<String> = None;
                            let mut start_monitor_generation: Option<u64> = None;
                            let mut start_monitor_token: Option<String> = None;
                            let mut schedule_pre_detect: Option<WakePreDetectMode> = None;
                            let mut pre_detect_revision: u64 = 0;

                            if let Ok(mut state) = wake_capture.lock() {
                                if !state.active
                                    && state
                                        .cooldown_until
                                        .is_some_and(|until| now < until)
                                {
                                    return;
                                }

                                if state.active {
                                    state.last_heard = Some(now);
                                    let next_command = Self::command_after_trigger(
                                        &transcript,
                                        &state.trigger_phrase,
                                    );
                                    if !next_command.trim().is_empty() {
                                        state.heard_beyond_trigger = true;
                                    }
                                    state.captured_transcript = next_command.clone();
                                    if event.is_final {
                                        state.committed_transcript = next_command.clone();
                                        state.volatile_transcript.clear();
                                    } else {
                                        state.volatile_transcript = Self::delta_after(
                                            &state.committed_transcript,
                                            &next_command,
                                        );
                                    }
                                    emit_text = Some(Self::join_parts(
                                        &state.committed_transcript,
                                        &state.volatile_transcript,
                                    ));
                                    emit_token = Some(state.token.clone());
                                } else if let Some(trigger) =
                                    Self::longest_matching_trigger(&transcript, &triggers_snap)
                                {
                                    let initial_command =
                                        Self::command_after_trigger(&transcript, trigger);
                                    state.active = true;
                                    state.generation = state.generation.wrapping_add(1);
                                    state.token = format!("wake-{}", state.generation);
                                    state.started_at = Some(now);
                                    state.last_heard = Some(now);
                                    state.cooldown_until = None;
                                    state.heard_beyond_trigger = !initial_command.is_empty();
                                    state.trigger_phrase = trigger.to_string();
                                    state.captured_transcript = initial_command.clone();
                                    if event.is_final {
                                        state.committed_transcript = initial_command.clone();
                                        state.volatile_transcript.clear();
                                    } else {
                                        state.committed_transcript.clear();
                                        state.volatile_transcript = initial_command.clone();
                                    }
                                    emit_text = Some(Self::join_parts(
                                        &state.committed_transcript,
                                        &state.volatile_transcript,
                                    ));
                                    emit_token = Some(state.token.clone());
                                    start_monitor_generation = Some(state.generation);
                                    start_monitor_token = Some(state.token.clone());
                                    tracing::info!(
                                        "Voice wake capture started (trigger='{}', initial_len={})",
                                        trigger,
                                        initial_command.len()
                                    );
                                } else if event.is_final {
                                    if let Some((fallback_trigger, fallback_command)) =
                                        Self::text_only_fallback_match(&transcript, &triggers_snap)
                                    {
                                        state.active = true;
                                        state.generation = state.generation.wrapping_add(1);
                                        state.token = format!("wake-{}", state.generation);
                                        state.started_at = Some(now);
                                        state.last_heard = Some(now);
                                        state.cooldown_until = None;
                                        state.heard_beyond_trigger = !fallback_command.is_empty();
                                        state.trigger_phrase = fallback_trigger.clone();
                                        state.captured_transcript = fallback_command.clone();
                                        state.committed_transcript = fallback_command.clone();
                                        state.volatile_transcript.clear();
                                        emit_text = Some(fallback_command.clone());
                                        emit_token = Some(state.token.clone());
                                        start_monitor_generation = Some(state.generation);
                                        start_monitor_token = Some(state.token.clone());
                                        tracing::info!(
                                            "Voice wake capture started via text fallback (trigger='{}', initial_len={})",
                                            fallback_trigger,
                                            fallback_command.len()
                                        );
                                    }
                                } else {
                                    pre_detect_revision = Self::note_pre_detect_transcript(
                                        &wake_pre_detect,
                                        transcript.clone(),
                                    );
                                    if let Some(trigger_only) =
                                        Self::is_trigger_only(&transcript, &triggers_snap)
                                    {
                                        schedule_pre_detect =
                                            Some(WakePreDetectMode::TriggerOnly(trigger_only));
                                    } else {
                                        schedule_pre_detect = Some(WakePreDetectMode::TextFallback);
                                    }
                                }
                            }

                            if start_monitor_generation.is_some() {
                                Self::reset_pre_detect(&wake_pre_detect);
                            }

                            if let Some(text) = emit_text {
                                let _ = app_clone.emit(
                                    "voice_wake_active",
                                    serde_json::json!({
                                        "token": emit_token.clone(),
                                        "transcript": text,
                                        "rawTranscript": transcript.clone(),
                                        "triggerChime": trigger_chime_snap.clone(),
                                    }),
                                );
                            }

                            if let (Some(generation), Some(token)) =
                                (start_monitor_generation, start_monitor_token)
                            {
                                Self::spawn_wake_capture_monitor(
                                    app_clone.clone(),
                                    wake_capture.clone(),
                                    gateway_clone.clone(),
                                    tracker_clone.clone(),
                                    machine_name.clone(),
                                    generation,
                                    token,
                                    trigger_chime_snap.clone(),
                                    send_chime_snap.clone(),
                                    session_key_snap.clone(),
                                );
                            }

                            if let Some(mode) = schedule_pre_detect {
                                if pre_detect_revision != 0 {
                                    Self::spawn_pre_detect_monitor(
                                        app_clone.clone(),
                                        wake_capture.clone(),
                                        wake_pre_detect.clone(),
                                        gateway_clone.clone(),
                                        tracker_clone.clone(),
                                        machine_name.clone(),
                                        pre_detect_revision,
                                        mode,
                                        triggers_snap.clone(),
                                        trigger_chime_snap.clone(),
                                        send_chime_snap.clone(),
                                        session_key_snap.clone(),
                                    );
                                }
                            }
                        }),
                    )
                    .await?;

                Ok(())
            }
            .await;

            match start_result {
                Ok(()) => {
                    let mut is_enabled = self.is_enabled.lock().await;
                    *is_enabled = true;
                }
                Err(err) => {
                    // Ensure failed startup leaves no partially enabled state.
                    let _ = self.provider.stop_recognition().await;
                    self.stop_level_monitor().await;
                    self.reset_wake_capture();

                    if persist_setting {
                        if let Err(cfg_err) =
                            self.config.update(|c| c.voice_wake_enabled = false).await
                        {
                            tracing::warn!(
                                "Failed to rollback voice_wake_enabled after startup error: {}",
                                cfg_err
                            );
                        }
                    }

                    let mut is_enabled = self.is_enabled.lock().await;
                    *is_enabled = false;

                    return Err(err);
                }
            }
        } else {
            let mut is_enabled = self.is_enabled.lock().await;
            *is_enabled = false;
            drop(is_enabled);
            self.reset_wake_capture();
            if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
                prefix.clear();
            }
            if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
                latest_ui.clear();
            }
            if let Ok(mut token) = self.ptt_session_token.lock() {
                token.clear();
            }

            self.provider.stop_recognition().await?;
            self.stop_level_monitor().await;

            if persist_setting {
                // Persist explicit UI enable/disable actions.
                self.config.update(|c| c.voice_wake_enabled = false).await?;
            }
        }
        Ok(())
    }

    pub async fn set_enabled(&self, app: AppHandle, enabled: bool) -> crate::error::Result<()> {
        self.apply_enabled(app, enabled, true).await
    }

    fn set_overlay_visible(app: &AppHandle, visible: bool) {
        if let Some(window) = app.get_webview_window("voice_overlay") {
            if visible {
                let _ = window.set_effects(Some(WindowEffectsConfig {
                    effects: vec![Effect::Mica],
                    ..Default::default()
                }));
                let _ = window.show();
                let _ = window.center();
            } else {
                let _ = window.hide();
            }
        }
    }

    async fn recover_recognition_session(&self, app: AppHandle) {
        if self
            .recognition_recovery_inflight
            .swap(true, Ordering::SeqCst)
        {
            return;
        }

        let should_recover = {
            let is_enabled = self.is_enabled.lock().await;
            *is_enabled
        };
        if !should_recover {
            self.recognition_recovery_inflight
                .store(false, Ordering::SeqCst);
            return;
        }

        tracing::warn!("Recovering Windows speech recognizer session after completion.");
        if let Err(err) = self.apply_enabled(app.clone(), false, false).await {
            tracing::warn!("Recognizer recovery stop step failed: {}", err);
        }
        if let Err(err) = self.apply_enabled(app, true, false).await {
            tracing::error!("Recognizer recovery start step failed: {}", err);
        }

        self.recognition_recovery_inflight
            .store(false, Ordering::SeqCst);
    }

    fn emit_ptt_state(
        app: &AppHandle,
        active: bool,
        error: Option<String>,
        keep_visible: bool,
        token: Option<String>,
    ) {
        let _ = app.emit(
            "voice_ptt_state",
            json!({
                "active": active,
                "error": error,
                "keepVisible": keep_visible,
                "token": token
            }),
        );
    }

    fn emit_overlay_session_dismissed(app: &AppHandle, token: Option<String>) {
        let _ = app.emit(
            "voice_overlay_session_dismissed",
            json!({
                "token": token
            }),
        );
    }

    async fn set_ptt_active(&self, app: AppHandle, active: bool) -> crate::error::Result<()> {
        if active {
            tracing::info!("PTT activation started.");
            // Press-to-talk should start listening without rewriting persisted voice wake state.
            self.ptt_active.store(true, Ordering::SeqCst);
            let adopted_prefix = {
                if let Ok(state) = self.wake_capture.lock() {
                    if state.active {
                        Self::join_parts(&state.committed_transcript, &state.volatile_transcript)
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            };
            let ptt_token = format!("ptt-{}", Uuid::new_v4().simple());
            if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
                *prefix = adopted_prefix.clone();
            }
            if let Ok(mut token_slot) = self.ptt_session_token.lock() {
                *token_slot = ptt_token.clone();
            }
            self.reset_wake_capture();
            if let Ok(mut latest) = self.ptt_latest_transcript.lock() {
                latest.clear();
            }
            if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
                latest_ui.clear();
            }
            if let Ok(mut sender_slot) = self.ptt_commit_sender.lock() {
                sender_slot.take();
            }

            let was_enabled = {
                let enabled_lock = self.is_enabled.lock().await;
                *enabled_lock
            };
            if was_enabled {
                tracing::info!("PTT forcing recognizer refresh before capture.");
                let _ = self.apply_enabled(app.clone(), false, false).await;
            }

            Self::set_overlay_visible(&app, true);
            Self::emit_ptt_state(&app, true, None, false, Some(ptt_token.clone()));
            if !adopted_prefix.is_empty() {
                let _ = app.emit(
                    "voice_wake_active",
                    serde_json::json!({
                        "token": ptt_token,
                        "transcript": adopted_prefix,
                        "rawTranscript": "",
                        "triggerChime": "None"
                    }),
                );
            }
            match self.apply_enabled(app.clone(), true, false).await {
                Ok(()) => {
                    tracing::info!("PTT activation ready.");
                    return Ok(());
                }
                Err(err) => {
                    self.ptt_active.store(false, Ordering::SeqCst);
                    tracing::warn!("PTT activation failed: {}", err);
                    Self::emit_ptt_state(&app, false, Some(err.to_string()), false, None);
                    if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
                        prefix.clear();
                    }
                    if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
                        latest_ui.clear();
                    }
                    if let Ok(mut token_slot) = self.ptt_session_token.lock() {
                        token_slot.clear();
                    }
                    Self::set_overlay_visible(&app, false);
                    return Err(err);
                }
            }
        }

        tracing::info!("PTT release received.");
        self.ptt_active.store(false, Ordering::SeqCst);
        let mut transcript = if let Ok(mut latest) = self.ptt_latest_transcript.lock() {
            let value = latest.trim().to_string();
            if !value.is_empty() {
                latest.clear();
            }
            value
        } else {
            String::new()
        };
        if !transcript.is_empty() {
            tracing::info!(
                "PTT captured transcript from cached partial (len={})",
                transcript.len()
            );
        }

        if transcript.is_empty() {
            let (tx, rx) = oneshot::channel::<String>();
            if let Ok(mut sender_slot) = self.ptt_commit_sender.lock() {
                sender_slot.take();
                *sender_slot = Some(tx);
            }
            let token = self
                .ptt_session_token
                .lock()
                .map(|v| v.clone())
                .ok()
                .filter(|v| !v.is_empty());
            Self::emit_ptt_state(&app, false, None, true, token);
            tracing::info!("PTT waiting for trailing recognition callback...");

            match tokio::time::timeout(std::time::Duration::from_millis(1500), rx).await {
                Ok(Ok(value)) => {
                    transcript = value.trim().to_string();
                    tracing::info!(
                        "PTT received trailing recognition callback (len={})",
                        transcript.len()
                    );
                }
                Ok(Err(_)) => tracing::warn!("PTT trailing recognition channel closed."),
                Err(_) => tracing::warn!("PTT trailing recognition wait timed out."),
            }

            if let Ok(mut sender_slot) = self.ptt_commit_sender.lock() {
                sender_slot.take();
            }

            if transcript.is_empty() {
                transcript = if let Ok(mut latest) = self.ptt_latest_transcript.lock() {
                    let value = latest.trim().to_string();
                    if !value.is_empty() {
                        latest.clear();
                    }
                    value
                } else {
                    String::new()
                };
                if !transcript.is_empty() {
                    tracing::info!(
                        "PTT recovered transcript from latest fallback (len={})",
                        transcript.len()
                    );
                }
            }
        }

        let adopted_prefix = self
            .ptt_adopted_prefix
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default();
        let token = self
            .ptt_session_token
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default();
        let mut final_transcript = Self::join_prefix(&adopted_prefix, &transcript);
        if final_transcript.is_empty() {
            final_transcript = self
                .ptt_last_ui_transcript
                .lock()
                .map(|v| v.trim().to_string())
                .unwrap_or_default();
            if !final_transcript.is_empty() {
                tracing::info!(
                    "PTT recovered transcript from UI fallback (len={})",
                    final_transcript.len()
                );
            }
        }
        let config = self.config.load().await?;
        let session_key = Self::normalize_session_key(&config.voice_wake_session_key);
        let send_chime = config.voice_wake_send_chime.clone();

        let should_send = !final_transcript.is_empty();
        Self::emit_ptt_state(
            &app,
            false,
            None,
            should_send,
            if token.is_empty() {
                None
            } else {
                Some(token.clone())
            },
        );
        if !should_send {
            tracing::info!("PTT produced empty transcript; dismissing overlay.");
            Self::emit_overlay_session_dismissed(
                &app,
                if token.is_empty() {
                    None
                } else {
                    Some(token.clone())
                },
            );
        }

        if should_send {
            tracing::info!(
                "PTT sending transcript to agent (len={}, adopted_prefix_len={})",
                final_transcript.len(),
                adopted_prefix.len()
            );
            let _ = app.emit(
                "voice_wake_triggered",
                serde_json::json!({
                    "token": if token.is_empty() { None::<String> } else { Some(token.clone()) },
                    "command": final_transcript.clone(),
                    "triggerChime": "None",
                    "sendChime": send_chime
                }),
            );

            let gw = self.gateway.clone();
            let tracker = self.agent_tracker.clone();
            let machine = self.machine_name.clone();
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                Self::dispatch_agent_command(
                    app_handle,
                    gw,
                    tracker,
                    machine,
                    "ptt",
                    final_transcript,
                    session_key,
                )
                .await;
            });
        }
        if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
            prefix.clear();
        }
        if let Ok(mut token_slot) = self.ptt_session_token.lock() {
            token_slot.clear();
        }
        if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
            latest_ui.clear();
        }
        self.set_wake_cooldown(WAKE_SEND_COOLDOWN);

        // On key release, only stop if persistent voice wake is disabled.
        // If the user explicitly enabled voice wake, keep it running.
        if config.voice_wake_enabled {
            return Ok(());
        }

        self.apply_enabled(app, false, false).await
    }

    async fn start_level_monitor(&self, app: AppHandle) {
        let mut task_lock = self.level_monitor_task.lock().await;
        if task_lock.is_some() {
            return;
        }

        let config_clone = self.config.clone();
        let app_handle = app.clone();

        let handle = tokio::task::spawn(async move {
            loop {
                let config = match config_clone.load().await {
                    Ok(c) => c,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                };

                let device_name = config.voice_wake_mic_id.clone();
                let app_emit = app_handle.clone();

                // cpal types are not Send, so we spawn a blocking thread to handle the audio stream.
                // We use a channel to keep the stream alive until the tokio task is cancelled.
                let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

                let thread_handle = std::thread::spawn(move || {
                    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
                    let host = cpal::default_host();

                    let device = if device_name.is_empty() {
                        host.default_input_device()
                    } else {
                        host.input_devices().ok().and_then(|mut ds| {
                            ds.find(|d| d.name().ok() == Some(device_name.clone()))
                        })
                    };

                    if let Some(device) = device {
                        let stream_config: cpal::StreamConfig = match device.default_input_config()
                        {
                            Ok(c) => c.into(),
                            Err(_) => return,
                        };

                        let stream = device.build_input_stream(
                            &stream_config,
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                let mut sum_sq = 0.0f32;
                                for &sample in data {
                                    sum_sq += sample * sample;
                                }
                                let rms = if data.is_empty() {
                                    0.0
                                } else {
                                    (sum_sq / data.len() as f32).sqrt()
                                };
                                let _ = app_emit.emit("voice_audio_level", json!({ "level": rms }));
                            },
                            |err| tracing::error!("Audio level stream error: {}", err),
                            None,
                        );

                        if let Ok(s) = stream {
                            let _ = s.play();
                            // Block until the stop signal arrives
                            let _ = stop_rx.recv();
                        }
                    }
                });

                // Wait for a while, then stop the audio thread
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let _ = stop_tx.send(());
                let _ = thread_handle.join();

                // Brief pause before restarting the monitor
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });

        *task_lock = Some(handle);
    }

    async fn stop_level_monitor(&self) {
        let mut task_lock = self.level_monitor_task.lock().await;
        if let Some(handle) = task_lock.take() {
            handle.abort();
        }
    }

    async fn refresh_from_gateway(&self) -> crate::error::Result<()> {
        let req = json!({
            "id": format!("vw_get_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()),
            "type": "req",
            "method": "voicewake.get",
            "params": {}
        });

        match self.gateway.request(req.to_string()).await {
            Ok(res) => {
                if let Some(triggers) = res.get("triggers").and_then(|v| v.as_array()) {
                    let triggers: Vec<String> = triggers
                        .iter()
                        .filter_map(|t| t.as_str().map(|s| s.to_string()))
                        .collect();
                    self.apply_global_triggers(triggers).await?;
                }
            }
            Err(e) => tracing::warn!("Failed to fetch triggers from gateway: {}", e),
        }
        Ok(())
    }

    async fn apply_global_triggers(&self, triggers: Vec<String>) -> crate::error::Result<()> {
        let sanitized = Self::sanitize_triggers(triggers);
        self.suppress_sync
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let update_result = self
            .config
            .update(|c| c.voice_wake_triggers = sanitized)
            .await;
        self.suppress_sync
            .store(false, std::sync::atomic::Ordering::SeqCst);
        update_result?;
        Ok(())
    }

    pub async fn sync_to_gateway(&self, triggers: Vec<String>) -> crate::error::Result<()> {
        if self.suppress_sync.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }

        let req = json!({
            "id": format!("vw_set_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()),
            "type": "req",
            "method": "voicewake.set",
            "params": {
                "triggers": triggers
                            }
        });

        let _ = self.gateway.request(req.to_string()).await.map_err(|e| {
            tracing::error!("Failed to sync triggers to gateway: {}", e);
        });
        Ok(())
    }

    pub async fn update_ptt_shortcut(&self, app: AppHandle) -> crate::error::Result<()> {
        let config = self.config.load().await?;
        let shortcut_manager = app.global_shortcut();

        // Unregister all first to be clean
        let _ = shortcut_manager.unregister_all();

        if config.voice_wake_ptt_enabled && !config.voice_wake_ptt_key.is_empty() {
            let shortcut = match config.voice_wake_ptt_key.parse::<Shortcut>() {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!(
                        "Invalid PTT shortcut '{}': {}",
                        config.voice_wake_ptt_key,
                        err
                    );
                    return Ok(());
                }
            };

            let service = app.state::<Arc<VoiceWakeService>>().inner().clone();
            let app_handle = app.clone();

            shortcut_manager
                .on_shortcut(shortcut, move |_app, _shortcut, event| {
                    let s = service.clone();
                    let a = app_handle.clone();
                    match event.state() {
                        ShortcutState::Pressed => {
                            tracing::info!("PTT hotkey pressed");
                            tauri::async_runtime::spawn(async move {
                                if let Err(err) = s.set_ptt_active(a, true).await {
                                    tracing::error!("PTT press failed: {}", err);
                                }
                            });
                        }
                        ShortcutState::Released => {
                            tracing::info!("PTT hotkey released");
                            tauri::async_runtime::spawn(async move {
                                if let Err(err) = s.set_ptt_active(a, false).await {
                                    tracing::error!("PTT release failed: {}", err);
                                }
                            });
                        }
                    }
                })
                .map_err(|e| {
                    crate::error::OpenClawError::Internal(format!(
                        "Failed to register PTT shortcut: {}",
                        e
                    ))
                })?;

            tracing::info!("Registered PTT shortcut: {}", config.voice_wake_ptt_key);
        }
        Ok(())
    }

    async fn send_overlay_transcript(
        &self,
        app: AppHandle,
        token: Option<String>,
        transcript: String,
    ) -> crate::error::Result<()> {
        let final_text = transcript.trim().to_string();
        if final_text.is_empty() {
            Self::emit_agent_state(
                &app,
                "error",
                "overlay",
                None,
                None,
                None,
                None,
                Some("Type or speak a command before sending."),
            );
            return Ok(());
        }

        let token = token
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let config = self.config.load().await?;
        let session_key = Self::normalize_session_key(&config.voice_wake_session_key);
        let send_chime = config.voice_wake_send_chime.clone();

        let _ = app.emit(
            "voice_wake_triggered",
            serde_json::json!({
                "token": token.clone(),
                "command": final_text.clone(),
                "triggerChime": "None",
                "sendChime": send_chime
            }),
        );

        let gw = self.gateway.clone();
        let tracker = self.agent_tracker.clone();
        let machine = self.machine_name.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            Self::dispatch_agent_command(
                app_handle,
                gw,
                tracker,
                machine,
                "overlay",
                final_text,
                session_key,
            )
            .await;
        });
        self.set_wake_cooldown(WAKE_SEND_COOLDOWN);
        Ok(())
    }

    async fn dismiss_overlay_session(
        &self,
        app: AppHandle,
        token: Option<String>,
    ) -> crate::error::Result<()> {
        let normalized = token
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        if let Ok(mut state) = self.wake_capture.lock() {
            let token_matches = match normalized.as_ref() {
                Some(target) => state.token.as_str() == target.as_str(),
                None => true,
            };
            if state.active && token_matches {
                state.active = false;
                state.cooldown_until = Some(Instant::now() + WAKE_SEND_COOLDOWN);
                state.started_at = None;
                state.last_heard = None;
                state.heard_beyond_trigger = false;
                state.trigger_phrase.clear();
                state.token.clear();
                state.captured_transcript.clear();
                state.committed_transcript.clear();
                state.volatile_transcript.clear();
            }
        }

        let ptt_token_matches = {
            let current = self
                .ptt_session_token
                .lock()
                .map(|v| v.clone())
                .unwrap_or_default();
            match normalized.as_ref() {
                Some(target) => !current.is_empty() && current == *target,
                None => true,
            }
        };
        if self.ptt_active.load(Ordering::SeqCst) && ptt_token_matches {
            self.ptt_active.store(false, Ordering::SeqCst);
            if let Ok(mut latest) = self.ptt_latest_transcript.lock() {
                latest.clear();
            }
            if let Ok(mut sender_slot) = self.ptt_commit_sender.lock() {
                sender_slot.take();
            }
            if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
                prefix.clear();
            }
            if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
                latest_ui.clear();
            }
            if let Ok(mut token_slot) = self.ptt_session_token.lock() {
                token_slot.clear();
            }
            Self::emit_ptt_state(&app, false, None, false, normalized.clone());
            let config = self.config.load().await?;
            if !config.voice_wake_enabled {
                self.apply_enabled(app.clone(), false, false).await?;
            }
        }

        Self::set_overlay_visible(&app, false);
        Ok(())
    }
}

#[async_trait]
impl BackgroundService for VoiceWakeService {
    fn name(&self) -> &'static str {
        "VoiceWakeService"
    }

    async fn start(&self, app: AppHandle) -> anyhow::Result<()> {
        tracing::info!("Starting VoiceWakeService...");
        let config = self.config.load().await?;
        if config.voice_wake_enabled {
            self.apply_enabled(app.clone(), true, false).await.ok();
        }

        let service = app.state::<Arc<VoiceWakeService>>().inner().clone();
        let app_handle = app.clone();

        // Sync triggers once after startup so local state matches gateway state.
        tauri::async_runtime::spawn(async move {
            // Wait briefly for gateway connection before pulling trigger state.
            for _ in 0..5 {
                if let Ok(status) = service.gateway.get_status().await {
                    if status["connected"].as_bool().unwrap_or(false) {
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }

            service.refresh_from_gateway().await.ok();
        });

        // Keep local triggers up to date when gateway broadcasts changes.
        let service = app.state::<Arc<VoiceWakeService>>().inner().clone();
        let app_handle_for_events = app_handle.clone();
        let _ = app_handle.listen("gateway_event", move |event: tauri::Event| {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                if json["event"] == "voicewake.changed" {
                    if let Some(triggers) = json["payload"]["triggers"].as_array() {
                        let triggers: Vec<String> = triggers
                            .iter()
                            .filter_map(|t| t.as_str().map(|s| s.to_string()))
                            .collect();
                        let s = service.clone();
                        tauri::async_runtime::spawn(async move {
                            s.apply_global_triggers(triggers).await.ok();
                        });
                    }
                }

                if json["type"] == "event" && json["event"] == "agent" {
                    if let Some(payload) = json.get("payload") {
                        let s = service.clone();
                        let a = app_handle_for_events.clone();
                        let payload = payload.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = s.handle_gateway_agent_event(a, payload).await {
                                tracing::debug!("voice agent event handling skipped: {}", err);
                            }
                        });
                    }
                }

                if json["type"] == "res" {
                    let s = service.clone();
                    let a = app_handle_for_events.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = s.handle_gateway_response(a, json).await {
                            tracing::debug!("voice response handling skipped: {}", err);
                        }
                    });
                }
            }
        });

        self.update_ptt_shortcut(app.clone()).await.ok();

        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        tracing::info!("Stopping VoiceWakeService...");
        self.reset_wake_capture();
        if let Ok(mut prefix) = self.ptt_adopted_prefix.lock() {
            prefix.clear();
        }
        if let Ok(mut latest_ui) = self.ptt_last_ui_transcript.lock() {
            latest_ui.clear();
        }
        if let Ok(mut token) = self.ptt_session_token.lock() {
            token.clear();
        }
        let _ = self.provider.stop_recognition().await;
        Ok(())
    }
}

#[tauri::command]
pub async fn set_voice_wake_enabled(app: AppHandle, enabled: bool) -> crate::error::Result<()> {
    let service = app.state::<Arc<VoiceWakeService>>();
    service.set_enabled(app.clone(), enabled).await
}

#[tauri::command]
pub async fn get_voice_wake_settings(app: AppHandle) -> crate::error::Result<serde_json::Value> {
    let config_service = app.state::<Arc<ConfigService>>();
    let config = config_service.load().await?;
    let triggers = VoiceWakeService::sanitize_triggers(config.voice_wake_triggers);
    let additional_locales =
        VoiceWakeService::sanitize_locales(config.voice_wake_additional_locale_ids);
    Ok(json!({
        "enabled": config.voice_wake_enabled,
        "triggers": triggers,
        "micId": config.voice_wake_mic_id,
        "locale": config.voice_wake_locale,
        "additionalLocales": additional_locales,
        "triggerChime": config.voice_wake_trigger_chime,
        "sendChime": config.voice_wake_send_chime,
        "sessionKey": config.voice_wake_session_key,
        "pttEnabled": config.voice_wake_ptt_enabled,
        "pttKey": config.voice_wake_ptt_key,
    }))
}

#[tauri::command]
pub async fn set_voice_wake_triggers(
    app: AppHandle,
    triggers: Vec<String>,
) -> crate::error::Result<()> {
    let sanitized = VoiceWakeService::sanitize_triggers(triggers);
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| c.voice_wake_triggers = sanitized.clone())
        .await?;

    let service = app.state::<Arc<VoiceWakeService>>();
    service.sync_to_gateway(sanitized).await?;

    Ok(())
}

#[tauri::command]
pub async fn get_voice_wake_hardware(app: AppHandle) -> crate::error::Result<serde_json::Value> {
    let service = app.state::<Arc<VoiceWakeService>>();
    let mics = service.provider.list_microphones().await?;
    let locales = service.provider.list_locales().await?;
    Ok(json!({
        "microphones": mics,
        "locales": locales,
    }))
}

#[tauri::command]
pub async fn set_voice_wake_hardware(
    app: AppHandle,
    mic_id: String,
    locale: String,
) -> crate::error::Result<()> {
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| {
            c.voice_wake_mic_id = mic_id;
            c.voice_wake_locale = locale;
        })
        .await?;

    // Restart recognition if enabled
    let service = app.state::<Arc<VoiceWakeService>>();
    let enabled = {
        let lock = service.is_enabled.lock().await;
        *lock
    };

    if enabled {
        service.apply_enabled(app.clone(), false, false).await?;
        service.apply_enabled(app.clone(), true, false).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_voice_wake_additional_locales(
    app: AppHandle,
    locales: Vec<String>,
) -> crate::error::Result<()> {
    let normalized = VoiceWakeService::sanitize_locales(locales);
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| {
            c.voice_wake_additional_locale_ids = normalized.clone();
        })
        .await
}

#[tauri::command]
pub async fn set_voice_wake_chimes(
    app: AppHandle,
    trigger_chime: String,
    send_chime: String,
) -> crate::error::Result<()> {
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| {
            c.voice_wake_trigger_chime = trigger_chime;
            c.voice_wake_send_chime = send_chime;
        })
        .await
}

#[tauri::command]
pub async fn set_voice_wake_session_key(
    app: AppHandle,
    session_key: String,
) -> crate::error::Result<()> {
    let next = {
        let trimmed = session_key.trim();
        if trimmed.is_empty() {
            "main".to_string()
        } else {
            trimmed.to_string()
        }
    };
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| {
            c.voice_wake_session_key = next.clone();
        })
        .await
}

#[tauri::command]
pub async fn set_voice_wake_ptt(
    app: AppHandle,
    enabled: bool,
    key: String,
) -> crate::error::Result<()> {
    let config_service = app.state::<Arc<ConfigService>>();
    config_service
        .update(|c| {
            c.voice_wake_ptt_enabled = enabled;
            c.voice_wake_ptt_key = key;
        })
        .await?;

    let service = app.state::<Arc<VoiceWakeService>>();
    service.update_ptt_shortcut(app.clone()).await
}

#[tauri::command]
pub async fn voice_overlay_send(
    app: AppHandle,
    token: Option<String>,
    transcript: String,
) -> crate::error::Result<()> {
    let service = app.state::<Arc<VoiceWakeService>>();
    service
        .send_overlay_transcript(app.clone(), token, transcript)
        .await
}

#[tauri::command]
pub async fn voice_overlay_dismiss(
    app: AppHandle,
    token: Option<String>,
) -> crate::error::Result<()> {
    let service = app.state::<Arc<VoiceWakeService>>();
    service.dismiss_overlay_session(app.clone(), token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_WORD_LENGTH: usize = 64;
    const MAX_WORDS: usize = 32;

    #[test]
    fn test_sanitize_triggers_truncates_long_words() {
        let long_word = "x".repeat(100);
        let triggers = vec![long_word];
        let sanitized = VoiceWakeService::sanitize_triggers(triggers);
        assert_eq!(sanitized[0].len(), MAX_WORD_LENGTH);
    }

    #[test]
    fn test_sanitize_triggers_limits_count() {
        let triggers: Vec<String> = (0..100).map(|i| format!("trigger{}", i)).collect();
        let sanitized = VoiceWakeService::sanitize_triggers(triggers);
        assert!(sanitized.len() <= MAX_WORDS);
    }

    #[test]
    fn test_sanitize_triggers_empty_returns_default() {
        let sanitized = VoiceWakeService::sanitize_triggers(vec![]);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0], "openclaw");
    }

    #[test]
    fn test_sanitize_triggers_removes_whitespace() {
        let triggers = vec!["  trigger  ".to_string(), "  another  ".to_string()];
        let sanitized = VoiceWakeService::sanitize_triggers(triggers);
        assert_eq!(sanitized[0], "trigger");
        assert_eq!(sanitized[1], "another");
    }

    #[test]
    fn test_sanitize_triggers_filters_empty() {
        let triggers = vec!["valid".to_string(), "".to_string(), "   ".to_string()];
        let sanitized = VoiceWakeService::sanitize_triggers(triggers);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0], "valid");
    }

    #[test]
    fn test_sanitize_locales_deduplicates_case_insensitive() {
        let locales = vec![
            "en-US".to_string(),
            "en-us".to_string(),
            "EN-US".to_string(),
        ];
        let sanitized = VoiceWakeService::sanitize_locales(locales);
        // Should deduplicate to just one
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0], "en-US");
    }

    #[test]
    fn test_sanitize_locales_removes_whitespace() {
        let locales = vec!["  fr-FR  ".to_string(), "de-DE".to_string()];
        let sanitized = VoiceWakeService::sanitize_locales(locales);
        assert!(sanitized.contains(&"fr-FR".to_string()));
        assert!(sanitized.contains(&"de-DE".to_string()));
    }

    #[test]
    fn test_sanitize_locales_filters_empty() {
        let locales = vec!["en-US".to_string(), "".to_string(), "   ".to_string()];
        let sanitized = VoiceWakeService::sanitize_locales(locales);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0], "en-US");
    }

    #[test]
    fn test_starts_with_ci_case_insensitive() {
        assert!(VoiceWakeService::starts_with_ci(
            "OPENCLAW run tests",
            "openclaw"
        ));
        assert!(VoiceWakeService::starts_with_ci(
            "OpenClaw run tests",
            "OPENCLAW"
        ));
        assert!(!VoiceWakeService::starts_with_ci("run tests", "openclaw"));
    }

    #[test]
    fn test_longest_matching_trigger() {
        let triggers = vec!["open".to_string(), "openclaw".to_string()];
        let result = VoiceWakeService::longest_matching_trigger("openclaw run tests", &triggers);
        assert_eq!(result, Some("openclaw"));
    }

    #[test]
    fn test_command_after_trigger() {
        let transcript = "openclaw run tests";
        let command = VoiceWakeService::command_after_trigger(transcript, "openclaw");
        assert_eq!(command.trim(), "run tests");
    }

    #[test]
    fn test_command_after_trigger_with_spaces() {
        let transcript = "  openclaw   run   tests  ";
        let command = VoiceWakeService::command_after_trigger(transcript, "openclaw");
        assert!(command.contains("run"));
        assert!(command.contains("tests"));
    }
}
