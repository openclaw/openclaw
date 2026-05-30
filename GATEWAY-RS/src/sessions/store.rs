use std::fs;
use std::path::Path;
use anyhow::Result;
use crate::sessions::types::SessionStore;

pub fn load_session_store(path: &str) -> Result<SessionStore> {
    if !Path::new(path).exists() {
        return Ok(SessionStore::default());
    }
    let content = fs::read_to_string(path)?;
    let store = serde_json::from_str(&content)?;
    Ok(store)
}

pub fn save_session_store(path: &str, store: &SessionStore) -> Result<()> {
    let content = serde_json::to_string_pretty(store)?;
    fs::write(path, content)?;
    Ok(())
}
