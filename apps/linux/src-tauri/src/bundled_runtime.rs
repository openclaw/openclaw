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
const RESOURCE_PREFIX: &[u8] = b"OPENCLAW-BUN-RUNTIME-V1\n";

type RuntimeResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    tag: String,
    commit: String,
    revision: Option<String>,
    platform: String,
    arch: String,
    #[serde(rename = "authenticodeSigned")]
    authenticode_signed: Option<bool>,
    #[serde(rename = "testOnly")]
    test_only: Option<bool>,
    files: BTreeMap<String, String>,
}

pub(crate) fn available() -> bool {
    serde_json::from_str::<Manifest>(MANIFEST)
        .is_ok_and(|manifest| validate_manifest(&manifest).is_ok())
}

fn bun_file() -> &'static str {
    if cfg!(windows) {
        "bin/bun.exe"
    } else {
        "bin/bun"
    }
}

fn executable_path(directory: &Path) -> PathBuf {
    let path = directory.join(bun_file());
    #[cfg(windows)]
    return crate::cli::ordinary_windows_path(&path);
    #[cfg(not(windows))]
    path
}

pub(crate) fn expected_bun_path() -> Result<PathBuf, String> {
    let manifest: Manifest = serde_json::from_str(MANIFEST)
        .map_err(|_| "This build has no embedded runtime.".to_string())?;
    validate_manifest(&manifest)?;
    let prefix = crate::cli::openclaw_home().map_err(|error| error.to_string())?;
    Ok(executable_path(&runtime_directory(
        &prefix, MANIFEST, &manifest,
    )))
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
    let manifest: Manifest = serde_json::from_str(manifest_bytes).map_err(|_| {
        "This build has no embedded runtime. Build with the Tauri CLI or run apps/linux/scripts/stage-runtime.mjs before rebuilding.".to_string()
    })?;
    validate_manifest(&manifest)?;
    verify_payload(source, manifest_bytes, &manifest, true)?;
    let store = prefix.join("tools/desktop-runtime");
    ensure_directory(&store)?;
    #[cfg(windows)]
    let _publication = lock_publication(&store)?;
    let destination = runtime_directory(prefix, manifest_bytes, &manifest);
    if path_exists(&destination)? {
        verify_payload(&destination, manifest_bytes, &manifest, false)?;
        #[cfg(windows)]
        probe(&executable_path(&destination), &manifest)?;
    } else {
        let staging = store.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging)?;
        let result: RuntimeResult<()> = (|| {
            for file in manifest.files.keys() {
                let output = staging.join(file);
                ensure_directory(output.parent().expect("runtime file parent"))?;
                let mut input = open_payload(&source.join(file), enveloped(&manifest))?;
                let mut output_file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output)?;
                std::io::copy(&mut input, &mut output_file)?;
                output_file.sync_all()?;
                drop(output_file);
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
            // Windows cannot rename a directory while a child handle denies deletion.
            drop(output);
            verify_payload(&staging, manifest_bytes, &manifest, false)?;
            probe(&executable_path(&staging), &manifest)?;
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
            if path_exists(&destination)? {
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
    #[cfg(windows)]
    let destination = fs::canonicalize(destination)?;
    Ok(BundledRuntime {
        bun: executable_path(&destination),
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
    let admitted = if platform == "windows" {
        (manifest.authenticode_signed == Some(true) && manifest.test_only != Some(true))
            || (cfg!(debug_assertions)
                && manifest.authenticode_signed == Some(false)
                && manifest.test_only == Some(true))
    } else {
        manifest.authenticode_signed.is_none() && manifest.test_only.is_none()
    };
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
        || !admitted
        || manifest.commit.len() != 40
        || !manifest.commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.revision.as_deref().is_some_and(str::is_empty)
        || (platform != "windows" && manifest.revision.is_none())
        || manifest.files.len() != expected
        || !manifest.files.contains_key(bun_file())
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

fn enveloped(manifest: &Manifest) -> bool {
    matches!(manifest.platform.as_str(), "linux" | "windows")
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn path_exists(path: &Path) -> RuntimeResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn lock_publication(store: &Path) -> RuntimeResult<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        // Share reads/writes for cooperating publishers, but never rename/delete the lock.
        .share_mode(3)
        .custom_flags(0x00200000) // FILE_FLAG_OPEN_REPARSE_POINT
        .open(store.join(".publish.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || redirected(&metadata) {
        return Err("Runtime publication lock is redirected.".into());
    }
    file.lock()
        .map_err(|error| format!("Runtime publication lock failed: {error}"))?;
    Ok(file)
}

fn ensure_directory(path: &Path) -> RuntimeResult<()> {
    if let Some(parent) = path.parent().filter(|parent| *parent != path) {
        ensure_directory(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !redirected(&metadata) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(path)?;
                if metadata.is_dir() && !redirected(&metadata) {
                    Ok(())
                } else {
                    Err("Runtime directory is redirected.".into())
                }
            }
            Err(error) => Err(error.into()),
        },
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
    if !metadata.is_dir() || redirected(&metadata) {
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
    let mut recorded_manifest = Vec::new();
    open_payload(&root.join("manifest.json"), false)?.read_to_end(&mut recorded_manifest)?;
    if observed != expected || recorded_manifest != bytes.as_bytes() {
        return Err("Embedded runtime manifest or file set changed; reinstall the app.".into());
    }
    for (file, expected_hash) in &manifest.files {
        let mut input = open_payload(&root.join(file), bundled && enveloped(manifest))?;
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
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || redirected(&metadata) {
        return Err("Embedded runtime file is redirected or not regular.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep each admitted read stable against a concurrent writer or rename.
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut input = options.open(path)?;
    let metadata = input.metadata()?;
    if !metadata.is_file() || redirected(&metadata) {
        return Err("Embedded runtime file is redirected or not regular.".into());
    }
    if enveloped {
        // The Linux bundle is data so linuxdeploy cannot rewrite its ELF bytes.
        // Installed executables have no envelope and retain the admitted hash.
        let mut prefix = [0; RESOURCE_PREFIX.len()];
        if input.read_exact(&mut prefix).is_err() || prefix != RESOURCE_PREFIX {
            return Err("Embedded Bun resource envelope changed; reinstall the app.".into());
        }
    }
    Ok(input)
}

fn collect_files(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> RuntimeResult<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if redirected(&fs::symlink_metadata(entry.path())?) {
            return Err("Embedded runtime contains redirected files.".into());
        }
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
    let mut probes = Vec::new();
    if let Some(revision) = &manifest.revision {
        probes.push((vec!["--revision"], revision.as_str()));
    }
    probes.push((vec!["-p", "Bun.revision"], manifest.commit.as_str()));
    for (args, expected) in probes {
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
                .join(format!("bundled runtime-雪-{}", uuid::Uuid::new_v4()));
            #[cfg(windows)]
            let root = crate::cli::ordinary_windows_path(&root);
            let source = root.join("app-resources");
            fs::create_dir_all(source.join("bin")).unwrap();
            write_source(&source, b"synthetic runtime");
            let mut files = BTreeMap::from([(
                bun_file(),
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
            let mut manifest = serde_json::json!({ "tag": "test-fork", "commit": "a".repeat(40), "revision": "test-revision",
                "platform": if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS },
                "arch": if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }, "files": files });
            if cfg!(windows) {
                manifest["authenticodeSigned"] = true.into();
            }
            let manifest = manifest.to_string();
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
        let encoded = if cfg!(any(target_os = "linux", windows)) {
            [RESOURCE_PREFIX, bytes].concat()
        } else {
            bytes.to_vec()
        };
        fs::write(source.join(bun_file()), encoded).unwrap();
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

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn rejects_corrupted_missing_or_truncated_resource_envelope() {
        let fixture = Fixture::new();
        let mut corrupt = [RESOURCE_PREFIX, b"synthetic runtime"].concat();
        corrupt[0] = b'!';
        for bytes in [
            corrupt,
            b"synthetic runtime".to_vec(),
            RESOURCE_PREFIX[..5].to_vec(),
        ] {
            fs::write(fixture.source.join(bun_file()), bytes).unwrap();
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
            usize::from(cfg!(windows))
        );
    }

    #[test]
    fn rejects_missing_manifest_identity_and_unexpected_resources() {
        let fixture = Fixture::new();
        assert!(
            seed_at(&fixture.source, &fixture.prefix, "{}", &|_, _| Ok(()))
                .unwrap_err()
                .to_string()
                .contains("no embedded runtime")
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
        fs::remove_file(fixture.source.join(bun_file())).unwrap();
        symlink(
            fixture.source.join("manifest.json"),
            fixture.source.join(bun_file()),
        )
        .unwrap();
        assert!(fixture.seed().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_admission_requires_signed_release_or_explicit_unsigned_debug_proof() {
        let fixture = Fixture::new();
        let original: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
        for (signed, test_only, accepted) in [
            (None, None, false),
            (Some(false), None, false),
            (Some(true), None, true),
            (Some(true), Some(true), false),
            (None, Some(true), false),
            (Some(false), Some(true), cfg!(debug_assertions)),
        ] {
            let mut value = original.clone();
            value.as_object_mut().unwrap().remove("revision");
            value["authenticodeSigned"] = signed.into();
            value["testOnly"] = test_only.into();
            let manifest: Manifest = serde_json::from_value(value).unwrap();
            assert_eq!(validate_manifest(&manifest).is_ok(), accepted);
        }
        let mut other_arch = original;
        other_arch["arch"] = if cfg!(target_arch = "aarch64") {
            "x64"
        } else {
            "arm64"
        }
        .into();
        let manifest: Manifest = serde_json::from_value(other_arch).unwrap();
        assert!(validate_manifest(&manifest).is_err());
        let runtime = fixture.seed().unwrap();
        assert!(runtime.bun.ends_with("bin/bun.exe"));
        assert!(!runtime.bun.to_string_lossy().starts_with(r"\\?\"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_reuses_open_runtime_and_keeps_read_and_publication_handles_stable() {
        let fixture = Fixture::new();
        let runtime = fixture.seed().unwrap();
        let reader = open_payload(&runtime.bun, false).unwrap();
        assert_eq!(fixture.seed().unwrap().bun, runtime.bun);
        assert!(fs::write(&runtime.bun, "replacement").is_err());
        assert!(fs::rename(&runtime.bun, runtime.bun.with_extension("old")).is_err());
        drop(reader);
        let store = fixture.prefix.join("tools/desktop-runtime");
        let publication = lock_publication(&store).unwrap();
        assert!(fs::rename(store.join(".publish.lock"), store.join("old-lock")).is_err());
        assert!(fs::remove_file(store.join(".publish.lock")).is_err());
        drop(publication);
    }

    #[cfg(windows)]
    #[test]
    fn windows_concurrent_publishers_share_one_immutable_directory() {
        let fixture = Fixture::new();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                fixture.seed().unwrap()
            });
            let second = scope.spawn(|| {
                barrier.wait();
                fixture.seed().unwrap()
            });
            assert_eq!(first.join().unwrap(), second.join().unwrap());
        });
        let entries: Vec<_> = fs::read_dir(fixture.prefix.join("tools/desktop-runtime"))
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_type().unwrap().is_dir())
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0]
            .file_name()
            .to_string_lossy()
            .starts_with(".stage-"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_junctions_and_reparse_source_files() {
        let fixture = Fixture::new();
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&fixture.prefix)
            .arg(&fixture.source)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(fixture.seed().unwrap_err().contains("redirected"));
        fs::remove_dir(&fixture.prefix).unwrap();
        fs::remove_file(fixture.source.join(bun_file())).unwrap();
        std::os::windows::fs::symlink_file(
            fixture.source.join("manifest.json"),
            fixture.source.join(bun_file()),
        )
        .unwrap();
        assert!(fixture.seed().unwrap_err().contains("redirected"));
    }
}
