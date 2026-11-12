use crate::runtime_action::{BundledRuntime, RuntimeFlavor};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[path = "bundled_runtime_retention.rs"]
mod retention;
pub(crate) use retention::collect_after_healthy;

const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/desktop-runtime.json"));
const LINUX_RESOURCE_PREFIX: &[u8] = b"OPENCLAW-BUN-RUNTIME-V1\n";
const BUN_PATH: &str = if cfg!(target_os = "windows") {
    "bin/bun.exe"
} else {
    "bin/bun"
};
const PACKAGE_ENTRY: &str = "package/node_modules/openclaw/openclaw.mjs";

type RuntimeResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    tag: String,
    commit: String,
    revision: String,
    platform: String,
    arch: String,
    files: BTreeMap<String, String>,
    #[serde(default)]
    runtime: ManifestRuntime,
    #[serde(default, rename = "authenticodeSigned")]
    authenticode_signed: Option<bool>,
    #[serde(default, rename = "testOnly")]
    test_only: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestRuntime {
    flavor: RuntimeFlavor,
    executable: String,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    standalone: Option<serde_json::Value>,
}

impl Default for ManifestRuntime {
    fn default() -> Self {
        // Existing installed JIT seeds remain valid during app upgrades.
        Self {
            flavor: RuntimeFlavor::Jit,
            executable: BUN_PATH.into(),
            entry: None,
            standalone: None,
        }
    }
}

impl Manifest {
    fn entry(&self) -> Option<&str> {
        self.runtime.entry.as_deref().or_else(|| {
            (self.runtime.flavor == RuntimeFlavor::Jit && self.files.contains_key(PACKAGE_ENTRY))
                .then_some(PACKAGE_ENTRY)
        })
    }
}

pub(crate) fn flavor() -> Option<RuntimeFlavor> {
    let manifest: Manifest = serde_json::from_str(MANIFEST).ok()?;
    validate_manifest(&manifest).ok()?;
    Some(manifest.runtime.flavor)
}

pub(crate) fn flavor_label() -> &'static str {
    match flavor() {
        Some(RuntimeFlavor::Jit) => "JIT",
        Some(RuntimeFlavor::Aot) => "AOT (experimental)",
        None => "Unavailable",
    }
}

pub(crate) fn expected_executable_path() -> Result<PathBuf, String> {
    let manifest: Manifest = serde_json::from_str(MANIFEST).map_err(|_| {
        if cfg!(target_os = "windows") {
            missing_runtime_message()
        } else {
            "This build has no embedded runtime."
        }
        .to_string()
    })?;
    validate_manifest(&manifest)?;
    let prefix = crate::cli::openclaw_home().map_err(|error| error.to_string())?;
    let path = runtime_directory(&prefix, MANIFEST, &manifest).join(&manifest.runtime.executable);
    #[cfg(target_os = "windows")]
    let path = match fs::canonicalize(&path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => path,
        Err(error) => return Err(error.to_string()),
    };
    Ok(path)
}

fn missing_runtime_message() -> &'static str {
    if cfg!(target_os = "windows") {
        "This app does not include a signed Windows Gateway runtime. Install an updated OpenClaw desktop app when a signed Windows runtime is available, or connect to a remote Gateway."
    } else {
        "This build has no embedded runtime. Build with the Tauri CLI or run apps/linux/scripts/stage-runtime.mjs before rebuilding."
    }
}

fn runtime_directory(prefix: &Path, bytes: &str, manifest: &Manifest) -> PathBuf {
    let digest: String = Sha256::digest(bytes.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // Source packages add deep platform executable paths. Their hash already
    // identifies Bun; omitting its tag keeps Codex below Windows' path limit.
    let directory = if manifest.files.contains_key(PACKAGE_ENTRY) {
        digest
    } else {
        format!("{}-{digest}", manifest.tag)
    };
    prefix.join("tools/desktop-runtime").join(directory)
}

pub(crate) fn seed(app: &AppHandle) -> Result<BundledRuntime, String> {
    let prefix = crate::cli::openclaw_home().map_err(|error| error.to_string())?;
    seed_into(app, &prefix)
}

fn seed_into(app: &AppHandle, prefix: &Path) -> Result<BundledRuntime, String> {
    let source = app
        .path()
        .resolve("desktop-runtime", BaseDirectory::Resource)
        .map_err(|error| format!("Embedded runtime resources are unavailable: {error}"))?;
    seed_at(&source, prefix, MANIFEST, &verify_revision).map_err(|error| error.to_string())
}

pub(crate) fn seed_cli(
    app: &AppHandle,
    prefix: &Path,
) -> Result<Option<(BundledRuntime, PathBuf)>, String> {
    let manifest: Manifest =
        serde_json::from_str(MANIFEST).map_err(|_| missing_runtime_message().to_string())?;
    if manifest.entry().is_none() && manifest.runtime.flavor == RuntimeFlavor::Jit {
        return Ok(None);
    }
    let runtime = seed_into(app, prefix)?;
    let entry = runtime
        .entry
        .clone()
        .unwrap_or_else(|| runtime.executable.clone());
    Ok(Some((runtime, entry)))
}

fn seed_at(
    source: &Path,
    prefix: &Path,
    manifest_bytes: &str,
    probe: &dyn Fn(&Path, &Manifest) -> Result<(), String>,
) -> RuntimeResult<BundledRuntime> {
    if !prefix.is_absolute()
        || prefix
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Err("The OpenClaw home must be an absolute, non-traversing path.".into());
    }
    let manifest: Manifest =
        serde_json::from_str(manifest_bytes).map_err(|_| missing_runtime_message().to_string())?;
    validate_manifest(&manifest)?;
    verify_payload(source, manifest_bytes, &manifest, true)?;
    let store = prefix.join("tools/desktop-runtime");
    ensure_directory(&store)?;
    let destination = runtime_directory(prefix, manifest_bytes, &manifest);
    if fs::symlink_metadata(&destination).is_ok() {
        verify_payload(&destination, manifest_bytes, &manifest, false)?;
    } else {
        let staging = store.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging)?;
        let result: RuntimeResult<()> = (|| {
            for file in manifest.files.keys() {
                let output = staging.join(file);
                ensure_directory(output.parent().expect("runtime file parent"))?;
                let mut input = open_payload(&source.join(file), manifest.platform == "linux")?;
                let mut output_file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output)?;
                std::io::copy(&mut input, &mut output_file)?;
                output_file.sync_all()?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(output, fs::Permissions::from_mode(0o555))?;
                }
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join("manifest.json"))?;
            output.write_all(manifest_bytes.as_bytes())?;
            output.sync_all()?;
            // Windows cannot rename the runtime directory while its manifest is open.
            drop(output);
            verify_payload(&staging, manifest_bytes, &manifest, false)?;
            probe(&staging.join(&manifest.runtime.executable), &manifest)?;
            // Windows flushes each file above; Rust cannot open directory handles for
            // fsync there. Atomic publication still prevents partial runtime copies.
            #[cfg(unix)]
            for directory in payload_directories(&manifest).iter().rev() {
                fs::File::open(staging.join(directory))
                    .and_then(|directory| directory.sync_all())?;
            }
            #[cfg(unix)]
            fs::File::open(&staging).and_then(|directory| directory.sync_all())?;
            // Never repair or overwrite a previously published runtime in place:
            // a service or CLI launcher may still reference those exact bytes.
            if fs::symlink_metadata(&destination).is_ok() {
                verify_payload(&destination, manifest_bytes, &manifest, false)?;
            } else {
                fs::rename(&staging, &destination)?;
                #[cfg(unix)]
                fs::File::open(&store).and_then(|directory| directory.sync_all())?;
            }
            Ok(())
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        result?;
    }
    // Windows canonical paths include the extended prefix required by runtime admission.
    #[cfg(target_os = "windows")]
    let destination = fs::canonicalize(destination)?;
    Ok(BundledRuntime {
        executable: destination.join(&manifest.runtime.executable),
        flavor: manifest.runtime.flavor,
        entry: manifest.entry().map(|entry| destination.join(entry)),
        sqlite: manifest
            .files
            .contains_key("lib/libsqlite3.dylib")
            .then(|| destination.join("lib/libsqlite3.dylib")),
    })
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let safe_path = |path: &str| {
        !path.contains(['\\', ':'])
            && !path.starts_with('/')
            && !path.split('/').any(|part| matches!(part, "" | "." | ".."))
    };
    let safe_tag = !manifest.tag.is_empty()
        && manifest
            .tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
        && manifest.tag != "."
        && manifest.tag != "..";
    let common_valid = safe_tag
        && manifest.platform == platform
        && manifest.arch == arch
        && matches!(platform, "linux" | "darwin" | "windows")
        && manifest.commit.len() == 40
        && manifest.commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !manifest.revision.is_empty()
        && manifest.files.contains_key(&manifest.runtime.executable)
        && manifest.files.keys().all(|file| safe_path(file))
        && manifest
            .files
            .values()
            .all(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        && manifest
            .entry()
            .is_none_or(|entry| manifest.files.contains_key(entry));
    let flavor_valid = match manifest.runtime.flavor {
        RuntimeFlavor::Jit => {
            manifest.runtime.executable == BUN_PATH
                && manifest.runtime.standalone.is_none()
                && (platform != "darwin" || manifest.files.contains_key("lib/libsqlite3.dylib"))
                && manifest.entry().is_none_or(|entry| entry == PACKAGE_ENTRY)
                && manifest.files.keys().all(|file| {
                    file == BUN_PATH
                        || file == "lib/libsqlite3.dylib"
                        || (file.starts_with("package/") && manifest.entry().is_some())
                })
                && (platform != "windows"
                    || (manifest.authenticode_signed == Some(true)
                        && manifest.test_only == Some(false)))
        }
        RuntimeFlavor::Aot => manifest
            .runtime
            .standalone
            .as_ref()
            .is_some_and(|standalone| {
                platform != "windows"
                    && (platform != "darwin" || arch == "arm64")
                    && manifest.runtime.entry.is_none()
                    && standalone.get("mode").and_then(serde_json::Value::as_str) == Some("aot")
                    && standalone
                        .pointer("/target/platform")
                        .and_then(serde_json::Value::as_str)
                        == Some(platform)
                    && standalone
                        .pointer("/target/arch")
                        .and_then(serde_json::Value::as_str)
                        == Some(arch)
                    && standalone
                        .pointer("/executable/path")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|path| {
                            manifest.runtime.executable == format!("standalone/{path}")
                        })
                    && standalone
                        .pointer("/executable/sha256")
                        .and_then(serde_json::Value::as_str)
                        == manifest
                            .files
                            .get(&manifest.runtime.executable)
                            .map(String::as_str)
                    && manifest.files.contains_key("standalone/manifest.json")
                    && manifest
                        .files
                        .keys()
                        .all(|file| file.starts_with("standalone/"))
            }),
    };
    if !common_valid || !flavor_valid {
        return Err("Embedded runtime identity does not match this app platform.".into());
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> RuntimeResult<()> {
    if let Some(parent) = path.parent().filter(|parent| *parent != path) {
        ensure_directory(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(Into::into)
        }
        _ => Err(format!(
            "Runtime directory is unavailable or redirected: {}",
            path.display()
        )
        .into()),
    }
}

fn payload_directories(manifest: &Manifest) -> BTreeSet<PathBuf> {
    manifest
        .files
        .keys()
        .flat_map(|file| {
            Path::new(file)
                .ancestors()
                .skip(1)
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf)
        })
        .collect()
}

fn verify_payload(
    root: &Path,
    bytes: &str,
    manifest: &Manifest,
    bundled: bool,
) -> RuntimeResult<()> {
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() {
        return Err("Embedded runtime directory is redirected.".into());
    }
    let mut expected: Vec<PathBuf> = manifest.files.keys().map(PathBuf::from).collect();
    expected.extend(payload_directories(manifest));
    expected.push(PathBuf::from("manifest.json"));
    let mut observed = Vec::new();
    collect_files(root, Path::new(""), &mut observed)?;
    expected.sort();
    observed.sort();
    if observed != expected || fs::read(root.join("manifest.json"))? != bytes.as_bytes() {
        return Err("Embedded runtime manifest or file set changed; reinstall the app.".into());
    }
    for (file, expected_hash) in &manifest.files {
        let mut input = open_payload(&root.join(file), bundled && manifest.platform == "linux")?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let actual: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if actual != *expected_hash {
            return Err(
                format!("Embedded runtime checksum changed: {file}; reinstall the app.").into(),
            );
        }
    }
    Ok(())
}

fn open_payload(path: &Path, enveloped: bool) -> RuntimeResult<fs::File> {
    let mut input = fs::File::open(path)?;
    if enveloped {
        // The Linux bundle is data so linuxdeploy cannot rewrite its ELF bytes.
        // Installed executables have no envelope and retain the admitted hash.
        let mut prefix = [0; LINUX_RESOURCE_PREFIX.len()];
        if input.read_exact(&mut prefix).is_err() || prefix != LINUX_RESOURCE_PREFIX {
            return Err("Embedded Bun resource envelope changed; reinstall the app.".into());
        }
    }
    Ok(input)
}

fn collect_files(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> RuntimeResult<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let file = relative.join(entry.file_name());
        if kind.is_file() {
            files.push(file);
        } else if kind.is_dir() {
            files.push(file.clone());
            collect_files(root, &file, files)?;
        } else {
            return Err("Embedded runtime contains redirected or unexpected files.".into());
        }
    }
    Ok(())
}

fn verify_revision(bun: &Path, manifest: &Manifest) -> Result<(), String> {
    if manifest.runtime.flavor == RuntimeFlavor::Aot {
        let expected = manifest
            .runtime
            .standalone
            .as_ref()
            .and_then(|value| value.pointer("/openclaw/version"))
            .and_then(serde_json::Value::as_str)
            .ok_or("Standalone manifest has no OpenClaw version.")?;
        let probe = bun
            .parent()
            .ok_or("Embedded executable has no parent.")?
            .join(format!(".probe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&probe).map_err(|error| error.to_string())?;
        let output = Command::new(bun)
            .arg("--version")
            .env_clear()
            .env("HOME", &probe)
            .env("OPENCLAW_STATE_DIR", &probe)
            .env("OPENCLAW_CONFIG_PATH", probe.join("openclaw.json"))
            .env("TMPDIR", &probe)
            .env("TMP", &probe)
            .env("TEMP", &probe)
            .output();
        let cleanup = fs::remove_dir_all(&probe);
        let output =
            output.map_err(|error| format!("Embedded AOT executable cannot run: {error}"))?;
        cleanup.map_err(|error| format!("Embedded runtime probe cleanup failed: {error}"))?;
        let version = String::from_utf8_lossy(&output.stdout);
        let version = version
            .trim()
            .strip_prefix("OpenClaw ")
            .unwrap_or(version.trim());
        if !output.status.success() || version.split_whitespace().next() != Some(expected) {
            return Err("Embedded AOT executable did not report its admitted version.".into());
        }
        return Ok(());
    }
    for (args, expected) in [
        (vec!["--revision"], manifest.revision.as_str()),
        (vec!["-p", "Bun.revision"], manifest.commit.as_str()),
    ] {
        let output = Command::new(bun)
            .args(args)
            .env_clear()
            .output()
            .map_err(|error| format!("Embedded Bun cannot run: {error}"))?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != expected {
            return Err("Embedded Bun did not report the admitted fork revision.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "bundled_runtime_tests.rs"]
mod tests;
