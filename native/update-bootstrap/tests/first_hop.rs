use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::TempDir;
use url::Url;

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn canonical(value: &Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    value
        .serialize(&mut serde_json::Serializer::with_formatter(
            &mut bytes,
            olpc_cjson::CanonicalFormatter::new(),
        ))
        .unwrap();
    bytes
}
struct Key {
    pair: Ed25519KeyPair,
    id: String,
    public: Value,
}
fn key() -> Key {
    let pkcs = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(pkcs.as_ref()).unwrap();
    let public = json!({ "keytype": "ed25519", "scheme": "ed25519", "keyval": { "public": hex::encode(pair.public_key().as_ref()) } });
    Key {
        id: hash(&canonical(&public)),
        pair,
        public,
    }
}
fn signed(value: Value, key: &Key) -> Vec<u8> {
    serde_json::to_vec(&json!({ "signed": value, "signatures": [{ "keyid": key.id, "sig": hex::encode(key.pair.sign(&canonical(&value)).as_ref()) }] })).unwrap()
}
fn directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
struct Fixture {
    _temp: TempDir,
    control: PathBuf,
    installation: PathBuf,
    workspace: PathBuf,
    metadata: PathBuf,
    targets: PathBuf,
    artifacts: PathBuf,
    manifest_sha: String,
    timestamp_key: Key,
}
impl Fixture {
    fn new(expired: bool, corrupt: bool, revoked: bool, actual_runtime: bool) -> Self {
        Self::with_bootstrap(
            expired,
            corrupt,
            revoked,
            actual_runtime,
            fs::read(env!("CARGO_BIN_EXE_openclaw-updater")).unwrap(),
        )
    }
    fn with_bootstrap(
        expired: bool,
        corrupt: bool,
        revoked: bool,
        actual_runtime: bool,
        bootstrap: Vec<u8>,
    ) -> Self {
        let temp = TempDir::new().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let control = base.join("control");
        directory(&control);
        let root_dir = control.join("metadata");
        directory(&root_dir);
        let installation = base.join("old-installation");
        directory(&installation);
        let workspace = base.join("agent-workspace");
        directory(&workspace);
        // The installed loader must never be imported, even if NODE_OPTIONS asks for it.
        write(
            &installation.join("openclaw.mjs"),
            b"throw new Error('INSTALLED_LOADER_EXECUTED');",
        );
        write(
            &installation.join("openclaw.json"),
            b"broken configuration; refuses normal startup",
        );
        let repository = base.join("repository");
        directory(&repository);
        let metadata = repository.join("metadata");
        directory(&metadata);
        let targets = repository.join("targets");
        directory(&targets);
        let artifacts = targets.join("artifacts");
        directory(&artifacts);
        let (version, runtime) = if actual_runtime {
            let node = std::env::var_os("OPENCLAW_TEST_NODE")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::split_paths(&std::env::var_os("PATH")?)
                        .map(|root| root.join("node"))
                        .find(|file| file.is_file())
                })
                .expect("first-hop qualification requires a provisioned test Node executable");
            let version_output = Command::new(&node).arg("--version").output().unwrap();
            assert!(version_output.status.success());
            let version = String::from_utf8(version_output.stdout)
                .unwrap()
                .trim()
                .trim_start_matches('v')
                .to_string();
            let runtime = fs::read(fs::canonicalize(node).unwrap()).unwrap();
            (version, runtime)
        } else {
            // Refusal cases need a launch canary, not repeated 100+ MiB runtime copies.
            // If verification incorrectly reaches execution, this returns success and
            // prints a sentinel, making the refusal assertions fail.
            (
                "24.21.0".to_string(),
                b"#!/bin/sh\nprintf 'UNSAFE_LAUNCH\\n'\nexit 0\n".to_vec(),
            )
        };
        let runner = b"console.log('independent-first-hop=' + process.versions.node); if(process.env.NODE_OPTIONS || process.env.NODE_USE_SYSTEM_CA) throw new Error('inherited authority');".to_vec();
        let file = |id: &str, path: &str, bytes: &[u8], role: &str, executable: bool| json!({ "path": path, "artifactId": id, "sha256": hash(bytes), "length": bytes.len(), "role": role, "executable": executable });
        let manifest = serde_json::to_vec(&json!({ "schemaVersion":1, "protocol":1, "purpose":"production", "bootstrapArtifactId":"bootstrap",
            "platform": { "os": "linux", "arch": if cfg!(target_arch="aarch64") {"arm64"} else {"x64"} },
            "runtime": { "path":"node", "kind":"node", "version":version }, "entrypoint":"updater.mjs", "releaseQualificationEntrypoint":"release-qualification.mjs", "externalModules":[],
            "files":[file("node-runtime","node",&runtime,"runtime",true), file("runner","updater.mjs",&runner,"runner",false), file("runner","release-qualification.mjs",&runner,"runner",false)] })).unwrap();
        let identity =
            |id: &str, bytes: &[u8]| json!({"id":id,"sha256":hash(bytes),"length":bytes.len()});
        let catalog = serde_json::to_vec(&json!({ "schemaVersion":1,
            "catalog": {"schemaVersion":1,"id":"first-hop-fixture","artifacts":[identity("bootstrap",&bootstrap),identity("node-runtime",&runtime),identity("runner",&runner),identity("runner-manifest",&manifest)],
                "releases":[],"recipes":[],"adapters":[],"qualifications":[],"qualificationIntents":[]},
            "revokedRecipes":[],"revokedArtifactIds":if revoked {vec!["node-runtime"]} else {vec![]} })).unwrap();
        write(
            &artifacts.join("node-runtime"),
            if corrupt {
                b"corrupted runtime"
            } else {
                &runtime
            },
        );
        write(&artifacts.join("runner"), &runner);
        write(&artifacts.join("runner-manifest"), &manifest);
        write(&targets.join("catalog.json"), &catalog);
        let mut keys: HashMap<_, _> = ["root", "timestamp", "snapshot", "targets"]
            .into_iter()
            .map(|role| (role, key()))
            .collect();
        let future = "2099-01-01T00:00:00Z";
        let root = signed(
            json!({"_type":"root","spec_version":"1.0.31","version":1,"expires":future,"consistent_snapshot":false,
            "keys": keys.values().map(|key| (key.id.clone(),key.public.clone())).collect::<HashMap<_,_>>(),
            "roles": keys.iter().map(|(role,key)| (*role,json!({"keyids":[key.id],"threshold":1}))).collect::<HashMap<_,_>>() }),
            &keys["root"],
        );
        write(&root_dir.join("root.json"), &root);
        let target_info =
            |bytes: &[u8]| json!({"length":bytes.len(),"hashes":{"sha256":hash(bytes)}});
        let targets_metadata = signed(
            json!({"_type":"targets","spec_version":"1.0.31","version":1,"expires":future,
            "targets":{"catalog.json":target_info(&catalog),"artifacts/node-runtime":target_info(&runtime),"artifacts/runner":target_info(&runner),"artifacts/runner-manifest":target_info(&manifest)}}),
            &keys["targets"],
        );
        write(&metadata.join("targets.json"), &targets_metadata);
        let metadata_info = |bytes: &[u8]| json!({"version":1,"length":bytes.len(),"hashes":{"sha256":hash(bytes)}});
        let snapshot = signed(
            json!({"_type":"snapshot","spec_version":"1.0.31","version":1,"expires":future,"meta":{"targets.json":metadata_info(&targets_metadata)}}),
            &keys["snapshot"],
        );
        write(&metadata.join("snapshot.json"), &snapshot);
        let timestamp = signed(
            json!({"_type":"timestamp","spec_version":"1.0.31","version":1,"expires":if expired {"2000-01-01T00:00:00Z"} else {future},"meta":{"snapshot.json":metadata_info(&snapshot)}}),
            &keys["timestamp"],
        );
        write(&metadata.join("timestamp.json"), &timestamp);
        Self {
            _temp: temp,
            control,
            installation,
            workspace,
            metadata,
            targets,
            artifacts,
            manifest_sha: hash(&manifest),
            timestamp_key: keys.remove("timestamp").unwrap(),
        }
    }
    fn timestamp_version(&self, version: u64) {
        let path = self.metadata.join("timestamp.json");
        let mut metadata: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        metadata["signed"]["version"] = json!(version);
        write(
            &path,
            &signed(metadata["signed"].clone(), &self.timestamp_key),
        );
    }
    fn launch(&self, verify: bool) -> Output {
        self.launch_with(verify, &[], &["plan"])
    }
    fn launch_with(&self, verify: bool, bootstrap: &[&str], runner: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_openclaw-updater"));
        command.args([
            "--control-root",
            self.control.to_str().unwrap(),
            "--installation",
            self.installation.to_str().unwrap(),
            "--workspace",
            self.workspace.to_str().unwrap(),
            "--metadata-url",
            Url::from_directory_path(&self.metadata).unwrap().as_str(),
            "--targets-url",
            Url::from_directory_path(&self.targets).unwrap().as_str(),
            "--catalog-target",
            "catalog.json",
            "--manifest-artifact",
            "runner-manifest",
        ]);
        command.args(bootstrap);
        if verify {
            command.arg("--verify-only");
        } else {
            command.arg("--").args(runner);
        }
        command
            .env("NODE_USE_SYSTEM_CA", "1")
            .env("PATH", "/no-application-runtime")
            .env(
                "NODE_OPTIONS",
                format!(
                    "--import {}",
                    self.installation.join("openclaw.mjs").display()
                ),
            );
        command.output().unwrap()
    }
}
#[test]
fn independently_launches_private_node_without_installed_runtime_or_config_loader() {
    let fixture = Fixture::new(false, false, false, true);
    let result = fixture.launch(false);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("independent-first-hop="));
    // Verified cached bytes support another launch without re-downloading the private runtime.
    fs::remove_file(fixture.artifacts.join("node-runtime")).unwrap();
    assert!(fixture.launch(false).status.success());
}
#[test]
fn failed_target_stream_does_not_poison_a_later_authenticated_attempt() {
    let fixture = Fixture::new(false, true, false, false);
    assert!(!fixture.launch(true).status.success());
    let retained = fixture.control.join("runners").join(&fixture.manifest_sha);
    assert!(fs::read_dir(&retained).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("partial-")));
    write(
        &fixture.artifacts.join("node-runtime"),
        b"#!/bin/sh\nprintf 'UNSAFE_LAUNCH\\n'\nexit 0\n",
    );
    let result = fixture.launch(true);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn refuses_expired_corrupt_revoked_or_unprovisioned_targets_without_running() {
    for (expired, corrupt, revoked) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let fixture = Fixture::new(expired, corrupt, revoked, false);
        let result = fixture.launch(false);
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout).contains("independent-first-hop="));
        assert!(!String::from_utf8_lossy(&result.stdout).contains("UNSAFE_LAUNCH"));
        if expired {
            assert!(String::from_utf8_lossy(&result.stderr).contains("metadata-expired"));
        }
        if revoked {
            assert!(String::from_utf8_lossy(&result.stderr).contains("recipe-revoked"));
        }
    }
    let fixture = Fixture::new(false, false, false, false);
    fs::remove_file(fixture.control.join("metadata/root.json")).unwrap();
    assert!(!fixture.launch(false).status.success());
}
#[test]
fn refuses_original_recovery_owner_and_undeclared_cached_code() {
    let fixture = Fixture::new(false, false, false, false);
    let key = hash(fixture.installation.to_string_lossy().as_bytes());
    let control = fixture.installation.parent().unwrap().join(format!(
        ".openclaw.package-activation-{}.control",
        &key[..24]
    ));
    directory(&control);
    write(&control.join("recovery.mjs"), b"original owner evidence");
    assert!(!fixture.launch(false).status.success());
    assert_eq!(
        fs::read(control.join("recovery.mjs")).unwrap(),
        b"original owner evidence"
    );
    // Removing this isolated fixture's marker simulates owner resolution, not bootstrap takeover.
    fs::remove_dir_all(&control).unwrap();
    assert!(fixture.launch(true).status.success());
    let retained = fixture.control.join("runners").join(&fixture.manifest_sha);
    write(&retained.join("undeclared.mjs"), b"untrusted extra code");
    assert!(!fixture.launch(false).status.success());
}

#[test]
fn refuses_signed_timestamp_rollback_across_native_processes() {
    let fixture = Fixture::new(false, false, false, false);
    fixture.timestamp_version(2);
    assert!(fixture.launch(true).status.success());
    fixture.timestamp_version(1);
    assert!(!fixture.launch(false).status.success());
}

#[test]
fn refuses_qualification_or_inspector_misuse_without_launching_signed_canary() {
    let fixture = Fixture::new(false, false, false, false);
    for (verify, flags, args) in [
        (false, vec!["--qualification-inspector"], vec!["plan"]),
        (true, vec!["--release-qualification"], vec![]),
        (false, vec!["--release-qualification"], vec!["plan"]),
        (
            false,
            vec!["--release-qualification", "--release-qualification"],
            vec!["plan"],
        ),
        (
            false,
            vec![
                "--release-qualification",
                "--qualification-inspector=0.0.0.0:9229",
            ],
            vec!["plan"],
        ),
        (
            false,
            vec!["--release-qualification"],
            vec!["--input", "/tmp/input", "--plan", "/tmp/plan"],
        ),
    ] {
        let result = fixture.launch_with(verify, &flags, &args);
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout).contains("UNSAFE_LAUNCH"));
    }
}

#[test]
fn refuses_a_valid_catalog_bound_to_another_native_executor() {
    let fixture = Fixture::with_bootstrap(
        false,
        false,
        false,
        false,
        b"other qualified executable".to_vec(),
    );
    let result = fixture.launch(false);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("bootstrap-artifact-changed"));
    assert!(!String::from_utf8_lossy(&result.stdout).contains("UNSAFE_LAUNCH"));
}
