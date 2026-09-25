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
mod tests {
    use super::*;

    #[test]
    fn web_store_removal_requires_a_record_owned_by_this_root() {
        let directory = std::env::temp_dir().join(format!("gpui-web-store-test-{}", random_id()));
        let mut identity = Identity::load_at(&directory).unwrap();
        let mut stale = identity.clone();
        let scope = crate::web_data_store::control_scope("wss://example.test/").unwrap();
        assert_eq!(identity.begin_web_store_removal(&scope).unwrap(), None);
        let id = identity.record_web_store(&scope).unwrap();
        let reading = identity.record_web_store("reading").unwrap();
        // Token writers and deletion callers may hold older state snapshots.
        stale
            .set_device_token_for_profile(None, "wss://example.test/", Some("fixture"))
            .unwrap();
        assert_eq!(stale.begin_web_store_removal(&scope).unwrap(), Some(id));
        assert!(identity.record_web_store(&scope).is_err());
        identity.finish_web_store_removal(&scope, reading).unwrap();
        assert!(identity.web_data_stores.contains_key(&scope));
        identity.finish_web_store_removal(&scope, id).unwrap();
        assert_eq!(stale.begin_web_store_removal(&scope).unwrap(), None);
        assert_eq!(stale.web_data_stores["reading"].identifier, reading);
        assert_eq!(stale.device_token("wss://example.test/"), Some("fixture"));
        // Copying app state cannot authorize deletion in the original root.
        let other = directory.join("copied-root");
        fs::create_dir(&other).unwrap();
        fs::copy(&identity.path, other.join("identity.json")).unwrap();
        let mut copied = Identity::load_at(&other).unwrap();
        assert!(copied.begin_web_store_removal("reading").is_err());
        assert!(copied.record_web_store("reading").is_err());
        #[cfg(unix)]
        {
            let alias = directory.join("alias");
            std::os::unix::fs::symlink(&directory, &alias).unwrap();
            assert_eq!(
                Identity::load_at(&alias)
                    .unwrap()
                    .record_web_store("reading")
                    .unwrap(),
                reading
            );
            fs::remove_file(alias).unwrap();
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sessions_and_last_gateway_roundtrip_without_clobbering_device_tokens() {
        let directory =
            std::env::temp_dir().join(format!("openclaw-gpui-state-test-{}", random_id()));
        let mut first = Identity::load_at(&directory).unwrap();
        let mut stale = first.clone();
        first
            .set_device_token_for_profile(None, "wss://team.example/", Some("device-secret"))
            .unwrap();
        let session = Session {
            application: super::super::access::Application {
                origin: "https://team.example".into(),
                issuer: "https://team.cloudflareaccess.com".into(),
                audience: "test-audience".into(),
            },
            subject: "test-subject".into(),
            email: Some("synthetic@example.test".into()),
            token: "access-secret".into(),
            expires_at: 2_000_000_000.,
        };
        stale
            .set_access_session_for_profile(None, "https://team.example", Some(session))
            .unwrap();
        first.remember_gateway("wss://team.example/").unwrap();
        let loaded = Identity::load_at(&directory).unwrap();
        assert_eq!(
            loaded.device_token("wss://team.example/"),
            Some("device-secret")
        );
        assert_eq!(
            loaded.access_session("https://team.example").unwrap().token,
            "access-secret"
        );
        assert_eq!(
            loaded.last_gateway_url.as_deref(),
            Some("wss://team.example/")
        );
        let debug = format!("{loaded:?}");
        for secret in ["device-secret", "access-secret", &loaded.secret_key] {
            assert!(!debug.contains(secret));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&loaded.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let mut refreshed = loaded
            .access_session("https://team.example")
            .unwrap()
            .clone();
        refreshed.token = "new-access-secret".into();
        first
            .set_access_session_for_profile(None, "https://team.example", Some(refreshed))
            .unwrap();
        stale
            .clear_access_session_if_for_profile(None, "https://team.example", "access-secret")
            .unwrap();
        assert_eq!(
            stale.access_session("https://team.example").unwrap().token,
            "new-access-secret"
        );
        stale
            .set_access_session_for_profile(None, "https://team.example", None)
            .unwrap();
        let signed_out = Identity::load_at(&directory).unwrap();
        assert!(signed_out.access_session("https://team.example").is_none());
        assert_eq!(
            signed_out.device_token("wss://team.example/"),
            Some("device-secret")
        );
        assert_eq!(signed_out.last_gateway_url, loaded.last_gateway_url);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn existing_identity_files_keep_their_key_and_tokens_when_url_is_normalized() {
        let directory =
            std::env::temp_dir().join(format!("openclaw-gpui-migration-test-{}", random_id()));
        let first = Identity::load_at(&directory).unwrap();
        let old = json!({"secret_key": first.secret_key, "device_tokens": {"ws://127.0.0.1:19471": "old-device-token"}});
        fs::write(&first.path, serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = Identity::load_at(&directory).unwrap();
        assert_eq!(loaded.secret_key, first.secret_key);
        assert_eq!(
            loaded.device_token("ws://127.0.0.1:19471/"),
            Some("old-device-token")
        );
        assert!(loaded.access_sessions.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sidebar_preferences_are_gateway_scoped_and_survive_other_writers() {
        use crate::model::sidebar::{ArchiveFilter, Grouping, SidebarPreferences};
        let directory = std::env::temp_dir().join(format!("gpui-sidebar-state-{}", random_id()));
        let mut first = Identity::load_at(&directory).unwrap();
        let mut stale = first.clone();
        let prefs = SidebarPreferences {
            archive: ArchiveFilter::Archived,
            grouping: Grouping::Person,
            show_preview: true,
            ..Default::default()
        };
        first
            .save_sidebar_preferences("profile:a", prefs.clone())
            .unwrap();
        stale
            .set_device_token_for_profile(None, "ws://127.0.0.1:19471/", Some("fixture"))
            .unwrap();
        stale
            .save_sidebar_preferences("profile:b", SidebarPreferences::default())
            .unwrap();
        let loaded = Identity::load_at(&directory).unwrap();
        assert_eq!(loaded.sidebar_preferences("profile:a"), prefs);
        assert_eq!(
            loaded.sidebar_preferences("profile:b"),
            SidebarPreferences::default()
        );
        assert_eq!(
            loaded.device_token("ws://127.0.0.1:19471/"),
            Some("fixture")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn payload_matches_the_typescript_gateway_auth_vectors() {
        // Exact v3 vector from src/gateway/device-auth.test.ts, whose builder is
        // packages/gateway-client/src/device-auth.ts. Changes alter signed bytes.
        let auth = DeviceAuth {
            device_id: "dev-1",
            client_id: "openclaw-macos",
            scopes: &["operator.admin", "operator.read"],
            signed_at: 1_700_000_000_000,
            token: "tok-123",
            nonce: "nonce-abc",
            platform: "  IOS  ",
            device_family: "  iPhone  ",
        };
        assert_eq!(
            payload(&auth),
            "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone"
        );
        let empty = DeviceAuth {
            device_id: "dev-2",
            client_id: "openclaw-ios",
            scopes: &["operator.read"],
            signed_at: 1_700_000_000_001,
            token: "",
            nonce: "nonce-def",
            platform: "",
            device_family: "",
        };
        assert_eq!(
            payload(&empty),
            "v3|dev-2|openclaw-ios|ui|operator|operator.read|1700000000001||nonce-def||"
        );
    }

    #[test]
    fn device_id_is_sha256_of_raw_public_key_and_proof_verifies() {
        use ed25519_dalek::{Signature, Verifier};
        // RFC 8032 test vector 1: public bytes, not DER or base64, own the ID.
        let public_key = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
            0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
            0xf7, 0x07, 0x51, 0x1a,
        ];
        assert_eq!(
            device_id(&public_key),
            "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9"
        );
        let identity = Identity {
            secret_key: URL_SAFE_NO_PAD.encode([7; 32]),
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
            path: PathBuf::new(),
        };
        let auth = DeviceAuth {
            device_id: "",
            client_id: "openclaw-macos",
            scopes: &[
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.questions",
            ],
            signed_at: 123,
            token: "fixture-token",
            nonce: "fixture-nonce",
            platform: "macos",
            device_family: "",
        };
        let proof = identity.proof(auth).unwrap();
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(proof["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let expected = format!(
            "v3|{}|openclaw-macos|ui|operator|operator.read,operator.write,operator.approvals,operator.questions|123|fixture-token|fixture-nonce|macos|",
            proof["id"].as_str().unwrap()
        );
        identity
            .signing_key()
            .unwrap()
            .verifying_key()
            .verify(expected.as_bytes(), &signature)
            .unwrap();
    }
}
