use crate::runtime_action::BundledRuntime;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{path::BaseDirectory, AppHandle, Manager};

const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/desktop-runtime.json"));
const LINUX_RESOURCE_PREFIX: &[u8] = b"OPENCLAW-BUN-RUNTIME-V1\n";
const BUN_PATH: &str = if cfg!(target_os = "windows") {
    "bin/bun.exe"
} else {
    "bin/bun"
};

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
    #[serde(default, rename = "authenticodeSigned")]
    authenticode_signed: Option<bool>,
    #[serde(default, rename = "testOnly")]
    test_only: Option<bool>,
}

pub(crate) fn expected_bun_path() -> Result<PathBuf, String> {
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
    let path = runtime_directory(&prefix, MANIFEST, &manifest).join(BUN_PATH);
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
    prefix
        .join("tools/desktop-runtime")
        .join(format!("{}-{digest}", manifest.tag))
}

pub(crate) fn seed(app: &AppHandle) -> Result<BundledRuntime, String> {
    let source = app
        .path()
        .resolve("desktop-runtime", BaseDirectory::Resource)
        .map_err(|error| format!("Embedded runtime resources are unavailable: {error}"))?;
    let prefix = crate::cli::openclaw_home().map_err(|error| error.to_string())?;
    seed_at(&source, &prefix, MANIFEST, &verify_revision).map_err(|error| error.to_string())
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
            verify_payload(&staging, manifest_bytes, &manifest, false)?;
            probe(&staging.join(BUN_PATH), &manifest)?;
            // Windows flushes each file above; Rust cannot open directory handles for
            // fsync there. Atomic publication still prevents partial runtime copies.
            #[cfg(unix)]
            for directory in [
                Some(staging.join("bin")),
                manifest
                    .files
                    .contains_key("lib/libsqlite3.dylib")
                    .then(|| staging.join("lib")),
                Some(staging.clone()),
            ]
            .into_iter()
            .flatten()
            {
                fs::File::open(directory).and_then(|directory| directory.sync_all())?;
            }
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
        bun: destination.join(BUN_PATH),
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
    let expected = if platform == "darwin" { 2 } else { 1 };
    let safe_tag = !manifest.tag.is_empty()
        && manifest
            .tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
        && manifest.tag != "."
        && manifest.tag != "..";
    if !safe_tag
        || manifest.platform != platform
        || manifest.arch != arch
        || !matches!(platform, "linux" | "darwin" | "windows")
        || (platform == "windows"
            && (manifest.authenticode_signed != Some(true) || manifest.test_only != Some(false)))
        || manifest.commit.len() != 40
        || !manifest.commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.revision.is_empty()
        || manifest.files.len() != expected
        || !manifest.files.contains_key(BUN_PATH)
        || (platform == "darwin" && !manifest.files.contains_key("lib/libsqlite3.dylib"))
        || manifest
            .files
            .values()
            .any(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
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
    expected.push(PathBuf::from("bin"));
    if manifest.files.contains_key("lib/libsqlite3.dylib") {
        expected.push(PathBuf::from("lib"));
    }
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
        } else if kind.is_dir()
            && relative.as_os_str().is_empty()
            && matches!(file.to_str(), Some("bin" | "lib"))
        {
            files.push(file.clone());
            collect_files(root, &file, files)?;
        } else {
            return Err("Embedded runtime contains redirected or unexpected files.".into());
        }
    }
    Ok(())
}

fn verify_revision(bun: &Path, manifest: &Manifest) -> Result<(), String> {
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
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        prefix: PathBuf,
        manifest: String,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("bundled-runtime-{}", uuid::Uuid::new_v4()));
            let source = root.join("app-resources");
            fs::create_dir_all(source.join("bin")).unwrap();
            write_source(&source, b"synthetic runtime");
            let mut files = BTreeMap::from([(
                BUN_PATH,
                Sha256::digest(b"synthetic runtime")
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            )]);
            if cfg!(target_os = "macos") {
                fs::create_dir(source.join("lib")).unwrap();
                fs::write(source.join("lib/libsqlite3.dylib"), "synthetic sqlite").unwrap();
                files.insert(
                    "lib/libsqlite3.dylib",
                    Sha256::digest(b"synthetic sqlite")
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>(),
                );
            }
            let manifest = serde_json::json!({ "tag": "test-fork", "commit": "a".repeat(40), "revision": "test-revision",
                "platform": if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS },
                "arch": if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }, "files": files,
                "authenticodeSigned": true, "testOnly": false }).to_string();
            fs::write(source.join("manifest.json"), &manifest).unwrap();
            Self {
                prefix: root.join("state"),
                root,
                source,
                manifest,
            }
        }

        fn seed(&self) -> Result<BundledRuntime, String> {
            seed_at(&self.source, &self.prefix, &self.manifest, &|_, _| Ok(()))
                .map_err(|error| error.to_string())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_source(source: &Path, bytes: &[u8]) {
        let encoded = if cfg!(target_os = "linux") {
            [LINUX_RESOURCE_PREFIX, bytes].concat()
        } else {
            bytes.to_vec()
        };
        fs::write(source.join(BUN_PATH), encoded).unwrap();
    }

    #[test]
    fn publishes_a_durable_verified_copy_and_reuses_it() {
        let fixture = Fixture::new();
        let runtime = fixture.seed().unwrap();
        assert!(runtime
            .bun
            .starts_with(fixture.prefix.join("tools/desktop-runtime")));
        assert_eq!(fs::read(&runtime.bun).unwrap(), b"synthetic runtime");
        assert_eq!(fixture.seed().unwrap().bun, runtime.bun);
        fs::remove_dir_all(&fixture.source).unwrap();
        assert!(
            runtime.bun.is_file(),
            "the service must survive an AppImage unmount"
        );
    }

    #[test]
    fn staging_an_update_retains_the_runtime_referenced_by_an_existing_service() {
        let fixture = Fixture::new();
        let previous = fixture.seed().unwrap();
        let service =
            serde_json::json!({ "programArguments": [previous.bun, "/app/entry.js", "gateway"] });
        let mut next: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
        next["tag"] = "newer-bundle".into();
        let next = next.to_string();
        fs::write(fixture.source.join("manifest.json"), &next).unwrap();
        let current = seed_at(&fixture.source, &fixture.prefix, &next, &|_, _| Ok(())).unwrap();
        assert_ne!(previous.bun, current.bun);
        let referenced = Path::new(service["programArguments"][0].as_str().unwrap());
        assert_eq!(fs::read(referenced).unwrap(), b"synthetic runtime");
        assert!(referenced
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("manifest.json")
            .is_file());
    }

    #[test]
    fn rejects_modified_source_and_installed_payload_without_overwriting() {
        let fixture = Fixture::new();
        write_source(&fixture.source, b"modified");
        assert!(fixture.seed().unwrap_err().contains("checksum changed"));
        write_source(&fixture.source, b"synthetic runtime");
        let runtime = fixture.seed().unwrap();
        fs::remove_file(&runtime.bun).unwrap();
        fs::write(&runtime.bun, "operator replacement").unwrap();
        assert!(fixture.seed().is_err());
        assert_eq!(fs::read(&runtime.bun).unwrap(), b"operator replacement");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_corrupted_missing_or_truncated_resource_envelope() {
        let fixture = Fixture::new();
        let mut corrupt = [LINUX_RESOURCE_PREFIX, b"synthetic runtime"].concat();
        corrupt[0] = b'!';
        for bytes in [
            corrupt,
            b"synthetic runtime".to_vec(),
            LINUX_RESOURCE_PREFIX[..5].to_vec(),
        ] {
            fs::write(fixture.source.join("bin/bun"), bytes).unwrap();
            assert!(fixture
                .seed()
                .unwrap_err()
                .contains("resource envelope changed"));
            assert!(
                !fixture.prefix.exists(),
                "reject invalid resources before installation"
            );
        }
    }

    #[test]
    fn wrong_revision_never_publishes() {
        let fixture = Fixture::new();
        assert!(seed_at(
            &fixture.source,
            &fixture.prefix,
            &fixture.manifest,
            &|_, _| Err("wrong fork".into())
        )
        .is_err());
        assert_eq!(
            fs::read_dir(fixture.prefix.join("tools/desktop-runtime"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plain_windows_home_seeds_a_runtime_accepted_by_launcher_binding() {
        let mut fixture = Fixture::new();
        fixture.prefix = PathBuf::from(
            fixture
                .prefix
                .to_str()
                .unwrap()
                .strip_prefix(r"\\?\")
                .unwrap(),
        );
        let runtime = fixture.seed().unwrap();
        let entry = fixture.prefix.join("package").join("entry.js");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, "synthetic entry").unwrap();
        crate::runtime_action::install_launcher(
            &fixture.prefix,
            &runtime,
            &entry,
            crate::runtime_action::Purpose::Gateway,
        )
        .unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn refuses_unsigned_test_only_or_foreign_runtime_before_installation() {
        let fixture = Fixture::new();
        for (field, value) in [
            ("authenticodeSigned", serde_json::json!(false)),
            ("testOnly", serde_json::json!(true)),
            ("platform", serde_json::json!("linux")),
        ] {
            let mut manifest: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
            manifest[field] = value;
            assert!(seed_at(
                &fixture.source,
                &fixture.prefix,
                &manifest.to_string(),
                &|_, _| Ok(())
            )
            .is_err());
            assert!(!fixture.prefix.exists());
        }
    }

    #[test]
    fn rejects_missing_manifest_identity_and_unexpected_resources() {
        let fixture = Fixture::new();
        assert!(
            seed_at(&fixture.source, &fixture.prefix, "{}", &|_, _| Ok(()))
                .unwrap_err()
                .to_string()
                .contains(missing_runtime_message())
        );
        fs::write(fixture.source.join("extra"), "unexpected").unwrap();
        assert!(fixture.seed().is_err());
        fs::remove_file(fixture.source.join("extra")).unwrap();
        fs::write(fixture.source.join("manifest.json"), "{}").unwrap();
        assert!(fixture.seed().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_redirected_install_directory_and_source_file() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        symlink(&fixture.source, &fixture.prefix).unwrap();
        assert!(fixture.seed().is_err());
        fs::remove_file(&fixture.prefix).unwrap();
        fs::remove_file(fixture.source.join("bin/bun")).unwrap();
        symlink(
            fixture.source.join("manifest.json"),
            fixture.source.join("bin/bun"),
        )
        .unwrap();
        assert!(fixture.seed().is_err());
    }
}
