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

    fn next_seed(&mut self, tag: &str) -> BundledRuntime {
        let mut manifest: serde_json::Value = serde_json::from_str(&self.manifest).unwrap();
        manifest["tag"] = tag.into();
        self.manifest = manifest.to_string();
        fs::write(self.source.join("manifest.json"), &self.manifest).unwrap();
        self.seed().unwrap()
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
fn publishes_nested_package_bytes_and_rejects_modified_or_traversing_resources() {
    let mut fixture = Fixture::new();
    let mut manifest: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    manifest["tag"] = serde_json::json!("signed-runtime-".repeat(4));
    for file in [
        PACKAGE_ENTRY,
        "package/node_modules/openclaw/dist/extensions/codex/index.js",
    ] {
        let output = fixture.source.join(file);
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        let content = b"synthetic package bytes";
        let bytes = if cfg!(target_os = "linux") {
            [LINUX_RESOURCE_PREFIX, content].concat()
        } else {
            content.to_vec()
        };
        fs::write(output, bytes).unwrap();
        manifest["files"][file] = serde_json::json!(Sha256::digest(content)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>());
    }
    fixture.manifest = manifest.to_string();
    fs::write(fixture.source.join("manifest.json"), &fixture.manifest).unwrap();
    let parsed = serde_json::from_str(&fixture.manifest).unwrap();
    let directory = runtime_directory(
        Path::new("C:/Users/desktop-user.DESKTOP-1234567/.openclaw"),
        &fixture.manifest,
        &parsed,
    );
    let codex = directory.join(
        "package/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
    assert!(codex.to_string_lossy().encode_utf16().count() < 260);
    let runtime = fixture.seed().unwrap();
    let entry = runtime
        .executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(PACKAGE_ENTRY);
    assert_eq!(fs::read(&entry).unwrap(), b"synthetic package bytes");
    assert_eq!(fixture.seed().unwrap().executable, runtime.executable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o644)).unwrap();
    }
    fs::write(&entry, "modified").unwrap();
    assert!(fixture.seed().unwrap_err().contains("checksum changed"));
    manifest["files"]["package/../../escape"] = serde_json::json!("a".repeat(64));
    assert!(validate_manifest(&serde_json::from_value(manifest).unwrap()).is_err());
}

#[test]
fn publishes_a_durable_verified_copy_and_reuses_it() {
    let fixture = Fixture::new();
    let runtime = fixture.seed().unwrap();
    assert!(runtime
        .executable
        .starts_with(fixture.prefix.join("tools/desktop-runtime")));
    assert!(runtime
        .executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("test-fork-"));
    assert_eq!(fs::read(&runtime.executable).unwrap(), b"synthetic runtime");
    assert_eq!(fixture.seed().unwrap().executable, runtime.executable);
    fs::remove_dir_all(&fixture.source).unwrap();
    assert!(
        runtime.executable.is_file(),
        "the service must survive an AppImage unmount"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn darwin_jit_requires_and_verifies_its_bundled_sqlite() {
    let fixture = Fixture::new();
    let runtime = fixture.seed().unwrap();
    let sqlite = runtime.sqlite.unwrap();
    assert_eq!(fs::read(&sqlite).unwrap(), b"synthetic sqlite");
    fs::remove_file(&sqlite).unwrap();
    fs::write(&sqlite, "modified sqlite").unwrap();
    assert!(fixture.seed().unwrap_err().contains("checksum changed"));

    let mut manifest: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    manifest["files"]
        .as_object_mut()
        .unwrap()
        .remove("lib/libsqlite3.dylib");
    fs::remove_file(fixture.source.join("lib/libsqlite3.dylib")).unwrap();
    fs::remove_dir(fixture.source.join("lib")).unwrap();
    let bytes = manifest.to_string();
    fs::write(fixture.source.join("manifest.json"), &bytes).unwrap();
    let error = seed_at(&fixture.source, &fixture.prefix, &bytes, &|_, _| Ok(()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("identity does not match"), "{error}");
}

#[test]
fn staging_an_update_retains_the_runtime_referenced_by_an_existing_service() {
    let fixture = Fixture::new();
    let previous = fixture.seed().unwrap();
    let service = serde_json::json!({ "programArguments": [previous.executable, "/app/entry.js", "gateway"] });
    let mut next: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    next["tag"] = "newer-bundle".into();
    let next = next.to_string();
    fs::write(fixture.source.join("manifest.json"), &next).unwrap();
    let current = seed_at(&fixture.source, &fixture.prefix, &next, &|_, _| Ok(())).unwrap();
    assert_ne!(previous.executable, current.executable);
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
fn successive_healthy_collections_retain_current_previous_service_pin_and_live_seeds() {
    let mut fixture = Fixture::new();
    let service = fixture.next_seed("service");
    let pin = fixture.next_seed("pin");
    let live = fixture.next_seed("live");
    let obsolete = fixture.next_seed("obsolete");
    let previous = fixture.next_seed("previous");
    let current = fixture.next_seed("current");
    let unknown = fixture.prefix.join("tools/desktop-runtime/operator-files");
    fs::create_dir(&unknown).unwrap();
    fs::write(unknown.join("keep"), "operator data").unwrap();
    let references = [
        current.executable.clone(),
        previous.executable.clone(),
        service.executable.clone(),
        pin.executable.clone(),
    ];
    retention::collect(&fixture.prefix, &references, &|_| {
        Ok(vec![live.executable.clone()])
    })
    .unwrap();
    assert!(!obsolete.executable.exists());
    for runtime in [&current, &previous, &service, &pin, &live] {
        assert!(runtime.executable.is_file());
    }
    // Once the service, pin and live process release them, the next healthy cycle reclaims them.
    retention::collect(&fixture.prefix, &references[..2], &|_| Ok(vec![])).unwrap();
    for runtime in [&service, &pin, &live] {
        assert!(!runtime.executable.exists());
    }
    assert!(current.executable.is_file());
    assert!(previous.executable.is_file());
    assert_eq!(
        fs::read_to_string(unknown.join("keep")).unwrap(),
        "operator data"
    );
}

#[test]
fn unreadable_processes_or_references_prune_nothing() {
    let mut fixture = Fixture::new();
    let old = fixture.next_seed("old");
    let current = fixture.next_seed("current");
    assert!(
        retention::collect(&fixture.prefix, &[current.executable.clone()], &|_| Err(
            "unreadable census".into()
        ))
        .is_err()
    );
    assert!(old.executable.is_file());
    assert!(
        retention::collect(&fixture.prefix, &[fixture.root.join("missing")], &|_| Ok(
            vec![]
        ))
        .is_err()
    );
    assert!(old.executable.is_file());
    assert!(current.executable.is_file());
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[test]
fn running_seed_is_retained_until_the_process_exits() {
    let mut fixture = Fixture::new();
    #[cfg(target_os = "linux")]
    let executable = PathBuf::from("/bin/cat");
    #[cfg(target_os = "windows")]
    let executable =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
    let bytes = fs::read(executable).unwrap();
    write_source(&fixture.source, &bytes);
    let mut manifest: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    manifest["files"][BUN_PATH] = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .into();
    fixture.manifest = manifest.to_string();
    let live = fixture.next_seed("live");
    let mut command = Command::new(&live.executable);
    #[cfg(target_os = "windows")]
    command.args([
        "/d",
        "/q",
        "/c",
        "set /p openclaw_input=& echo retention child ready& set /p openclaw_exit=& exit /b 0",
    ]);
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"retention child ready\r\n")
        .unwrap();
    // The child acknowledges its entry point without sleeps or process polling.
    use std::io::BufRead;
    let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(output.read_line(&mut line).unwrap() > 0);
        if line.contains("retention child ready") {
            break;
        }
    }
    let current = fixture.next_seed("current");
    #[cfg(target_os = "linux")]
    let pid = child.id();
    let collect = || {
        #[cfg(target_os = "linux")]
        return retention::collect(&fixture.prefix, &[current.executable.clone()], &|_| {
            // The hosted runner can hide unrelated processes; inspect only this owned fixture.
            Ok(
                retention::executable_path(&PathBuf::from(format!("/proc/{pid}")))?
                    .into_iter()
                    .collect(),
            )
        });
        #[cfg(target_os = "windows")]
        collect_after_healthy(&fixture.prefix, &[current.executable.clone()])
    };
    collect().unwrap();
    assert!(live.executable.is_file());
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    collect().unwrap();
    assert!(!live.executable.exists());
    assert!(current.executable.is_file());
}

#[test]
fn rejects_modified_source_and_installed_payload_without_overwriting() {
    let fixture = Fixture::new();
    write_source(&fixture.source, b"modified");
    assert!(fixture.seed().unwrap_err().contains("checksum changed"));
    write_source(&fixture.source, b"synthetic runtime");
    let runtime = fixture.seed().unwrap();
    fs::remove_file(&runtime.executable).unwrap();
    fs::write(&runtime.executable, "operator replacement").unwrap();
    assert!(fixture.seed().is_err());
    assert_eq!(
        fs::read(&runtime.executable).unwrap(),
        b"operator replacement"
    );
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

#[cfg(unix)]
fn aot_fixture() -> Fixture {
    let mut fixture = Fixture::new();
    fs::remove_dir_all(&fixture.source).unwrap();
    fs::create_dir_all(fixture.source.join("standalone/runtime")).unwrap();
    let executable = b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n";
    let hash = |bytes: &[u8]| {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let standalone = serde_json::json!({
        "schemaVersion": 1, "mode": "aot", "openclaw": {"version": "2026.10.1"},
        "target": {"platform": if cfg!(target_os = "macos") {"darwin"} else {"linux"},
            "arch": if cfg!(target_arch = "aarch64") {"arm64"} else {"x64"}},
        "executable": {"path": "openclaw", "sha256": hash(executable)},
        "runtime": {"path": "runtime"}
    });
    let standalone_bytes = standalone.to_string();
    let files = [
        ("standalone/openclaw", executable.as_slice()),
        ("standalone/manifest.json", standalone_bytes.as_bytes()),
        (
            "standalone/runtime/asset.txt",
            b"retained sidecar".as_slice(),
        ),
    ];
    let mut inventory = BTreeMap::new();
    for (name, bytes) in files {
        let resource = if cfg!(target_os = "linux") {
            [LINUX_RESOURCE_PREFIX, bytes].concat()
        } else {
            bytes.to_vec()
        };
        fs::write(fixture.source.join(name), resource).unwrap();
        inventory.insert(name, hash(bytes));
    }
    let mut manifest: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    manifest["files"] = serde_json::to_value(inventory).unwrap();
    manifest["runtime"] = serde_json::json!({"flavor": "aot", "executable": "standalone/openclaw", "standalone": standalone});
    fixture.manifest = manifest.to_string();
    fs::write(fixture.source.join("manifest.json"), &fixture.manifest).unwrap();
    fixture
}

#[cfg(all(unix, not(all(target_os = "macos", target_arch = "x86_64"))))]
#[test]
fn aot_seed_preserves_sidecar_and_launches_cli_arguments_without_a_bun_entry() {
    let fixture = aot_fixture();
    let runtime = fixture.seed().unwrap();
    assert_eq!(runtime.flavor, RuntimeFlavor::Aot);
    assert!(runtime.entry.is_none());
    let mut command = runtime.command(Path::new("/must-not-run/openclaw.mjs"));
    command.args(["doctor", "--non-interactive", "literal $input"]);
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "doctor\n--non-interactive\nliteral $input\n"
    );
    assert_eq!(
        fs::read(
            runtime
                .executable
                .parent()
                .unwrap()
                .join("runtime/asset.txt")
        )
        .unwrap(),
        b"retained sidecar"
    );
    assert_eq!(fixture.seed().unwrap(), runtime);
    let mut mismatched: serde_json::Value = serde_json::from_str(&fixture.manifest).unwrap();
    mismatched["runtime"]["standalone"]["target"]["arch"] = "wrong".into();
    assert!(validate_manifest(&serde_json::from_value(mismatched).unwrap()).is_err());
    let sidecar = runtime
        .executable
        .parent()
        .unwrap()
        .join("runtime/asset.txt");
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(sidecar, "changed").unwrap();
    assert!(fixture.seed().unwrap_err().contains("checksum changed"));
}

#[cfg(all(unix, not(all(target_os = "macos", target_arch = "x86_64"))))]
#[test]
fn jit_to_aot_and_aot_to_aot_seeding_keep_previous_runtime_bytes() {
    let mut fixture = Fixture::new();
    let jit = fixture.seed().unwrap();
    let aot = aot_fixture();
    fixture.source = aot.source.clone();
    fixture.manifest = aot.manifest.clone();
    let first = fixture.seed().unwrap();
    let second = fixture.next_seed("aot-next-build");
    assert_ne!(jit.executable, first.executable);
    assert_ne!(first.executable, second.executable);
    for runtime in [jit, first, second] {
        assert!(runtime.executable.is_file());
    }
}

#[cfg(all(unix, not(all(target_os = "macos", target_arch = "x86_64"))))]
#[test]
fn aot_version_admission_has_private_state_and_removes_its_probe_files() {
    const CHILD: &str = "OPENCLAW_AOT_VERSION_PROBE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", std::thread::current().name().unwrap()])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = aot_fixture();
    let runtime = fixture.seed().unwrap();
    fs::remove_file(&runtime.executable).unwrap();
    assert!(Command::new("/bin/cp")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/standalone-version-probe.sh")
        )
        .arg(&runtime.executable)
        .status()
        .unwrap()
        .success());
    fs::set_permissions(&runtime.executable, fs::Permissions::from_mode(0o555)).unwrap();
    let directory = runtime.executable.parent().unwrap();
    let names = || {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<BTreeSet<_>>()
    };
    let before = names();
    verify_revision(
        &runtime.executable,
        &serde_json::from_str(&fixture.manifest).unwrap(),
    )
    .unwrap();
    assert_eq!(names(), before);
}
