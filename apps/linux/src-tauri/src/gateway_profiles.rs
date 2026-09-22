use crate::remote_gateway::{self, RemoteGatewayRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Mutex;
use zeroize::Zeroizing;

const REGISTRY_ACCOUNT: &str = "registry-v1";
const NOT_FOUND: &str = "That saved Gateway no longer exists.";
const CORRUPT: &str =
    "Saved Gateway settings could not be read. The existing credential record has been preserved.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayProfileSummary {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub url: Option<String>,
    pub ssh_target: Option<String>,
    pub remote_port: Option<u16>,
    pub tls_fingerprint: Option<String>,
    pub has_token: bool,
    pub has_password: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedGateway {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub request: RemoteGatewayRequest,
}

impl SavedGateway {
    fn summary(&self) -> GatewayProfileSummary {
        GatewayProfileSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            transport: self.request.transport.clone(),
            url: self.request.url.clone(),
            ssh_target: self.request.ssh_target.clone(),
            remote_port: self.request.remote_port,
            tls_fingerprint: self.request.tls_fingerprint.clone(),
            has_token: self.request.token.is_some(),
            has_password: self.request.password.is_some(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Registry {
    version: u32,
    profiles: Vec<SavedGateway>,
    selected: Option<String>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: Vec::new(),
            selected: None,
        }
    }
}

trait RegistryCredential: Send + Sync {
    fn read(&self) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, value: &[u8]) -> Result<(), String>;
}

struct SystemCredential {
    service: String,
}

fn credential_error(error: keyring::Error) -> String {
    #[cfg(target_os = "macos")]
    if let keyring::Error::PlatformFailure(cause) | keyring::Error::NoStorageAccess(cause) = &error
    {
        if let Some(cause) = cause.downcast_ref::<security_framework::base::Error>() {
            return match cause.code() {
                -25307 => "Saved Gateways are unavailable because macOS has no default login keychain. Open Keychain Access to configure or restore it, then try again.".to_string(),
                -25294 => "Saved Gateways are unavailable because the login keychain could not be found. Open Keychain Access to restore it, then try again.".to_string(),
                -25291 => "macOS Keychain is unavailable. Try again after your login session is ready.".to_string(),
                -25308 | -25293 => "macOS denied access to the login keychain. Unlock it in Keychain Access or approve OpenClaw-Tauri access, then try again.".to_string(),
                -128 => "Access to saved Gateways was canceled. Try again and approve Keychain access when prompted.".to_string(),
                code => format!("Could not access saved Gateways in macOS Keychain (error {code}). Check Keychain Access and try again."),
            };
        }
    }
    // Backend errors can contain credential bytes or entry metadata. Only a
    // typed macOS status code above is safe to include in the user message.
    match error {
        keyring::Error::TooLong(_, _) => "These saved Gateways exceed the system credential store's size limit. Shorten or remove an entry, then try again.".to_string(),
        keyring::Error::NoDefaultStore => "The system credential store is unavailable. Check that your keychain or credential vault is configured, then restart OpenClaw-Tauri.".to_string(),
        keyring::Error::BadEncoding(_) | keyring::Error::BadDataFormat(_, _) | keyring::Error::BadStoreFormat(_) => CORRUPT.to_string(),
        _ => "Could not access saved Gateways in the system credential store. Check that your keychain or credential vault is available, then try again.".to_string(),
    }
}

impl RegistryCredential for SystemCredential {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        let entry =
            keyring::Entry::new(&self.service, REGISTRY_ACCOUNT).map_err(credential_error)?;
        match entry.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(credential_error(error)),
        }
    }

    fn write(&self, value: &[u8]) -> Result<(), String> {
        keyring::Entry::new(&self.service, REGISTRY_ACCOUNT)
            .and_then(|entry| entry.set_secret(value))
            .map_err(credential_error)
    }
}

pub(crate) struct GatewayProfiles {
    credential: Box<dyn RegistryCredential>,
    registry: Mutex<Option<Registry>>,
}

impl GatewayProfiles {
    pub fn new(namespace: &str) -> Self {
        // Debug signatures must never create the release app's Keychain ACL.
        let base = if cfg!(debug_assertions) {
            "ai.openclaw.tauri.gateway-profiles.debug"
        } else {
            "ai.openclaw.tauri.gateway-profiles"
        };
        Self {
            credential: Box::new(SystemCredential {
                service: format!("{base}.{}", digest(namespace)),
            }),
            registry: Mutex::new(None),
        }
    }

    pub fn list(&self) -> Result<Vec<GatewayProfileSummary>, String> {
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        let mut profiles: Vec<_> = self
            .load(&mut cache)?
            .profiles
            .iter()
            .map(SavedGateway::summary)
            .collect();
        profiles.sort_by_cached_key(|profile| (profile.name.to_lowercase(), profile.id.clone()));
        Ok(profiles)
    }

    pub fn get(&self, id: &str) -> Result<SavedGateway, String> {
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        self.load(&mut cache)?
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or_else(|| NOT_FOUND.to_string())
    }

    pub fn save(
        &self,
        name: &str,
        replacing: Option<&str>,
        request: RemoteGatewayRequest,
    ) -> Result<GatewayProfileSummary, String> {
        let (mut request, endpoint) = canonical_request(request)?;
        let id = format!("manual-{}", digest(&endpoint));
        let name = match name.trim() {
            "" => endpoint,
            name => name.to_string(),
        };
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        let mut next = self.load(&mut cache)?.clone();
        if let Some(previous) = replacing {
            if !next.profiles.iter().any(|profile| profile.id == previous) {
                return Err(NOT_FOUND.to_string());
            }
            if previous != id && next.profiles.iter().any(|profile| profile.id == id) {
                return Err("That Gateway is already saved. Edit its existing entry.".to_string());
            }
        }
        if request.token.is_none() && request.password.is_none() {
            if let Some(saved) = next.profiles.iter().find(|profile| profile.id == id) {
                request.token = saved.request.token.clone();
                request.password = saved.request.password.clone();
            }
        }
        let saved = SavedGateway {
            id,
            revision: uuid::Uuid::new_v4().to_string(),
            name,
            request,
        };
        let summary = saved.summary();
        next.profiles
            .retain(|profile| profile.id != saved.id && Some(profile.id.as_str()) != replacing);
        if replacing.is_some()
            && replacing != Some(saved.id.as_str())
            && next.selected.as_deref() == replacing
        {
            // The new endpoint becomes selected only after its window loads.
            next.selected = None;
        }
        next.profiles.push(saved);
        self.commit(&mut cache, next)?;
        Ok(summary)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        let mut next = self.load(&mut cache)?.clone();
        if !next.profiles.iter().any(|profile| profile.id == id) {
            return Err(NOT_FOUND.to_string());
        }
        next.profiles.retain(|profile| profile.id != id);
        if next.selected.as_deref() == Some(id) {
            next.selected = None;
        }
        self.commit(&mut cache, next)
    }

    pub fn selected(&self) -> Result<Option<String>, String> {
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        Ok(self.load(&mut cache)?.selected.clone())
    }

    pub fn remember(&self, id: Option<&str>) -> Result<(), String> {
        let mut cache = self.registry.lock().map_err(|_| CORRUPT)?;
        let mut next = self.load(&mut cache)?.clone();
        if id.is_some_and(|id| !next.profiles.iter().any(|profile| profile.id == id)) {
            return Err(NOT_FOUND.to_string());
        }
        if next.selected.as_deref() == id {
            return Ok(());
        }
        next.selected = id.map(str::to_string);
        self.commit(&mut cache, next)
    }

    fn load<'a>(&self, cache: &'a mut Option<Registry>) -> Result<&'a Registry, String> {
        if cache.is_none() {
            let registry = match self.credential.read()? {
                Some(bytes) => {
                    let bytes = Zeroizing::new(bytes);
                    let mut registry: Registry =
                        serde_json::from_slice(&bytes).map_err(|_| CORRUPT)?;
                    if registry.version != 1 {
                        return Err(format!(
                            "Saved Gateways require a different OpenClaw-Tauri version (registry {}). The existing credential record has been preserved.",
                            registry.version
                        ));
                    }
                    let mut ids = HashSet::new();
                    for saved in &registry.profiles {
                        let (_, endpoint) =
                            canonical_request(saved.request.clone()).map_err(|_| CORRUPT)?;
                        if saved.id != format!("manual-{}", digest(&endpoint))
                            || uuid::Uuid::parse_str(&saved.revision).is_err()
                            || !ids.insert(saved.id.as_str())
                        {
                            return Err(CORRUPT.to_string());
                        }
                    }
                    if registry
                        .selected
                        .as_deref()
                        .is_some_and(|id| !ids.contains(id))
                    {
                        // A removed selection falls back to Primary. Reading
                        // it must not rewrite otherwise valid credentials.
                        registry.selected = None;
                    }
                    registry
                }
                None => Registry::default(),
            };
            *cache = Some(registry);
        }
        Ok(cache.as_ref().expect("registry loaded"))
    }

    fn commit(&self, cache: &mut Option<Registry>, next: Registry) -> Result<(), String> {
        // Identity, credentials, and selection share one atomic vault replacement.
        // A failed write leaves the last readable registry authoritative in memory.
        let bytes = Zeroizing::new(serde_json::to_vec(&next).map_err(|_| CORRUPT)?);
        self.credential.write(&bytes)?;
        *cache = Some(next);
        Ok(())
    }
}

fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_request(
    mut request: RemoteGatewayRequest,
) -> Result<(RemoteGatewayRequest, String), String> {
    remote_gateway::validate_request(&request)?;
    request.token = request
        .token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    request.password = request
        .password
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let url = request
        .url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(remote_gateway::normalize_gateway_url)
        .transpose()?;
    if request.tls_fingerprint.is_some() {
        // Explicit pins use the pure validation branch; saved profiles never
        // inherit credentials or pins from the primary Gateway configuration.
        let validation_url = url
            .clone()
            .unwrap_or_else(|| tauri::Url::parse("ws://127.0.0.1:18789").expect("loopback URL"));
        remote_gateway::resolve_remote_tls_fingerprint(&mut request, &validation_url)?;
    }
    request.url = url.as_ref().map(ToString::to_string);
    let endpoint = if request.transport == "ssh" {
        let (target, port) = remote_gateway::validate_ssh_target(
            request
                .ssh_target
                .as_deref()
                .ok_or("Enter the SSH host running your Gateway.")?,
        )?;
        let target = match port.filter(|port| *port != 22) {
            Some(port) => format!("{target}:{port}"),
            None => target,
        };
        request.ssh_target = Some(target.clone());
        let remote_port = request.remote_port.unwrap_or(18789);
        request.remote_port = Some(remote_port);
        format!("ssh://{target}/{remote_port}")
    } else {
        request.ssh_target = None;
        request.remote_port = None;
        url.ok_or("Enter the Gateway URL.")?.to_string()
    };
    Ok((request, endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default)]
    struct MemoryState {
        value: Option<Vec<u8>>,
        reads: usize,
        fail_write: bool,
    }

    #[derive(Clone, Default)]
    struct MemoryCredential(Arc<Mutex<MemoryState>>);

    impl RegistryCredential for MemoryCredential {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            let mut state = self.0.lock().unwrap();
            state.reads += 1;
            Ok(state.value.clone())
        }

        fn write(&self, value: &[u8]) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            if state.fail_write {
                return Err("Credential vault is locked.".to_string());
            }
            state.value = Some(value.to_vec());
            Ok(())
        }
    }

    fn store(credential: &MemoryCredential) -> GatewayProfiles {
        GatewayProfiles {
            credential: Box::new(credential.clone()),
            registry: Mutex::new(None),
        }
    }

    fn request(url: &str, token: Option<&str>) -> RemoteGatewayRequest {
        RemoteGatewayRequest {
            transport: "direct".to_string(),
            url: Some(url.to_string()),
            ssh_target: None,
            token: token.map(str::to_string),
            password: None,
            remote_port: None,
            tls_fingerprint: None,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn credential_errors_distinguish_missing_keychains_from_denied_access() {
        for (code, no_storage_access, guidance, may_suggest_unlock) in [
            (-25307, false, "no default login keychain", false),
            (-25294, true, "login keychain could not be found", false),
            (-25291, true, "Keychain is unavailable", false),
            (-25308, false, "Unlock", true),
            (-25293, false, "Unlock", true),
            (-128, false, "canceled", false),
            (-77777, false, "-77777", false),
        ] {
            let cause = Box::new(security_framework::base::Error::from_code(code));
            let error = if no_storage_access {
                keyring::Error::NoStorageAccess(cause)
            } else {
                keyring::Error::PlatformFailure(cause)
            };
            let message = credential_error(error);
            assert!(
                message.contains(guidance),
                "wrong guidance for OSStatus {code}"
            );
            if !may_suggest_unlock {
                assert!(!message.to_lowercase().contains("unlock"));
            }
        }
    }

    #[test]
    fn credential_errors_never_format_secret_bearing_backend_payloads() {
        for error in [
            keyring::Error::NoDefaultStore,
            keyring::Error::BadEncoding(b"fixture-secret".to_vec()),
            keyring::Error::BadDataFormat(
                b"fixture-secret".to_vec(),
                Box::new(std::io::Error::other("fixture-secret")),
            ),
            keyring::Error::BadStoreFormat("fixture-secret".to_string()),
            keyring::Error::Invalid("fixture-secret".to_string(), "fixture-secret".to_string()),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("fixture-secret"))),
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("fixture-secret"))),
        ] {
            let message = credential_error(error);
            assert!(!message.contains("fixture-secret"));
            assert!(!message.to_lowercase().contains("unlock"));
        }
    }

    #[test]
    fn restart_restores_profiles_credentials_and_selection_without_exposing_secrets() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let saved = profiles
            .save(
                "Studio",
                None,
                request("https://studio.example", Some("fixture-secret")),
            )
            .unwrap();
        profiles.remember(Some(&saved.id)).unwrap();
        drop(profiles);

        let restarted = store(&vault);
        assert_eq!(
            restarted.selected().unwrap().as_deref(),
            Some(saved.id.as_str())
        );
        let listing = restarted.list().unwrap();
        assert_eq!(listing[0].url.as_deref(), Some("wss://studio.example/"));
        assert_eq!(
            restarted.get(&saved.id).unwrap().request.token.as_deref(),
            Some("fixture-secret")
        );
        let projected = serde_json::to_value(&listing).unwrap();
        assert!(projected[0].get("token").is_none());
        assert!(projected[0].get("password").is_none());
        assert!(!format!("{listing:?}").contains("fixture-secret"));
        assert_eq!(
            vault.0.lock().unwrap().reads,
            2,
            "one vault read per process owner"
        );
    }

    #[test]
    fn failed_writes_preserve_endpoint_credentials_and_selection_across_restart() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let saved = profiles
            .save(
                "Studio",
                None,
                request("https://studio.example", Some("original")),
            )
            .unwrap();
        profiles.remember(Some(&saved.id)).unwrap();
        vault.0.lock().unwrap().fail_write = true;
        assert!(profiles
            .save(
                "Replacement",
                Some(&saved.id),
                request("https://other.example", Some("replacement"))
            )
            .is_err());
        assert!(profiles.remove(&saved.id).is_err());
        assert!(profiles.remember(None).is_err());
        for owner in [&profiles, &store(&vault)] {
            assert_eq!(owner.list().unwrap().len(), 1);
            assert_eq!(owner.get(&saved.id).unwrap().name, "Studio");
            assert_eq!(
                owner.get(&saved.id).unwrap().request.token.as_deref(),
                Some("original")
            );
            assert_eq!(
                owner.selected().unwrap().as_deref(),
                Some(saved.id.as_str())
            );
        }
    }

    #[test]
    fn renaming_retains_identity_but_endpoint_changes_never_copy_credentials() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let saved = profiles
            .save(
                "Studio",
                None,
                request("https://studio.example", Some("original")),
            )
            .unwrap();
        profiles.remember(Some(&saved.id)).unwrap();
        let revision = profiles.get(&saved.id).unwrap().revision;
        let renamed = profiles
            .save(
                "Desk",
                Some(&saved.id),
                request("wss://studio.example/", None),
            )
            .unwrap();
        assert_eq!(renamed.id, saved.id);
        assert_ne!(profiles.get(&saved.id).unwrap().revision, revision);
        assert_eq!(
            profiles.selected().unwrap().as_deref(),
            Some(saved.id.as_str())
        );
        assert_eq!(
            profiles.get(&saved.id).unwrap().request.token.as_deref(),
            Some("original")
        );
        let moved = profiles
            .save(
                "Desk",
                Some(&saved.id),
                request("wss://other.example/", None),
            )
            .unwrap();
        assert_ne!(moved.id, saved.id);
        assert!(profiles.get(&saved.id).is_err());
        assert!(profiles.get(&moved.id).unwrap().request.token.is_none());
        assert!(profiles.selected().unwrap().is_none());
        assert!(store(&vault).selected().unwrap().is_none());
        profiles.remember(Some(&moved.id)).unwrap();
        assert_eq!(
            profiles.selected().unwrap().as_deref(),
            Some(moved.id.as_str())
        );
        let mut ssh = request("ws://127.0.0.1:49801", None);
        ssh.transport = "ssh".into();
        ssh.ssh_target = Some("operator@studio.example".into());
        let tunneled = profiles
            .save("Desk over SSH", Some(&moved.id), ssh)
            .unwrap();
        assert_ne!(tunneled.id, moved.id);
        assert!(profiles.get(&moved.id).is_err());
        assert!(profiles.selected().unwrap().is_none());
        assert!(store(&vault).selected().unwrap().is_none());
        profiles.remember(Some(&tunneled.id)).unwrap();
        assert_eq!(
            profiles.selected().unwrap().as_deref(),
            Some(tunneled.id.as_str())
        );
        assert!(profiles.get(&tunneled.id).unwrap().request.token.is_none());
        profiles.remove(&tunneled.id).unwrap();
        let restarted = store(&vault);
        assert!(restarted.list().unwrap().is_empty());
        assert!(restarted.selected().unwrap().is_none());
    }

    #[test]
    fn credential_rotation_replaces_opposite_credential_and_canonical_endpoints_deduplicate() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let saved = profiles
            .save(
                "Studio",
                None,
                request("https://STUDIO.example:443", Some("original")),
            )
            .unwrap();
        let mut replacement = request("wss://studio.example/", None);
        replacement.password = Some("fixture-password".to_string());
        let updated = profiles.save("Studio", None, replacement).unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(profiles.list().unwrap().len(), 1);
        let request = profiles.get(&saved.id).unwrap().request;
        assert!(request.token.is_none());
        assert_eq!(request.password.as_deref(), Some("fixture-password"));
    }

    #[test]
    fn ssh_identity_does_not_depend_on_local_forwarding_port() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let mut ssh = request("ws://127.0.0.1:49801", Some("original"));
        ssh.transport = "ssh".to_string();
        ssh.ssh_target = Some("operator@studio.example:22".to_string());
        let first = profiles.save("Studio", None, ssh.clone()).unwrap();
        ssh.url = Some("ws://127.0.0.1:49802".to_string());
        ssh.remote_port = Some(18789);
        ssh.ssh_target = Some("operator@studio.example".to_string());
        let second = profiles.save("Studio", None, ssh).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(profiles.list().unwrap().len(), 1);
    }

    #[test]
    fn dangling_selected_preference_falls_back_without_rewriting_valid_profiles() {
        let vault = MemoryCredential::default();
        let profiles = store(&vault);
        let saved = profiles
            .save(
                "Studio",
                None,
                request("https://studio.example", Some("fixture-secret")),
            )
            .unwrap();
        drop(profiles);
        let mut record: serde_json::Value =
            serde_json::from_slice(vault.0.lock().unwrap().value.as_ref().unwrap()).unwrap();
        record["selected"] = serde_json::json!("removed-profile");
        let original = serde_json::to_vec(&record).unwrap();
        vault.0.lock().unwrap().value = Some(original.clone());

        let restarted = store(&vault);
        assert!(restarted.selected().unwrap().is_none());
        assert_eq!(restarted.list().unwrap().len(), 1);
        assert_eq!(
            restarted.get(&saved.id).unwrap().request.token.as_deref(),
            Some("fixture-secret")
        );
        assert_eq!(
            vault.0.lock().unwrap().value.as_ref(),
            Some(&original),
            "reading stale selection must not rewrite the credential vault"
        );
    }

    #[test]
    fn corrupt_and_newer_registries_are_never_overwritten() {
        for original in [
            b"not-json".to_vec(),
            br#"{"version":2,"profiles":[],"selected":null}"#.to_vec(),
            br#"{"version":1,"profiles":[{}],"selected":null}"#.to_vec(),
        ] {
            let vault = MemoryCredential::default();
            vault.0.lock().unwrap().value = Some(original.clone());
            let profiles = store(&vault);
            assert!(profiles.list().is_err());
            assert!(profiles
                .save(
                    "Studio",
                    None,
                    request("https://studio.example", Some("new"))
                )
                .is_err());
            assert_eq!(vault.0.lock().unwrap().value.as_ref(), Some(&original));
        }
    }
}
