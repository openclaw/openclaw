use std::{
    collections::BTreeMap,
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::{
    access::Session,
    profiles::{GatewayProfile, ProfileCredentials},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

static STATE_IO: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Identity {
    secret_key: String,
    #[serde(default)]
    pub(super) device_tokens: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) access_sessions: BTreeMap<String, Session>,
    #[serde(default)]
    last_gateway_url: Option<String>,
    #[serde(default)]
    pub(super) profiles: Vec<GatewayProfile>,
    #[serde(default)]
    pub(super) primary_profile_id: Option<String>,
    #[serde(default)]
    profiles_migrated: bool,
    #[serde(default)]
    pub(super) profile_credentials: BTreeMap<String, ProfileCredentials>,
    #[serde(default)]
    pub(super) profile_web_scopes: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub(super) web_data_stores: BTreeMap<String, crate::web_data_store::Record>,
    #[serde(default)]
    sidebar_preferences: BTreeMap<String, crate::model::sidebar::SidebarPreferences>,
    #[serde(skip)]
    path: PathBuf,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("secret_key", &"<redacted>")
            .field("device_tokens", &"<redacted>")
            .field("access_sessions", &"<redacted>")
            .finish_non_exhaustive()
    }
}

pub(crate) struct DeviceAuth<'a> {
    pub device_id: &'a str,
    pub client_id: &'a str,
    pub scopes: &'a [&'a str],
    pub signed_at: u64,
    pub token: &'a str,
    pub nonce: &'a str,
    pub platform: &'a str,
    pub device_family: &'a str,
}

impl Identity {
    pub fn load() -> Result<Self, String> {
        Self::load_at(&Self::directory()?)
    }

    pub(crate) fn state_directory(&self) -> &Path {
        self.path.parent().expect("identity path has a state root")
    }

    pub(crate) fn directory() -> Result<PathBuf, String> {
        match std::env::var_os("OPENCLAW_GPUI_STATE_DIR") {
            Some(path) if !path.is_empty() => Ok(PathBuf::from(path)),
            Some(_) => Err("OPENCLAW_GPUI_STATE_DIR must not be empty".into()),
            None => Ok(dirs::config_dir()
                .ok_or("Could not locate the platform config directory")?
                .join("openclaw-gpui")),
        }
    }

    pub fn sidebar_preferences(&self, scope: &str) -> crate::model::sidebar::SidebarPreferences {
        self.sidebar_preferences
            .get(scope)
            .cloned()
            .unwrap_or_default()
    }

    pub fn save_sidebar_preferences(
        &mut self,
        scope: &str,
        prefs: crate::model::sidebar::SidebarPreferences,
    ) -> Result<(), String> {
        self.update(|state| {
            state.sidebar_preferences.insert(scope.to_owned(), prefs);
        })
    }

    pub fn last_gateway_url() -> Result<Option<String>, String> {
        let _guard = STATE_IO.lock().map_err(|_| "App state lock failed")?;
        let path = Self::directory()?.join("identity.json");
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<Self>(&bytes)
                .map(|state| state.last_gateway_url)
                .map_err(|_| "Could not read saved Gateway settings".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Could not read saved Gateway settings".into()),
        }
    }

    pub(crate) fn load_at(directory: &Path) -> Result<Self, String> {
        let _guard = STATE_IO.lock().map_err(|_| "App state lock failed")?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create identity directory: {error}"))?;
        private_permissions(directory, 0o700)?;
        let _file_lock = state_file_lock(directory)?;
        let path = directory.join("identity.json");
        match fs::read(&path) {
            Ok(bytes) => {
                private_permissions(&path, 0o600)?;
                let mut identity: Self = serde_json::from_slice(&bytes).map_err(|_| {
                    "Identity file is invalid; restore its backup before reconnecting".to_owned()
                })?;
                identity.path = path;
                identity.signing_key()?;
                let old_tokens = identity.device_tokens.clone();
                for (url, token) in &old_tokens {
                    if let Ok(normalized) = super::config::normalize_url(url)
                        && normalized != *url
                    {
                        identity
                            .device_tokens
                            .entry(normalized)
                            .or_insert_with(|| token.clone());
                        identity.device_tokens.remove(url);
                    }
                }
                let migrated = !identity.profiles_migrated;
                if migrated {
                    if identity.profiles.is_empty()
                        && let Some(url) = identity.last_gateway_url.as_deref()
                        && let Ok(profile) = GatewayProfile::direct("Gateway", url)
                    {
                        if let Some(origin) = profile.access_origin() {
                            let scope = format!("control:{origin}");
                            if identity.web_data_stores.contains_key(&scope) {
                                identity
                                    .profile_web_scopes
                                    .insert(profile.id.clone(), vec![scope]);
                            }
                        }
                        identity.primary_profile_id = Some(profile.id.clone());
                        identity.profiles.push(profile);
                    }
                    identity.profiles_migrated = true;
                }
                if migrated || identity.device_tokens != old_tokens {
                    identity.save()?;
                }
                Ok(identity)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut secret = [0; 32];
                OsRng
                    .try_fill_bytes(&mut secret)
                    .map_err(|_| "Could not generate a device identity")?;
                let identity = Self {
                    secret_key: URL_SAFE_NO_PAD.encode(secret),
                    device_tokens: BTreeMap::new(),
                    access_sessions: BTreeMap::new(),
                    last_gateway_url: None,
                    profiles: Vec::new(),
                    primary_profile_id: None,
                    profiles_migrated: true,
                    profile_credentials: BTreeMap::new(),
                    profile_web_scopes: BTreeMap::new(),
                    web_data_stores: BTreeMap::new(),
                    sidebar_preferences: BTreeMap::new(),
                    path,
                };
                identity.save()?;
                Ok(identity)
            }
            Err(error) => Err(format!("Could not read identity file: {error}")),
        }
    }

    pub(super) fn web_store_identifier(&self, scope: &str) -> Result<[u8; 16], String> {
        let root = self
            .path
            .parent()
            .ok_or("Missing app state root")?
            .canonicalize()
            .map_err(|_| "Could not resolve the app state root")?;
        Ok(crate::web_data_store::identifier(&root, scope))
    }

    pub(crate) fn record_web_store(&mut self, scope: &str) -> Result<[u8; 16], String> {
        let id = self.web_store_identifier(scope)?;
        let mut valid = false;
        self.update(|state| {
            let record = state.web_data_stores.entry(scope.to_owned()).or_insert(
                crate::web_data_store::Record {
                    identifier: id,
                    pending_removal: false,
                },
            );
            valid = record.identifier == id && !record.pending_removal;
        })?;
        if !valid {
            return Err("This web session is awaiting removal or belongs to another state root. Retry Sign out or run web-store cleanup.".into());
        }
        Ok(id)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn web_store_records(&self) -> BTreeMap<String, crate::web_data_store::Record> {
        self.web_data_stores.clone()
    }

    pub(crate) fn begin_web_store_removal(
        &mut self,
        scope: &str,
    ) -> Result<Option<[u8; 16]>, String> {
        let expected = self.web_store_identifier(scope)?;
        let mut id = None;
        let mut foreign = false;
        self.update(|state| {
            if let Some(record) = state.web_data_stores.get_mut(scope) {
                if record.identifier == expected {
                    record.pending_removal = true;
                    id = Some(record.identifier);
                } else {
                    foreign = true;
                }
            }
        })?;
        if foreign {
            return Err("Refusing to remove a web store belonging to another state root".into());
        }
        Ok(id)
    }

    pub(crate) fn finish_web_store_removal(
        &mut self,
        scope: &str,
        id: [u8; 16],
    ) -> Result<(), String> {
        self.update(|state| {
            if state
                .web_data_stores
                .get(scope)
                .is_some_and(|record| record.identifier == id && record.pending_removal)
            {
                state.web_data_stores.remove(scope);
            }
        })
    }

    pub fn device_token(&self, gateway_url: &str) -> Option<&str> {
        self.device_tokens.get(gateway_url).map(String::as_str)
    }

    pub fn set_device_token_for_profile(
        &mut self,
        profile: Option<&GatewayProfile>,
        gateway_url: &str,
        token: Option<&str>,
    ) -> Result<(), String> {
        self.update_owned(profile, |state| match token {
            Some(token) => {
                state
                    .device_tokens
                    .insert(gateway_url.to_owned(), token.to_owned());
            }
            None => {
                state.device_tokens.remove(gateway_url);
            }
        })
    }

    pub fn access_session(&self, origin: &str) -> Option<&Session> {
        self.access_sessions.get(origin)
    }

    pub fn set_access_session_for_profile(
        &mut self,
        profile: Option<&GatewayProfile>,
        origin: &str,
        session: Option<Session>,
    ) -> Result<(), String> {
        self.update_owned(profile, |state| match session {
            Some(session) => {
                state.access_sessions.insert(origin.to_owned(), session);
            }
            None => {
                state.access_sessions.remove(origin);
            }
        })
    }

    pub fn clear_access_session_if_for_profile(
        &mut self,
        profile: Option<&GatewayProfile>,
        origin: &str,
        expected_token: &str,
    ) -> Result<(), String> {
        self.update_owned(profile, |state| {
            if state
                .access_sessions
                .get(origin)
                .is_some_and(|session| session.token == expected_token)
            {
                state.access_sessions.remove(origin);
            }
        })
    }

    fn update_owned(
        &mut self,
        profile: Option<&GatewayProfile>,
        change: impl FnOnce(&mut Self),
    ) -> Result<(), String> {
        self.try_update(|state| {
            if let Some(profile) = profile
                && !state.profiles.iter().any(|saved| saved.id == profile.id && saved.kind == profile.kind) {
                return Err("This Gateway was removed or its endpoint changed; reopen it from the Gateways menu".into());
            }
            change(state);
            Ok(())
        })
    }

    pub fn remember_gateway(&mut self, url: &str) -> Result<(), String> {
        self.update(|state| state.last_gateway_url = Some(url.to_owned()))
    }

    // Re-read under the same lock as every writer: a retiring connection must not
    // overwrite another Gateway's newly saved session with its old snapshot.
    pub(super) fn update(&mut self, change: impl FnOnce(&mut Self)) -> Result<(), String> {
        self.try_update(|state| {
            change(state);
            Ok(())
        })
    }

    pub(super) fn try_update<T>(
        &mut self,
        change: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = STATE_IO.lock().map_err(|_| "App state lock failed")?;
        let _file_lock = state_file_lock(self.state_directory())?;
        let bytes = fs::read(&self.path).map_err(|_| "Could not read app state for update")?;
        let mut state: Self = serde_json::from_slice(&bytes).map_err(|_| "App state is invalid")?;
        state.path = self.path.clone();
        let result = change(&mut state)?;
        state.save()?;
        *self = state;
        Ok(result)
    }

    pub fn proof(&self, auth: DeviceAuth<'_>) -> Result<Value, String> {
        let key = self.signing_key()?;
        let public_key = key.verifying_key().to_bytes();
        let id = device_id(&public_key);
        let auth = DeviceAuth {
            device_id: &id,
            ..auth
        };
        let signature = key.sign(payload(&auth).as_bytes());
        Ok(json!({
            "id": id,
            "publicKey": URL_SAFE_NO_PAD.encode(public_key),
            "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            "signedAt": auth.signed_at,
            "nonce": auth.nonce,
        }))
    }

    fn signing_key(&self) -> Result<SigningKey, String> {
        let bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&self.secret_key)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("Identity secret key is invalid")?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "Could not serialize identity")?;
        let temporary = self.path.with_extension(format!("{}.tmp", random_id()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Could not save identity: {error}"));
        }
        private_permissions(&self.path, 0o600)
    }
}

pub(super) fn random_id() -> String {
    let mut bytes = [0; 16];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

// A stable inode guards atomic identity.json replacements across GUI/CLI processes.
// The empty lock file contains no app state or credentials.
fn state_file_lock(directory: &Path) -> Result<fs::File, String> {
    let path = directory.join("identity.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|_| "Could not open app state lock")?;
    private_permissions(&path, 0o600)?;
    file.lock().map_err(|_| "Could not lock app state")?;
    Ok(file)
}

fn private_permissions(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Could not secure identity storage: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn device_id(public_key: &[u8; 32]) -> String {
    use fmt::Write as _;
    let mut result = String::with_capacity(64);
    for byte in Sha256::digest(public_key) {
        write!(result, "{byte:02x}").expect("String writes cannot fail");
    }
    result
}

fn payload(auth: &DeviceAuth<'_>) -> String {
    [
        "v3",
        auth.device_id,
        auth.client_id,
        "ui",
        "operator",
        &auth.scopes.join(","),
        &auth.signed_at.to_string(),
        auth.token,
        auth.nonce,
        &auth.platform.trim().to_ascii_lowercase(),
        &auth.device_family.trim().to_ascii_lowercase(),
    ]
    .join("|")
}

#[cfg(test)]
mod tests;
