use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use anyhow::Result;
use serde_json::{json, Value};
use chrono::Utc;
use crate::sessions::types::{SessionStore, SessionEntry};

pub struct SessionManager {
    store_path: String,
}

impl SessionManager {
    pub fn new(store_path: &str) -> Self {
        Self {
            store_path: store_path.to_string(),
        }
    }

    pub fn load_store(&self) -> Result<SessionStore> {
        if !Path::new(&self.store_path).exists() {
            return Ok(SessionStore::default());
        }
        let content = fs::read_to_string(&self.store_path)?;
        let store = serde_json::from_str(&content)?;
        Ok(store)
    }

    pub fn save_store(&self, store: &SessionStore) -> Result<()> {
        let content = serde_json::to_string_pretty(store)?;
        fs::write(&self.store_path, content)?;
        Ok(())
    }

    pub fn list_sessions(&self, agent_id: Option<&str>) -> Result<Vec<Value>> {
        let store = self.load_store()?;
        let mut result = Vec::new();

        for (key, entry) in store.sessions {
            // Filter by agent_id if provided
            if let Some(aid) = agent_id {
                if entry.agent_id.as_deref() != Some(aid) {
                    continue;
                }
            }

            let mut row = json!(entry);
            row["key"] = json!(key);

            // Try to derive title from transcript if missing
            if entry.label.is_none() {
                if let Some(derived) = self.derive_title(&entry.session_id, entry.session_file.as_deref()) {
                    row["derivedTitle"] = json!(derived);
                }
            }

            result.push(row);
        }

        // Sort by updatedAt descending
        result.sort_by(|a, b| {
            let a_ts = a["updatedAt"].as_u64().unwrap_or(0);
            let b_ts = b["updatedAt"].as_u64().unwrap_or(0);
            b_ts.cmp(&a_ts)
        });

        Ok(result)
    }

    fn derive_title(&self, session_id: &str, session_file: Option<&str>) -> Option<String> {
        let path = session_file.map(|s| s.to_string())
            .unwrap_or_else(|| format!("transcripts/{}.jsonl", session_id));

        if let Ok(file) = File::open(&path) {
            let reader = BufReader::new(file);
            if let Some(Ok(line)) = reader.lines().next() {
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                        for block in content {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    let mut title = text.chars().take(60).collect::<String>();
                                    if text.len() > 60 {
                                        title.push('…');
                                    }
                                    return Some(title);
                                }
                            }
                        }
                    } else if let Some(text) = msg.get("text").and_then(|t| t.as_str()) {
                         let mut title = text.chars().take(60).collect::<String>();
                         if text.len() > 60 {
                             title.push('…');
                         }
                         return Some(title);
                    }
                }
            }
        }
        None
    }

    pub fn create_session(&self, agent_id: &str, label: Option<&str>) -> Result<Value> {
        let mut store = self.load_store()?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let session_key = format!("agent:{}:{}", agent_id, session_id);

        let entry = SessionEntry {
            session_id: session_id.clone(),
            updated_at: Utc::now().timestamp_millis() as u64,
            agent_id: Some(agent_id.to_string()),
            label: label.map(|s| s.to_string()),
            session_file: Some(format!("transcripts/{}.jsonl", session_id)),
            ..Default::default()
        };

        store.sessions.insert(session_key.clone(), entry.clone());
        self.save_store(&store)?;

        Ok(json!({
            "sessionKey": session_key,
            "sessionId": session_id,
            "entry": entry
        }))
    }

    pub fn append_to_transcript(&self, session_id: &str, role: &str, text: &str) -> Result<()> {
        let path = format!("transcripts/{}.jsonl", session_id);
        let _ = fs::create_dir_all("transcripts")?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;

        let entry = json!({
            "role": role,
            "content": [{"type": "text", "text": text}],
            "timestamp": Utc::now().timestamp_millis()
        });

        writeln!(file, "{}", entry.to_string())?;
        Ok(())
    }
}
