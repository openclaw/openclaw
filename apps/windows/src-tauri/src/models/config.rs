use serde::{Deserialize, Serialize};

fn default_schema_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_gateway_mode() -> String {
    "local".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub private_key: Vec<u8>,
    #[serde(default)]
    pub public_key: Vec<u8>,
    #[serde(default)]
    pub device_token: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub gateway_type: String,
    pub ssh_user: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_path: Option<String>,

    #[serde(default)]
    pub is_setup_completed: bool,

    // General Settings
    #[serde(default)]
    pub start_on_login: bool,
    #[serde(default)]
    pub camera_enabled: bool,
    #[serde(default = "default_true")]
    pub canvas_enabled: bool,
    #[serde(default)]
    pub is_paused: bool,
    #[serde(default = "default_gateway_mode")]
    pub gateway_mode: String,
    pub remote_url: Option<String>,
    pub remote_ssh_target: Option<String>,
    pub remote_ssh_identity: Option<String>,
    pub remote_ssh_project_root: Option<String>,
    pub remote_ssh_cli_path: Option<String>,

    // UI / Behaviour
    #[serde(default = "default_true")]
    pub icon_animations_enabled: bool,
    #[serde(default)]
    pub automation_bridge_enabled: bool,
    #[serde(default)]
    pub debug_pane_enabled: bool,

    // Voice Wake
    #[serde(default)]
    pub voice_wake_enabled: bool,
    #[serde(default = "default_triggers")]
    pub voice_wake_triggers: Vec<String>,
    #[serde(default)]
    pub voice_wake_mic_id: String,
    #[serde(default)]
    pub voice_wake_locale: String,
    #[serde(default)]
    pub voice_wake_additional_locale_ids: Vec<String>,
    #[serde(default = "default_chime")]
    pub voice_wake_trigger_chime: String,
    #[serde(default = "default_chime")]
    pub voice_wake_send_chime: String,
    #[serde(default = "default_voice_wake_session_key")]
    pub voice_wake_session_key: String,
    #[serde(default)]
    pub voice_wake_ptt_enabled: bool,
    #[serde(default)]
    pub voice_wake_ptt_key: String,
}

fn default_chime() -> String {
    "Glass".to_string()
}

fn default_triggers() -> Vec<String> {
    vec!["openclaw".to_string()]
}

fn default_voice_wake_session_key() -> String {
    "main".to_string()
}
