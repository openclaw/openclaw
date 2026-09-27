//! Saved route ownership; secrets and profile metadata commit in identity.json together.
use std::{fmt, path::Path};

use serde::{Deserialize, Serialize};

use super::{config::normalize_url, identity::Identity, remote_tunnel::parse_ssh_target};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayProfile {
    pub id: String,
    pub name: String,
    pub kind: GatewayKind,
    pub order: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GatewayKind {
    Direct {
        url: String,
    },
    Ssh {
        target: String,
        #[serde(default = "default_remote_port")]
        remote_port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity_file: Option<String>,
    },
}

fn default_remote_port() -> u16 {
    18789
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileCredentials {
    pub token: Option<String>,
    pub password: Option<String>,
}

impl ProfileCredentials {
    fn normalized(self) -> Result<Self, String> {
        let normalize = |value: Option<String>| {
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let credentials = Self {
            token: normalize(self.token),
            password: normalize(self.password),
        };
        if credentials.token.is_some() && credentials.password.is_some() {
            return Err("Enter either a Gateway token or password, not both".into());
        }
        Ok(credentials)
    }
}

impl fmt::Debug for ProfileCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProfileCredentials")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl GatewayProfile {
    pub fn new(name: &str, kind: GatewayKind) -> Result<Self, String> {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_owned(),
            kind,
            order: 0,
        }
        .validated()
    }

    pub fn direct(name: &str, url: &str) -> Result<Self, String> {
        Self::new(
            name,
            GatewayKind::Direct {
                url: url.to_owned(),
            },
        )
    }

    pub fn validated(mut self) -> Result<Self, String> {
        if uuid::Uuid::parse_str(&self.id).is_err() {
            return Err("Invalid Gateway profile identity".into());
        }
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.len() > 200 || self.name.chars().any(char::is_control)
        {
            return Err("Enter a Gateway name between 1 and 200 characters".into());
        }
        match &mut self.kind {
            GatewayKind::Direct { url } => *url = normalize_url(url)?,
            GatewayKind::Ssh {
                target,
                remote_port,
                identity_file,
            } => {
                parse_ssh_target(target)?;
                *target = target.trim().to_owned();
                if *remote_port == 0 {
                    return Err("Remote Gateway port must be between 1 and 65535".into());
                }
                *identity_file = identity_file
                    .take()
                    .map(|path| path.trim().to_owned())
                    .filter(|path| !path.is_empty());
                if identity_file
                    .as_ref()
                    .is_some_and(|path| path.contains('\0'))
                {
                    return Err("SSH identity file cannot contain a null character".into());
                }
            }
        }
        Ok(self)
    }

    /// The remote Gateway, never the disposable local SSH forwarding port.
    pub fn canonical_url(&self) -> String {
        match &self.kind {
            GatewayKind::Direct { url } => url.clone(),
            GatewayKind::Ssh { remote_port, .. } => format!("ws://127.0.0.1:{remote_port}/"),
        }
    }

    pub fn device_token_key(&self) -> String {
        match self.kind {
            GatewayKind::Direct { .. } => self.canonical_url(),
            GatewayKind::Ssh { .. } => format!("profile:{}:{}", self.id, self.canonical_url()),
        }
    }

    pub fn access_origin(&self) -> Option<String> {
        let GatewayKind::Direct { url } = &self.kind else {
            return None;
        };
        let mut url = url::Url::parse(url).ok()?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme).ok()?;
        Some(url.origin().ascii_serialization())
    }
}

pub struct ProfileStore {
    identity: Identity,
}

#[derive(Clone, Debug, Serialize)]
pub struct Removal {
    pub profile: GatewayProfile,
    pub web_scopes: Vec<String>,
}

impl ProfileStore {
    /// Hold for the GUI lifetime or a CLI mutation; listing needs no session lease.
    pub fn app_lock() -> Result<std::fs::File, String> {
        Self::app_lock_at(&Identity::directory()?)
    }

    fn app_lock_at(directory: &Path) -> Result<std::fs::File, String> {
        std::fs::create_dir_all(directory).map_err(|_| "Could not create app state directory")?;
        let path = directory.join("app-session.lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Could not secure app state directory")?;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|_| "Could not open app session lock")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Could not secure app session lock")?;
        }
        file.try_lock()
            .map_err(|_| "Close the GPUI app before editing Gateways from CLI")?;
        Ok(file)
    }

    pub fn load() -> Result<Self, String> {
        Self::load_at(&Identity::directory()?)
    }
    pub fn load_at(directory: &Path) -> Result<Self, String> {
        Self::from_identity(Identity::load_at(directory)?)
    }
    fn from_identity(identity: Identity) -> Result<Self, String> {
        let mut ids = std::collections::HashSet::new();
        for profile in &identity.profiles {
            profile.clone().validated()?;
            if !ids.insert(&profile.id) {
                return Err("Saved Gateways contain a duplicate identity".into());
            }
        }
        Ok(Self { identity })
    }
    pub fn list(&self) -> Vec<GatewayProfile> {
        let mut profiles = self.identity.profiles.clone();
        let primary = self.primary_id();
        profiles.sort_by(|a, b| {
            (Some(a.id.as_str()) != primary, a.order, &a.id).cmp(&(
                Some(b.id.as_str()) != primary,
                b.order,
                &b.id,
            ))
        });
        profiles
    }
    pub fn primary_id(&self) -> Option<&str> {
        self.identity.primary_profile_id.as_deref().filter(|id| {
            self.identity
                .profiles
                .iter()
                .any(|profile| profile.id == *id)
        })
    }
    pub fn find(&self, name_or_id: &str) -> Result<GatewayProfile, String> {
        if let Some(profile) = self
            .identity
            .profiles
            .iter()
            .find(|profile| profile.id == name_or_id)
        {
            return Ok(profile.clone());
        }
        let mut matching = self
            .identity
            .profiles
            .iter()
            .filter(|profile| profile.name.eq_ignore_ascii_case(name_or_id));
        let profile = matching
            .next()
            .ok_or("That saved Gateway no longer exists")?;
        if matching.next().is_some() {
            return Err("Gateway name is ambiguous; use its profile ID".into());
        }
        Ok(profile.clone())
    }
    pub fn save(
        &mut self,
        profile: GatewayProfile,
        primary: bool,
    ) -> Result<GatewayProfile, String> {
        self.save_with_credentials(profile, primary, None)
    }
    pub fn save_with_credentials(
        &mut self,
        profile: GatewayProfile,
        primary: bool,
        credentials: Option<ProfileCredentials>,
    ) -> Result<GatewayProfile, String> {
        let mut profile = profile.validated()?;
        let credentials = credentials
            .map(ProfileCredentials::normalized)
            .transpose()?;
        self.identity.try_update(|state| {
            if let Some(previous) = state.profiles.iter().find(|saved| saved.id == profile.id) {
                if previous.kind != profile.kind {
                    return Err("Remove the existing Gateway before changing its endpoint; this retires its credentials and web sessions".into());
                }
            } else {
                profile.order = state.profiles.iter().map(|saved| saved.order).max().map_or(0, |order| order + 1);
            }
            if state.profiles.iter().any(|saved| saved.id != profile.id && saved.name.eq_ignore_ascii_case(&profile.name)) {
                return Err("A Gateway with this name already exists".into());
            }
            state.profiles.retain(|saved| saved.id != profile.id);
            state.profiles.push(profile.clone());
            if let Some(credentials) = credentials {
                if credentials == ProfileCredentials::default() { state.profile_credentials.remove(&profile.id); }
                else { state.profile_credentials.insert(profile.id.clone(), credentials); }
            }
            if primary || state.primary_profile_id.is_none() { state.primary_profile_id = Some(profile.id.clone()); }
            Ok(profile)
        })
    }
    pub fn set_primary(&mut self, id: &str) -> Result<(), String> {
        self.identity.try_update(|state| {
            if !state.profiles.iter().any(|profile| profile.id == id) {
                return Err("That saved Gateway no longer exists".into());
            }
            state.primary_profile_id = Some(id.to_owned());
            Ok(())
        })
    }
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        self.identity.try_update(|state| {
            let unique: std::collections::HashSet<_> = ids.iter().collect();
            if unique.len() != state.profiles.len()
                || ids.len() != state.profiles.len()
                || state
                    .profiles
                    .iter()
                    .any(|profile| !unique.contains(&profile.id))
            {
                return Err("Gateway order must include every saved profile exactly once".into());
            }
            for profile in &mut state.profiles {
                profile.order = ids
                    .iter()
                    .position(|id| *id == profile.id)
                    .expect("validated membership");
            }
            Ok(())
        })
    }
    pub fn credentials(&self, id: &str) -> ProfileCredentials {
        self.identity
            .profile_credentials
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
    /// Call only after retiring all windows/actors for this profile.
    pub fn remove(&mut self, id: &str) -> Result<Removal, String> {
        self.identity.try_update(|state| {
            let profile = state
                .profiles
                .iter()
                .find(|profile| profile.id == id)
                .cloned()
                .ok_or("That saved Gateway no longer exists")?;
            state.profiles.retain(|saved| saved.id != id);
            state.profile_credentials.remove(id);
            let token_key = profile.device_token_key();
            if !state
                .profiles
                .iter()
                .any(|saved| saved.device_token_key() == token_key)
            {
                state.device_tokens.remove(&token_key);
            }
            if let Some(origin) = profile.access_origin()
                && !state
                    .profiles
                    .iter()
                    .any(|saved| saved.access_origin().as_ref() == Some(&origin))
            {
                state.access_sessions.remove(&origin);
            }
            if state.primary_profile_id.as_deref() == Some(id) {
                state.primary_profile_id = state
                    .profiles
                    .iter()
                    .min_by_key(|saved| saved.order)
                    .map(|saved| saved.id.clone());
            }
            let mut web_scopes = state.profile_web_scopes.remove(id).unwrap_or_default();
            {
                let prefix = format!("profile:{id}:");
                web_scopes.extend(
                    state
                        .web_data_stores
                        .keys()
                        .filter(|scope| scope.starts_with(&prefix))
                        .cloned(),
                );
                web_scopes.sort();
                web_scopes.dedup();
                for scope in &web_scopes {
                    let expected = state.web_store_identifier(scope)?;
                    if let Some(record) = state.web_data_stores.get_mut(scope) {
                        if record.identifier != expected {
                            return Err(
                                "Refusing to remove a web store belonging to another state root"
                                    .into(),
                            );
                        }
                        record.pending_removal = true;
                    }
                }
            }
            Ok(Removal {
                profile,
                web_scopes,
            })
        })
    }
}

/// Read only the two non-secret preferences; never inspect Mac Keychain items.
pub fn mac_import_candidate() -> Option<GatewayProfile> {
    #[cfg(target_os = "macos")]
    {
        let read = |key| {
            let output = std::process::Command::new("/usr/bin/defaults")
                .args(["read", "ai.openclaw.mac", key])
                .output()
                .ok()?;
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        };
        if read("openclaw.connectionMode")?.as_str() != "remote" {
            return None;
        }
        GatewayProfile::new(
            "OpenClaw for Mac",
            GatewayKind::Ssh {
                target: read("openclaw.remoteTarget")?,
                remote_port: 18789,
                identity_file: None,
            },
        )
        .ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::access::{Application, Session};
    use super::*;

    #[test]
    fn app_session_excludes_another_owner_until_the_first_file_is_dropped() {
        let root = std::env::temp_dir().join(format!("gpui-session-lock-{}", uuid::Uuid::new_v4()));
        let gui = ProfileStore::app_lock_at(&root).unwrap();
        assert_eq!(
            ProfileStore::app_lock_at(&root).unwrap_err(),
            "Close the GPUI app before editing Gateways from CLI"
        );
        // Read-only listing uses only the short state-write lock.
        assert!(ProfileStore::load_at(&root).unwrap().list().is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join("app-session.lock"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(gui);
        let cli = ProfileStore::app_lock_at(&root).unwrap();
        drop(cli);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profiles_survive_restart_keep_order_and_remove_only_owned_credentials() {
        let root = std::env::temp_dir().join(format!("gpui-profiles-{}", uuid::Uuid::new_v4()));
        let mut store = ProfileStore::load_at(&root).unwrap();
        let direct = store
            .save(
                GatewayProfile::direct("Shared", "https://shared.example/one").unwrap(),
                false,
            )
            .unwrap();
        let sibling = store
            .save(
                GatewayProfile::direct("Sibling", "https://shared.example/two").unwrap(),
                false,
            )
            .unwrap();
        let ssh = store
            .save(
                GatewayProfile::new(
                    "SSH",
                    GatewayKind::Ssh {
                        target: "operator@fixture.invalid:2222".into(),
                        remote_port: 19971,
                        identity_file: Some("/fixture/identity with spaces".into()),
                    },
                )
                .unwrap(),
                true,
            )
            .unwrap();
        assert_eq!(ssh.canonical_url(), "ws://127.0.0.1:19971/");
        assert_eq!(
            ssh.device_token_key(),
            format!("profile:{}:ws://127.0.0.1:19971/", ssh.id)
        );
        store
            .save_with_credentials(
                ssh.clone(),
                true,
                Some(ProfileCredentials {
                    token: Some("ssh-secret".into()),
                    password: None,
                }),
            )
            .unwrap();
        store
            .save_with_credentials(
                direct.clone(),
                false,
                Some(ProfileCredentials {
                    token: None,
                    password: Some("direct-secret".into()),
                }),
            )
            .unwrap();
        store
            .reorder(&[sibling.id.clone(), direct.id.clone(), ssh.id.clone()])
            .unwrap();
        let mut identity = Identity::load_at(&root).unwrap();
        identity
            .set_device_token_for_profile(None, &ssh.device_token_key(), Some("ssh-device-secret"))
            .unwrap();
        identity
            .set_device_token_for_profile(
                None,
                &direct.device_token_key(),
                Some("direct-device-secret"),
            )
            .unwrap();
        identity
            .set_access_session_for_profile(
                None,
                "https://shared.example",
                Some(Session {
                    application: Application {
                        origin: "https://shared.example".into(),
                        issuer: "https://access.example".into(),
                        audience: "fixture".into(),
                    },
                    subject: "fixture".into(),
                    email: None,
                    token: "shared-access-secret".into(),
                    expires_at: 2_000_000_000.,
                }),
            )
            .unwrap();
        let ssh_scope = format!("profile:{}:control:http://127.0.0.1:19971", ssh.id);
        let other_scope = format!("profile:{}:reading", direct.id);
        identity.record_web_store(&ssh_scope).unwrap();
        identity.record_web_store(&other_scope).unwrap();
        let mut restarted = ProfileStore::load_at(&root).unwrap();
        assert_eq!(restarted.primary_id(), Some(ssh.id.as_str()));
        assert_eq!(
            restarted
                .list()
                .iter()
                .map(|profile| &profile.id)
                .collect::<Vec<_>>(),
            [&ssh.id, &sibling.id, &direct.id]
        );
        assert_eq!(restarted.find("sSh").unwrap(), ssh);
        assert_eq!(
            restarted.credentials(&ssh.id).token.as_deref(),
            Some("ssh-secret")
        );
        assert!(
            !serde_json::to_string(&restarted.list())
                .unwrap()
                .contains("secret")
        );
        let removed = restarted.remove(&ssh.id).unwrap();
        assert_eq!(removed.web_scopes, std::slice::from_ref(&ssh_scope));
        let loaded = Identity::load_at(&root).unwrap();
        assert!(loaded.device_token(&ssh.device_token_key()).is_none());
        // A GUI actor retained before CLI removal cannot restore the deleted grant.
        assert!(
            identity
                .set_device_token_for_profile(
                    Some(&ssh),
                    &ssh.device_token_key(),
                    Some("late-token")
                )
                .is_err()
        );
        assert!(restarted.credentials(&ssh.id).token.is_none());
        assert_eq!(
            loaded.device_token(&direct.device_token_key()),
            Some("direct-device-secret")
        );
        assert_eq!(
            restarted.credentials(&direct.id).password.as_deref(),
            Some("direct-secret")
        );
        assert!(loaded.web_data_stores[&ssh_scope].pending_removal);
        assert!(!loaded.web_data_stores[&other_scope].pending_removal);
        restarted.remove(&direct.id).unwrap();
        assert!(
            Identity::load_at(&root)
                .unwrap()
                .access_session("https://shared.example")
                .is_some()
        );
        restarted.remove(&sibling.id).unwrap();
        assert!(
            Identity::load_at(&root)
                .unwrap()
                .access_session("https://shared.example")
                .is_none()
        );
        assert!(ProfileStore::load_at(&root).unwrap().list().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_last_gateway_migrates_once_and_preserves_pairing_identity() {
        let root =
            std::env::temp_dir().join(format!("gpui-profile-migration-{}", uuid::Uuid::new_v4()));
        Identity::load_at(&root).unwrap();
        let path = root.join("identity.json");
        let mut state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let secret = state["secret_key"].clone();
        state.as_object_mut().unwrap().remove("profiles_migrated");
        state["last_gateway_url"] = serde_json::json!("wss://legacy.example");
        state["device_tokens"] = serde_json::json!({"wss://legacy.example":"paired-token"});
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        let mut migrated = ProfileStore::load_at(&root).unwrap();
        let profile = migrated.list().pop().unwrap();
        assert_eq!(profile.canonical_url(), "wss://legacy.example/");
        assert_eq!(migrated.primary_id(), Some(profile.id.as_str()));
        assert_eq!(
            migrated.identity.device_token(&profile.device_token_key()),
            Some("paired-token")
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["secret_key"], secret);
        migrated.remove(&profile.id).unwrap();
        assert!(ProfileStore::load_at(&root).unwrap().list().is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
