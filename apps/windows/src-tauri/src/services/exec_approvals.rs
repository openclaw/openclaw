use crate::models::exec_approvals::{
    ExecAgentSettings, ExecAllowlistEntry, ExecApprovalDecision, ExecApprovalsFile,
    ExecApprovalsSnapshot, ExecAsk, ExecSecurity,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{utils::config::WindowEffectsConfig, window::Effect, AppHandle, Manager};
use tokio::sync::Mutex;

pub struct ExecApprovalsService {
    app: AppHandle,
    lock: Arc<Mutex<()>>,
    pending_prompts: Arc<
        Mutex<
            HashMap<
                String,
                tokio::sync::oneshot::Sender<crate::models::exec_approvals::ExecApprovalDecision>,
            >,
        >,
    >,
}

impl ExecApprovalsService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            lock: Arc::new(Mutex::new(())),
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn prompt_user(
        &self,
        id: String,
        command: String,
        agent_id: Option<&str>,
    ) -> crate::error::Result<crate::models::exec_approvals::ExecApprovalDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut prompts = self.pending_prompts.lock().await;
            prompts.insert(id.clone(), tx);
        }

        // Create standalone window
        let url = format!(
            "/exec-prompt?id={}&command={}{}",
            urlencoding::encode(&id),
            urlencoding::encode(&command),
            agent_id
                .map(|a| format!("&agentId={}", urlencoding::encode(a)))
                .unwrap_or_default()
        );

        let window_label = format!("exec_prompt_{}", id);
        let app_handle = self.app.clone();

        tauri::async_runtime::spawn(async move {
            let _ = tauri::WebviewWindowBuilder::new(
                &app_handle,
                window_label,
                tauri::WebviewUrl::App(url.into()),
            )
            .title("OpenClaw Security Approval")
            .inner_size(400.0, 320.0)
            .resizable(false)
            .always_on_top(true)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .center()
            .effects(WindowEffectsConfig {
                effects: vec![Effect::Mica],
                ..Default::default()
            })
            .build();
        });

        // Wait for response (with timeout)
        let decision = match tokio::time::timeout(tokio::time::Duration::from_secs(300), rx).await {
            Ok(Ok(decision)) => decision,
            _ => crate::models::exec_approvals::ExecApprovalDecision::Deny,
        };

        // Close the window
        let label = format!("exec_prompt_{}", id);
        if let Some(window) = self.app.get_webview_window(&label) {
            let _ = window.close();
        }

        let mut prompts = self.pending_prompts.lock().await;
        prompts.remove(&id);

        Ok(decision)
    }

    pub async fn resolve_prompt(
        &self,
        id: String,
        decision: crate::models::exec_approvals::ExecApprovalDecision,
    ) -> crate::error::Result<()> {
        let mut prompts = self.pending_prompts.lock().await;
        if let Some(tx) = prompts.remove(&id) {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    fn get_path(&self) -> crate::error::Result<PathBuf> {
        self.app
            .path()
            .app_data_dir()
            .map(|d| d.join("exec-approvals.json"))
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to get app data dir: {}", e))
            })
    }

    pub async fn ensure_file(&self) -> crate::error::Result<ExecApprovalsFile> {
        let _guard = self.lock.lock().await;
        let path = self.get_path()?;
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    crate::error::OpenClawError::Internal(format!("Failed to create path: {}", e))
                })?;
            }
            let default = ExecApprovalsFile::default();
            let json = serde_json::to_string_pretty(&default).map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to serialize default: {}", e))
            })?;
            fs::write(&path, json).map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to write file: {}", e))
            })?;
            Ok(default)
        } else {
            let json = fs::read_to_string(&path).map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to read file: {}", e))
            })?;
            let file: ExecApprovalsFile = serde_json::from_str(&json).map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to parse file: {}", e))
            })?;
            Ok(file)
        }
    }

    pub async fn read_snapshot(&self) -> crate::error::Result<ExecApprovalsSnapshot> {
        let path = self.get_path()?;
        if !path.exists() {
            return Ok(ExecApprovalsSnapshot {
                path: path.to_string_lossy().to_string(),
                exists: false,
                hash: "".to_string(),
                file: ExecApprovalsFile::default(),
            });
        }

        let json = fs::read_to_string(&path).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to read file: {}", e))
        })?;

        let mut hasher = Sha256::new();
        hasher.update(json.as_bytes());
        let hash = hex::encode(hasher.finalize());

        let file: ExecApprovalsFile = serde_json::from_str(&json).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to parse file: {}", e))
        })?;

        Ok(ExecApprovalsSnapshot {
            path: path.to_string_lossy().to_string(),
            exists: true,
            hash,
            file,
        })
    }

    pub async fn save_file(&self, file: ExecApprovalsFile) -> crate::error::Result<String> {
        let _guard = self.lock.lock().await;
        let path = self.get_path()?;
        let json = serde_json::to_string_pretty(&file).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to serialize: {}", e))
        })?;
        fs::write(&path, &json).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to write: {}", e))
        })?;

        let mut hasher = Sha256::new();
        hasher.update(json.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }

    pub fn resolve_agent_settings(
        file: &ExecApprovalsFile,
        agent_id: Option<&str>,
    ) -> ExecAgentSettings {
        if let Some(id) = agent_id {
            if let Some(settings) = file.agents.get(id) {
                return settings.clone();
            }
        }
        file.global.clone()
    }

    pub fn match_allowlist(
        allowlist: &[ExecAllowlistEntry],
        command: &str,
    ) -> Option<ExecAllowlistEntry> {
        // Simple exact match or prefix match for now, can be expanded to glob later
        for entry in allowlist {
            if entry.pattern == command || command.starts_with(&format!("{} ", entry.pattern)) {
                return Some(entry.clone());
            }
        }
        None
    }

    pub async fn add_allowlist_entry(
        &self,
        _agent_id: Option<&str>,
        pattern: String,
    ) -> crate::error::Result<()> {
        let mut snapshot = self.read_snapshot().await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let entry = ExecAllowlistEntry {
            pattern,
            created_at: now,
            last_used_at: None,
            use_count: 0,
            description: None,
        };

        snapshot.file.allowlist.push(entry);
        self.save_file(snapshot.file).await?;
        Ok(())
    }

    pub async fn record_use(&self, pattern: &str) -> crate::error::Result<()> {
        let mut snapshot = self.read_snapshot().await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let mut found = false;
        for entry in &mut snapshot.file.allowlist {
            if entry.pattern == pattern {
                entry.last_used_at = Some(now);
                entry.use_count += 1;
                found = true;
                break;
            }
        }

        if found {
            self.save_file(snapshot.file).await?;
        }
        Ok(())
    }

    pub async fn validate_command(
        &self,
        command: &str,
        agent_id: Option<&str>,
    ) -> crate::error::Result<bool> {
        let approvals_file = self.ensure_file().await?;
        let settings = Self::resolve_agent_settings(&approvals_file, agent_id);

        let allowlist_match = if settings.security == ExecSecurity::Allowlist {
            Self::match_allowlist(&approvals_file.allowlist, command)
        } else {
            None
        };

        let needs_ask = match settings.security {
            ExecSecurity::Deny => {
                return Err(crate::error::OpenClawError::Internal(
                    "EXEC_DENIED: security=deny".to_string(),
                ))
            }
            ExecSecurity::Allow => settings.ask == ExecAsk::Always,
            ExecSecurity::Allowlist => {
                if allowlist_match.is_some() {
                    settings.ask == ExecAsk::Always
                } else {
                    settings.ask != ExecAsk::Never
                }
            }
        };

        if needs_ask {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let decision = self.prompt_user(id, command.to_string(), agent_id).await?;
            match decision {
                ExecApprovalDecision::Deny => {
                    return Err(crate::error::OpenClawError::Internal(
                        "EXEC_DENIED: user denied".to_string(),
                    ))
                }
                ExecApprovalDecision::AllowOnce => {
                    return Ok(true);
                }
                ExecApprovalDecision::AllowAlways => {
                    let _ = self
                        .add_allowlist_entry(agent_id, command.to_string())
                        .await;
                    return Ok(true);
                }
            }
        }

        if settings.security == ExecSecurity::Allowlist && allowlist_match.is_none() && !needs_ask {
            return Err(crate::error::OpenClawError::Internal(
                "EXEC_DENIED: allowlist miss".to_string(),
            ));
        }

        // Record use if matched
        if let Some(entry) = allowlist_match {
            let _ = self.record_use(&entry.pattern).await;
        }

        Ok(true)
    }
}

#[tauri::command]
pub async fn resolve_exec_approval_handler(
    app: tauri::AppHandle,
    id: String,
    decision: crate::models::exec_approvals::ExecApprovalDecision,
) -> crate::error::Result<()> {
    let service = app.state::<Arc<ExecApprovalsService>>();
    service.resolve_prompt(id, decision).await
}
