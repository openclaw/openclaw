mod retained;
mod sqlite_preserving;
use futures_util::TryStreamExt;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tough::{Repository, RepositoryLoader, TargetName};
use url::Url;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const METADATA_LIMIT: u64 = 2 * 1024 * 1024;
const CATALOG_LIMIT: u64 = 8 * 1024 * 1024;
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const BUNDLE_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug)]
struct Options {
    control: PathBuf,
    installation: PathBuf,
    workspaces: Vec<PathBuf>,
    metadata_url: Url,
    targets_url: Url,
    catalog_target: String,
    manifest_artifact: String,
    verify_only: bool,
    release_qualification: bool,
    qualification_inspector: bool,
    command: Vec<String>,
    retained: Option<(String, PathBuf)>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    catalog: Catalog,
    revoked_recipes: Vec<serde_json::Value>,
    revoked_artifact_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    id: String,
    artifacts: Vec<Artifact>,
    releases: Vec<serde_json::Value>,
    recipes: Vec<serde_json::Value>,
    adapters: Vec<serde_json::Value>,
    qualifications: Vec<serde_json::Value>,
    #[serde(default)]
    qualification_intents: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    id: String,
    sha256: String,
    length: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    protocol: u32,
    platform: Platform,
    runtime: Runtime,
    entrypoint: String,
    bootstrap_artifact_id: String,
    purpose: Option<String>,
    release_qualification_entrypoint: Option<String>,
    external_modules: Vec<String>,
    files: Vec<BundleFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Platform {
    os: String,
    arch: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    path: String,
    kind: String,
    version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleFile {
    path: String,
    artifact_id: String,
    sha256: String,
    length: u64,
    executable: bool,
    role: String,
}

fn error(code: &str) -> Box<dyn std::error::Error> {
    code.to_string().into()
}
fn runner_environment(child: &mut Command, qualification: bool) {
    child.env_clear();
    for name in ["HOME", "USER", "LOGNAME"] {
        if let Some(value) = std::env::var_os(name) {
            child.env(name, value);
        }
    }
    child.env("PATH", "/usr/bin:/bin");
    if qualification {
        // The admitted disposable machine owns its HTTPS fixture CA. Add its
        // system roots without forwarding inherited Node options or disabling TLS.
        child.env("NODE_USE_SYSTEM_CA", "1");
    }
}
fn bind_runner_installation(command: &[String], installation: &Path) -> Result<Vec<String>> {
    let mut bound = Vec::new();
    let mut selected = false;
    let mut index = 0;
    while index < command.len() {
        let arg = &command[index];
        // A terminator would turn the appended owner selector into positional
        // data. Reject it instead of depending on the runner parser's precedence.
        if arg == "--" {
            return Err(error("installation-selection-changed"));
        }
        let value = if arg == "--installation" {
            index += 1;
            Some(
                command
                    .get(index)
                    .ok_or_else(|| error("installation-selection-changed"))?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--installation=")
        };
        if let Some(value) = value {
            if selected || Path::new(value) != installation {
                return Err(error("installation-selection-changed"));
            }
            selected = true;
        } else {
            bound.push(arg.clone());
        }
        index += 1;
    }
    bound.push("--installation".to_string());
    bound.push(
        installation
            .to_str()
            .ok_or_else(|| error("installation-selection-changed"))?
            .to_string(),
    );
    Ok(bound)
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn relative(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains('\\')
        || value.contains('\0')
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || Path::new(value)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(error("invalid-artifact-path"));
    }
    Ok(())
}
fn private(path: &Path, directory: bool) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
        || fs::canonicalize(path)? != path
        || (!directory && meta.nlink() != 1)
    {
        return Err(error("unsafe-owner-control-path"));
    }
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    private(path, true)
}
fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    private(path, false)?;
    let meta = fs::metadata(path)?;
    if meta.len() > limit {
        return Err(error("artifact-size-limit"));
    }
    let mut bytes = Vec::new();
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(if cfg!(target_os = "linux") {
            0x20000
        } else {
            0x100
        })
        .open(path)?;
    let opened = file.metadata()?;
    if opened.dev() != meta.dev() || opened.ino() != meta.ino() {
        return Err(error("unsafe-owner-control-path"));
    }
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    private(path, false)?;
    let current = fs::metadata(path)?;
    if bytes.len() as u64 > limit
        || after.len() != meta.len()
        || after.mtime() != meta.mtime()
        || after.mtime_nsec() != meta.mtime_nsec()
        || after.ctime() != meta.ctime()
        || after.ctime_nsec() != meta.ctime_nsec()
        || current.dev() != meta.dev()
        || current.ino() != meta.ino()
    {
        return Err(error("artifact-size-limit"));
    }
    Ok(bytes)
}
fn parse(args: impl Iterator<Item = String>) -> Result<Options> {
    let mut args = args.peekable();
    let mut values = HashMap::new();
    let mut workspaces = Vec::new();
    let mut verify_only = false;
    let mut release_qualification = false;
    let mut qualification_inspector = false;
    let mut command = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--" {
            command.extend(args);
            break;
        }
        if arg == "--release-qualification" || arg == "--qualification-inspector" {
            let selected = if arg == "--release-qualification" {
                &mut release_qualification
            } else {
                &mut qualification_inspector
            };
            if *selected {
                return Err(error("duplicate-bootstrap-option"));
            }
            *selected = true;
            continue;
        }
        if arg == "--verify-only" {
            verify_only = true;
            continue;
        }
        if ![
            "--control-root",
            "--installation",
            "--workspace",
            "--metadata-url",
            "--targets-url",
            "--catalog-target",
            "--manifest-artifact",
            "--retained-run",
            "--retained-ledger",
        ]
        .contains(&arg.as_str())
        {
            return Err(error("unknown-bootstrap-option"));
        }
        let value = args
            .next()
            .ok_or_else(|| error("missing-bootstrap-option-value"))?;
        if arg == "--workspace" {
            workspaces.push(fs::canonicalize(value)?);
        } else if values.insert(arg, value).is_some() {
            return Err(error("duplicate-bootstrap-option"));
        }
    }
    let get = |key: &str| {
        values
            .get(key)
            .cloned()
            .ok_or_else(|| error("missing-bootstrap-option"))
    };
    if workspaces.is_empty() {
        return Err(error("workspace-boundaries-required"));
    }
    let control_input = PathBuf::from(get("--control-root")?);
    let control = fs::canonicalize(&control_input)?;
    if control != control_input {
        return Err(error("control-path-must-be-canonical"));
    }
    let installation_input = PathBuf::from(get("--installation")?);
    let retained = match (
        values.get("--retained-run"),
        values.get("--retained-ledger"),
    ) {
        (Some(run), Some(ledger)) => Some((run.clone(), PathBuf::from(ledger))),
        (None, None) => None,
        _ => return Err(error("retained-original-custody-required")),
    };
    let installation = if retained.is_some() && !installation_input.exists() {
        let parent = installation_input
            .parent()
            .ok_or_else(|| error("installation-parent-missing"))?;
        fs::canonicalize(parent)?.join(
            installation_input
                .file_name()
                .ok_or_else(|| error("installation-parent-missing"))?,
        )
    } else {
        fs::canonicalize(&installation_input)?
    };
    if installation != installation_input {
        return Err(error("installation-path-must-be-canonical"));
    }
    if control.starts_with(&installation) || workspaces.iter().any(|root| control.starts_with(root))
    {
        return Err(error("trust-storage-overlaps-live-or-agent-roots"));
    }
    if (release_qualification && (retained.is_some() || verify_only))
        || (qualification_inspector
            && (verify_only || (!release_qualification && retained.is_none())))
    {
        return Err(error("qualification-launch-required"));
    }
    Ok(Options {
        control,
        installation,
        workspaces,
        metadata_url: Url::parse(&get("--metadata-url")?)?,
        targets_url: Url::parse(&get("--targets-url")?)?,
        catalog_target: get("--catalog-target")?,
        manifest_artifact: get("--manifest-artifact")?,
        verify_only,
        release_qualification,
        qualification_inspector,
        command,
        retained,
    })
}
fn validate_endpoint(url: &Url, options: &Options) -> Result<()> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(error("credential-bearing-distribution-url"));
    }
    match url.scheme() {
        "https" => Ok(()),
        "file" => {
            let path = url
                .to_file_path()
                .map_err(|_| error("invalid-offline-repository"))?;
            private(&path, true)?;
            if path.starts_with(&options.installation)
                || options.workspaces.iter().any(|root| path.starts_with(root))
            {
                return Err(error("offline-repository-overlaps-untrusted-roots"));
            }
            Ok(())
        }
        _ => Err(error("authenticated-distribution-required")),
    }
}
fn inspect_sqlite(path: &Path, sql: &str, key: &str) -> Result<Vec<String>> {
    if !present(path)? {
        return Ok(Vec::new());
    }
    private(path, false)?;
    private(
        path.parent()
            .ok_or_else(|| error("recovery-parent-missing"))?,
        true,
    )?;
    if fs::metadata(path)?.len() > 64 * 1024 * 1024
        || ["-wal", "-journal"]
            .iter()
            .any(|suffix| PathBuf::from(format!("{}{suffix}", path.display())).exists())
    {
        return Err(error("active-recovery-owner"));
    }
    let mut uri = Url::from_file_path(path).map_err(|_| error("invalid-recovery-path"))?;
    uri.set_query(Some("mode=ro&immutable=1"));
    let connection = Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.pragma_update(None, "query_only", true)?;
    let mut query = connection.prepare(sql)?;
    let rows = query.query_map([key], |row| row.get::<_, String>(0))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn no_recovery_owner(installation: &Path) -> Result<()> {
    let key = digest(installation.to_string_lossy().as_bytes());
    let parent = installation
        .parent()
        .ok_or_else(|| error("installation-parent-missing"))?;
    let anchor = parent.join(format!(".openclaw.package-activation-{}", &key[..24]));
    let control = PathBuf::from(format!("{}.control", anchor.display()));
    for marker in [
        &anchor,
        &PathBuf::from(format!("{}.sqlite", anchor.display())),
        &PathBuf::from(format!("{}.recovery.mjs", anchor.display())),
    ] {
        if present(marker)? {
            return Err(error("active-recovery-owner"));
        }
    }
    if present(&control)? {
        private(&control, true)?;
        let journal = control.join("operation.sqlite");
        if present(&control.join("recovery.mjs"))? || !present(&journal)? {
            return Err(error("active-recovery-owner"));
        }
        let rows = inspect_sqlite(&journal,
            "SELECT json_object('phase',phase,'descriptor',json(descriptor_json)) FROM package_activation WHERE slot=1 AND length(descriptor_json)<=1048576 AND ?1 IS NOT NULL LIMIT 2",
            &installation.to_string_lossy()).map_err(|_| error("active-recovery-owner"))?;
        if rows.len() != 1 {
            return Err(error("active-recovery-owner"));
        }
        let receipt: serde_json::Value =
            serde_json::from_str(&rows[0]).map_err(|_| error("active-recovery-owner"))?;
        let descriptor = &receipt["descriptor"];
        let journal_meta = fs::metadata(&journal)?;
        let parent_meta = fs::metadata(parent)?;
        if receipt["phase"] != "anchor-retired"
            || descriptor["version"] != 1
            || !descriptor["layout"].is_null()
            || descriptor["authority"]["installKey"].as_str() != installation.to_str()
            || descriptor["journalIdentity"]
                != format!("{}:{}", journal_meta.dev(), journal_meta.ino())
            || descriptor["parentIdentity"]
                != format!("{}:{}", parent_meta.dev(), parent_meta.ino())
        {
            return Err(error("active-recovery-owner"));
        }
        // This is an inspection-only completion receipt. Keep every byte and never adopt
        // its authority, resume it or delete it. Other states require the original owner.
    }
    let uid = rustix::process::geteuid().as_raw();
    for base in [
        PathBuf::from("/tmp/openclaw"),
        std::env::temp_dir().join(format!("openclaw-{uid}")),
    ] {
        let rows = inspect_sqlite(
            &base.join("managed-update-handoffs.sqlite"),
            "SELECT payload_json FROM managed_update_handoffs WHERE install_root = ?1 LIMIT 2",
            &installation.to_string_lossy(),
        )
        .map_err(|_| error("active-recovery-owner"))?;
        if !rows.is_empty() {
            return Err(error("active-recovery-owner"));
        }
    }
    Ok(())
}

fn artifact<'a>(catalog: &'a Catalog, id: &str, revoked: &[String]) -> Result<&'a Artifact> {
    if revoked.iter().any(|entry| entry == id) {
        return Err(error("recipe-revoked"));
    }
    let matching: Vec<_> = catalog
        .artifacts
        .iter()
        .filter(|entry| entry.id == id)
        .collect();
    if matching.len() != 1 {
        return Err(error("artifact-identity-ambiguous"));
    }
    let value = matching[0];
    if value.sha256.len() != 64
        || !value
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || value.length == 0
        || value.length > BUNDLE_LIMIT
    {
        return Err(error("invalid-artifact-identity"));
    }
    relative(id)?;
    if id.contains('/') {
        return Err(error("artifact-id-must-be-a-basename"));
    }
    Ok(value)
}
async fn target_bytes(repo: &Repository, name: &str, limit: u64) -> Result<Vec<u8>> {
    relative(name)?;
    let target = TargetName::new(name)?;
    let info = repo
        .targets()
        .signed
        .targets
        .get(&target)
        .ok_or_else(|| error("target-not-authorized"))?;
    if info.length > limit {
        return Err(error("artifact-size-limit"));
    }
    let stream = repo
        .read_target(&target)
        .await?
        .ok_or_else(|| error("target-not-authorized"))?;
    futures_util::pin_mut!(stream);
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.try_next().await? {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(error("artifact-size-limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn validate_file(path: &Path, identity: &Artifact, executable: bool) -> Result<()> {
    private(path, false)?;
    let meta = fs::metadata(path)?;
    if meta.len() != identity.length || (meta.mode() & 0o100 != 0) != executable {
        return Err(error("runner-artifact-changed"));
    }
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let len = file.read(&mut buf)?;
        if len == 0 {
            break;
        }
        hash.update(&buf[..len]);
    }
    if hex::encode(hash.finalize()) != identity.sha256 {
        return Err(error("runner-artifact-changed"));
    }
    Ok(())
}
struct PartialArtifact {
    file: File,
    path: PathBuf,
}
impl Drop for PartialArtifact {
    fn drop(&mut self) {
        // Error or cancellation must not leave an undeclared runner dependency.
        // Never remove a replacement introduced after our private file was opened.
        if let (Ok(opened), Ok(current)) = (self.file.metadata(), fs::symlink_metadata(&self.path))
        {
            if current.is_file() && opened.dev() == current.dev() && opened.ino() == current.ino() {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}
async fn retain_target(
    repo: &Repository,
    identity: &Artifact,
    destination: &Path,
    executable: bool,
) -> Result<()> {
    if destination.exists() {
        return validate_file(destination, identity, executable);
    }
    let name = TargetName::new(format!("artifacts/{}", identity.id))?;
    let info = repo
        .targets()
        .signed
        .targets
        .get(&name)
        .ok_or_else(|| error("target-not-authorized"))?;
    if info.length != identity.length || hex::encode(info.hashes.sha256.as_ref()) != identity.sha256
    {
        return Err(error("catalog-target-identity-mismatch"));
    }
    let stream = repo
        .read_target(&name)
        .await?
        .ok_or_else(|| error("target-not-authorized"))?;
    futures_util::pin_mut!(stream);
    let temporary = destination.with_extension(format!("partial-{}", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let mut partial = PartialArtifact {
        file,
        path: temporary.clone(),
    };
    let mut length = 0u64;
    while let Some(chunk) = stream.try_next().await? {
        length = length
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| error("artifact-size-limit"))?;
        if length > identity.length {
            return Err(error("artifact-size-limit"));
        }
        partial.file.write_all(&chunk)?;
    }
    partial.file.sync_all()?;
    fs::set_permissions(
        &temporary,
        fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
    )?;
    validate_file(&temporary, identity, executable)?;
    fs::rename(&temporary, destination)?;
    File::open(
        destination
            .parent()
            .ok_or_else(|| error("artifact-parent-missing"))?,
    )?
    .sync_all()?;
    Ok(())
}
fn walk(root: &Path, directory: &Path, declared: &HashSet<PathBuf>) -> Result<()> {
    private(directory, true)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            walk(root, &path, declared)?;
        } else if !meta.is_file() || !declared.contains(path.strip_prefix(root)?) {
            return Err(error("undeclared-runner-dependency"));
        }
    }
    Ok(())
}
fn validate_manifest(manifest: &Manifest) -> Result<()> {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "unsupported"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unsupported"
    };
    if manifest.schema_version != 1
        || manifest.protocol != 1
        || manifest.platform.os != os
        || manifest.platform.arch != arch
        || manifest.runtime.kind != "node"
        || !manifest.external_modules.is_empty()
        || manifest.files.len() < 2
        || manifest.files.len() > 10000
    {
        return Err(error("runner-protocol-or-platform-unsupported"));
    }
    let version: Vec<u32> = manifest
        .runtime
        .version
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?;
    if version.len() != 3
        || !((version[0] == 22 && (version[1] > 22 || (version[1] == 22 && version[2] >= 2)))
            || (version[0] == 24 && version[1] >= 15)
            || version[0] >= 26)
    {
        return Err(error("runner-runtime-unsupported"));
    }
    relative(&manifest.runtime.path)?;
    relative(&manifest.entrypoint)?;
    if let Some(purpose) = &manifest.purpose {
        if purpose != "production" {
            return Err(error("runner-protocol-or-platform-unsupported"));
        }
    }
    if let Some(entry) = &manifest.release_qualification_entrypoint {
        relative(entry)?;
        if entry == &manifest.entrypoint {
            return Err(error("runner-runtime-or-entrypoint-unbound"));
        }
    }
    let runtime: Vec<_> = manifest
        .files
        .iter()
        .filter(|f| f.role == "runtime")
        .collect();
    let runner: Vec<_> = manifest
        .files
        .iter()
        .filter(|f| f.role == "runner")
        .collect();
    if runtime.len() != 1
        || runtime[0].path != manifest.runtime.path
        || !runtime[0].executable
        || runner.len() != 1 + usize::from(manifest.release_qualification_entrypoint.is_some())
        || !runner.iter().any(|file| file.path == manifest.entrypoint)
        || manifest
            .release_qualification_entrypoint
            .as_ref()
            .is_some_and(|entry| !runner.iter().any(|file| &file.path == entry))
    {
        return Err(error("runner-runtime-or-entrypoint-unbound"));
    }
    let mut paths = HashSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        relative(&file.path)?;
        if file.path == "runner-manifest.json"
            || !paths.insert(&file.path)
            || !["runtime", "runner", "native-dependency", "data"].contains(&file.role.as_str())
        {
            return Err(error("ambiguous-runner-closure"));
        }
        total = total
            .checked_add(file.length)
            .ok_or_else(|| error("artifact-size-limit"))?;
        if total > BUNDLE_LIMIT {
            return Err(error("artifact-size-limit"));
        }
    }
    Ok(())
}
// Hash the running image, not a runner-supplied path or inherited environment claim.
fn verify_bootstrap(manifest: &Manifest, catalog: &Catalog, revoked: &[String]) -> Result<()> {
    let expected = artifact(catalog, &manifest.bootstrap_artifact_id, revoked)?;
    #[cfg(target_os = "linux")]
    let mut executable = File::open("/proc/self/exe")?;
    #[cfg(not(target_os = "linux"))]
    let mut executable = File::open(std::env::current_exe()?)?;
    if executable.metadata()?.len() != expected.length {
        return Err(error("bootstrap-artifact-changed"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = executable.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if hex::encode(hash.finalize()) != expected.sha256 {
        return Err(error("bootstrap-artifact-changed"));
    }
    Ok(())
}
fn qualification_path(path: &Path) -> Result<()> {
    private(Path::new("/qualification"), true)?;
    if !path.starts_with("/qualification")
        || path == Path::new("/qualification")
        || fs::canonicalize(path)? != path
    {
        return Err(error("qualification-path-required"));
    }
    private(path, fs::metadata(path)?.is_dir())
}
fn qualification_machine(binding: Option<&serde_json::Value>) -> Result<()> {
    if !cfg!(target_os = "linux")
        || fs::read_to_string("/proc/1/comm")?.trim() != "systemd"
        || fs::read_to_string("/run/systemd/container")?.trim() != "docker"
        || !fs::read_to_string("/proc/self/mountinfo")?
            .lines()
            .any(|line| line.contains(" / / ") && line.contains(" - overlay "))
        || !fs::read_to_string("/proc/1/cgroup")?.lines().any(|line| {
            let parts: Vec<_> = line.split(':').collect();
            // systemd moves PID 1 into init.scope inside the private v2 namespace.
            // Host-prefixed scopes must not satisfy disposable-machine admission.
            parts.len() == 3
                && parts[0] == "0"
                && parts[1].is_empty()
                && matches!(parts[2], "/" | "/init.scope")
        })
    {
        return Err(error("qualification-machine-required"));
    }
    if let Some(binding) = binding {
        for (key, actual) in [
            ("purpose", "release-qualification".to_string()),
            (
                "machineId",
                fs::read_to_string("/etc/machine-id")?.trim().to_string(),
            ),
            (
                "bootId",
                fs::read_to_string("/proc/sys/kernel/random/boot_id")?
                    .trim()
                    .to_string(),
            ),
            (
                "mountNamespace",
                fs::read_link("/proc/self/ns/mnt")?
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "pidNamespace",
                fs::read_link("/proc/self/ns/pid")?
                    .to_string_lossy()
                    .into_owned(),
            ),
        ] {
            if binding[key].as_str() != Some(actual.as_str()) {
                return Err(error("qualification-machine-changed"));
            }
        }
    }
    Ok(())
}
fn release_entry(manifest: &Manifest) -> Result<&str> {
    if manifest.purpose.as_deref() != Some("production") {
        return Err(error("qualification-launch-required"));
    }
    manifest
        .release_qualification_entrypoint
        .as_deref()
        .ok_or_else(|| error("qualification-launch-required"))
}
fn qualification_command(options: &Options, root: &Path) -> Result<Vec<String>> {
    // Deliberately no forwarded arbitrary options or selector aliases.
    if options.command.len() != 4
        || options.command[0] != "--input"
        || options.command[2] != "--plan"
    {
        return Err(error("qualification-command-required"));
    }
    qualification_machine(None)?;
    qualification_path(&options.control)?;
    qualification_path(&options.installation)?;
    qualification_path(root)?;
    let input = Path::new(&options.command[1]);
    qualification_path(input)?;
    let plan = Path::new(&options.command[3]);
    if !plan.is_absolute() || plan.file_name().is_none() || present(plan)? {
        return Err(error("qualification-plan-must-be-new"));
    }
    qualification_path(
        plan.parent()
            .ok_or_else(|| error("qualification-path-required"))?,
    )?;
    let value: serde_json::Value = serde_json::from_slice(&bounded(input, MANIFEST_LIMIT)?)?;
    for (selected, expected) in [
        (&value["installationRoot"], options.installation.as_path()),
        (&value["runnerRoot"], root),
        (&value["catalog"]["controlRoot"], options.control.as_path()),
    ] {
        if selected.as_str().map(Path::new) != Some(expected) {
            return Err(error("installation-selection-changed"));
        }
    }
    if value["runnerManifestArtifactId"].as_str() != Some(options.manifest_artifact.as_str())
        || value["catalog"]["targetPath"].as_str() != Some(options.catalog_target.as_str())
        || value["catalog"]["metadataBaseUrl"].as_str() != Some(options.metadata_url.as_str())
        || value["catalog"]["targetBaseUrl"].as_str() != Some(options.targets_url.as_str())
    {
        return Err(error("qualification-selector-changed"));
    }
    for selected in [
        &value["stateRoot"],
        &value["configPath"],
        &value["artifactsDirectory"],
        &value["localArchivePath"],
        &value["catalog"]["metadataDir"],
    ] {
        qualification_path(Path::new(
            selected
                .as_str()
                .ok_or_else(|| error("qualification-path-required"))?,
        ))?;
    }
    let mut command = options.command.clone();
    command.extend([
        "--installation".into(),
        options.installation.to_string_lossy().into_owned(),
    ]);
    Ok(command)
}

async fn run(options: Options) -> Result<i32> {
    private(&options.control, true)?;
    if options.retained.is_some() {
        return retained::run(&options).await;
    }
    no_recovery_owner(&options.installation)?;
    validate_endpoint(&options.metadata_url, &options)?;
    validate_endpoint(&options.targets_url, &options)?;
    let metadata = options.control.join("metadata");
    private(&metadata, true)?;
    let root = bounded(&metadata.join("root.json"), METADATA_LIMIT)?;
    let datastore = options.control.join("native-tuf");
    private_dir(&datastore)?;
    // create_new serializes bootstrap cache writers, not installation authority. A crashed
    // bootstrap leaves this file for explicit owner inspection rather than stealing it.
    let lock_path = options.control.join("bootstrap-active");
    let mut lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&lock_path)?;
    writeln!(lock, "{}", std::process::id())?;
    lock.sync_all()?;
    let result = async {
        let repo = RepositoryLoader::new(
            &root,
            options.metadata_url.clone(),
            options.targets_url.clone(),
        )
        .datastore(&datastore)
        .limits(tough::Limits {
            max_root_size: METADATA_LIMIT,
            max_targets_size: METADATA_LIMIT,
            max_timestamp_size: METADATA_LIMIT,
            max_snapshot_size: METADATA_LIMIT,
            max_root_updates: 32,
        })
        .load()
        .await?;
        let catalog_bytes = target_bytes(&repo, &options.catalog_target, CATALOG_LIMIT).await?;
        let envelope: Envelope = serde_json::from_slice(&catalog_bytes)?;
        if envelope.schema_version != 1
            || envelope.catalog.schema_version != 1
            || envelope.catalog.id.is_empty()
            || envelope.revoked_recipes.len() > 10000
            || envelope.catalog.recipes.len()
                + envelope.catalog.releases.len()
                + envelope.catalog.adapters.len()
                + envelope.catalog.qualifications.len()
                + envelope.catalog.qualification_intents.len()
                > 100000
        {
            return Err(error("catalog-contract-unsupported"));
        }
        let manifest_identity = artifact(
            &envelope.catalog,
            &options.manifest_artifact,
            &envelope.revoked_artifact_ids,
        )?;
        let manifest_bytes = target_bytes(
            &repo,
            &format!("artifacts/{}", manifest_identity.id),
            MANIFEST_LIMIT,
        )
        .await?;
        if manifest_bytes.len() as u64 != manifest_identity.length
            || digest(&manifest_bytes) != manifest_identity.sha256
        {
            return Err(error("catalog-target-identity-mismatch"));
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest(&manifest)?;
        verify_bootstrap(&manifest, &envelope.catalog, &envelope.revoked_artifact_ids)?;
        let runners = options.control.join("runners");
        private_dir(&runners)?;
        let retained = runners.join(&manifest_identity.sha256);
        private_dir(&retained)?;
        for file in &manifest.files {
            let identity = artifact(
                &envelope.catalog,
                &file.artifact_id,
                &envelope.revoked_artifact_ids,
            )?;
            if identity.sha256 != file.sha256 || identity.length != file.length {
                return Err(error("runner-closure-identity-mismatch"));
            }
            let destination = retained.join(&file.path);
            let mut current = retained.clone();
            let parts: Vec<_> = Path::new(&file.path).components().collect();
            for part in &parts[..parts.len() - 1] {
                current.push(part.as_os_str());
                private_dir(&current)?;
            }
            retain_target(&repo, identity, &destination, file.executable).await?;
        }
        let manifest_path = retained.join("runner-manifest.json");
        if !manifest_path.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&manifest_path)?;
            file.write_all(&manifest_bytes)?;
            file.sync_all()?;
        }
        validate_file(&manifest_path, manifest_identity, false)?;
        let mut declared: HashSet<PathBuf> = manifest
            .files
            .iter()
            .map(|f| PathBuf::from(&f.path))
            .collect();
        declared.insert(PathBuf::from("runner-manifest.json"));
        walk(&retained, &retained, &declared)?;
        no_recovery_owner(&options.installation)?;
        // Revalidate metadata immediately before launching; no expired cache authorizes a new run.
        let current = target_bytes(&repo, &options.catalog_target, CATALOG_LIMIT).await?;
        if current != catalog_bytes {
            return Err(error("plan-preconditions-changed"));
        }
        if options.verify_only {
            println!(
                "{{\"verified\":true,\"manifestSha256\":\"{}\",\"nativeDependencies\":{}}}",
                manifest_identity.sha256,
                serde_json::to_string(
                    &manifest
                        .files
                        .iter()
                        .filter(|f| f.role == "native-dependency")
                        .map(|f| &f.path)
                        .collect::<Vec<_>>()
                )?
            );
            return Ok(0);
        }
        let (entry, command) = if options.release_qualification {
            (
                release_entry(&manifest)?,
                qualification_command(&options, &retained)?,
            )
        } else {
            if options.command.is_empty()
                || !["plan", "apply", "resume", "status"].contains(&options.command[0].as_str())
            {
                return Err(error("unsupported-runner-command"));
            }
            (
                manifest.entrypoint.as_str(),
                bind_runner_installation(&options.command, &options.installation)?,
            )
        };
        no_recovery_owner(&options.installation)?;
        let mut child = Command::new(retained.join(&manifest.runtime.path));
        if options.qualification_inspector {
            child.arg("--inspect-brk=127.0.0.1:0");
        }
        child
            .arg(retained.join(entry))
            .args(command)
            .current_dir(&options.control);
        runner_environment(&mut child, options.release_qualification);
        // No update lease, candidate admission, NODE_OPTIONS, plugin paths or installed
        // runtime authority is inherited. The one existing engine admits execution later.
        Ok(child.status()?.code().unwrap_or(1))
    }
    .await;
    drop(lock);
    fs::remove_file(lock_path)?;
    result
}
#[tokio::main]
async fn main() {
    let result = match parse(std::env::args().skip(1)) {
        Ok(options) => run(options).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            let reason = error.to_string();
            let expired = matches!(
                error.downcast_ref::<tough::error::Error>(),
                Some(tough::error::Error::ExpiredMetadata { .. })
            );
            let public = match reason.as_str() {
                "active-recovery-owner"
                | "recipe-revoked"
                | "plan-preconditions-changed"
                | "runner-artifact-changed"
                | "bootstrap-artifact-changed"
                | "undeclared-runner-dependency"
                | "runner-protocol-or-platform-unsupported"
                | "runner-runtime-unsupported"
                | "unsafe-owner-control-path"
                | "installation-selection-changed" => reason.as_str(),
                _ if expired => "metadata-expired",
                _ => "metadata-untrusted",
            };
            eprintln!("{public}: preserve the installation and original recovery/trust owner; inspect bootstrap provisioning and pinned artifacts.");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_admitted_qualification_gets_fixed_system_tls_roots() {
        for qualification in [false, true] {
            let mut child = Command::new("unused-fixture-runtime");
            child
                .env("NODE_OPTIONS", "untrusted")
                .env("NODE_USE_SYSTEM_CA", "untrusted")
                .env("UNTRUSTED", "untrusted");
            runner_environment(&mut child, qualification);
            let env = child.get_envs().collect::<HashMap<_, _>>();
            assert!(!env.contains_key(std::ffi::OsStr::new("NODE_OPTIONS")));
            assert!(!env.contains_key(std::ffi::OsStr::new("UNTRUSTED")));
            assert_eq!(
                env.get(std::ffi::OsStr::new("NODE_USE_SYSTEM_CA")),
                qualification.then_some(&Some(std::ffi::OsStr::new("1")))
            );
        }
    }
    #[test]
    fn partial_cleanup_preserves_published_or_replaced_files() {
        let root = tempfile::TempDir::new().unwrap();
        let temporary = root.path().join("partial");
        let destination = root.path().join("published");
        let partial = PartialArtifact {
            file: File::create(&temporary).unwrap(),
            path: temporary.clone(),
        };
        fs::rename(&temporary, &destination).unwrap();
        fs::write(&temporary, b"replacement").unwrap();
        drop(partial);
        assert!(destination.is_file());
        assert_eq!(fs::read(&temporary).unwrap(), b"replacement");
    }
    #[test]
    fn binds_every_runner_selector_encoding_to_one_installation() {
        let installation = Path::new("/selected");
        for arguments in [
            vec![
                "plan",
                "--installation",
                "/selected",
                "--installation=/different",
            ],
            vec!["plan", "--installation=/different"],
            vec![
                "plan",
                "--installation",
                "/selected",
                "--installation=/selected",
            ],
            vec!["plan", "--installation"],
            vec!["plan", "--", "--installation", "/selected"],
        ] {
            let command = arguments.into_iter().map(String::from).collect::<Vec<_>>();
            assert!(bind_runner_installation(&command, installation).is_err());
        }
        for arguments in [
            vec!["plan"],
            vec!["plan", "--installation", "/selected"],
            vec!["plan", "--installation=/selected"],
        ] {
            let command = arguments.into_iter().map(String::from).collect::<Vec<_>>();
            assert_eq!(
                bind_runner_installation(&command, installation).unwrap(),
                vec!["plan", "--installation", "/selected"]
            );
        }
    }
    #[test]
    fn rejects_path_traversal_and_ambiguous_artifact_paths() {
        for path in [
            "../runtime",
            "/runtime",
            "runtime//node",
            "runtime/./node",
            "runtime\\node",
            "",
        ] {
            assert!(relative(path).is_err());
        }
        assert!(relative("runtime/node").is_ok());
    }
    #[test]
    fn never_treats_dangling_owner_markers_as_absent() {
        let root = tempfile::TempDir::new().unwrap();
        let marker = root.path().join("owner");
        std::os::unix::fs::symlink(root.path().join("missing"), &marker).unwrap();
        assert!(present(&marker).unwrap());
    }
    #[test]
    fn accepts_only_matching_cold_completion_receipt_without_taking_ownership() {
        let root = tempfile::TempDir::new().unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let installation = base.join("installation");
        fs::create_dir(&installation).unwrap();
        let key = digest(installation.to_string_lossy().as_bytes());
        let control = base.join(format!(
            ".openclaw.package-activation-{}.control",
            &key[..24]
        ));
        fs::create_dir(&control).unwrap();
        fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
        let journal = control.join("operation.sqlite");
        let database = Connection::open(&journal).unwrap();
        database
            .execute(
                "CREATE TABLE package_activation(slot INTEGER,phase TEXT,descriptor_json TEXT)",
                [],
            )
            .unwrap();
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o600)).unwrap();
        let journal_meta = fs::metadata(&journal).unwrap();
        let parent_meta = fs::metadata(&base).unwrap();
        let descriptor = serde_json::json!({ "version":1,"authority":{"installKey":installation},
            "journalIdentity":format!("{}:{}",journal_meta.dev(),journal_meta.ino()),
            "parentIdentity":format!("{}:{}",parent_meta.dev(),parent_meta.ino()) });
        database
            .execute(
                "INSERT INTO package_activation VALUES(1,'anchor-retired',?1)",
                [descriptor.to_string()],
            )
            .unwrap();
        drop(database);
        let original = fs::read(&journal).unwrap();
        no_recovery_owner(&installation).unwrap();
        assert_eq!(fs::read(&journal).unwrap(), original);
        let database = Connection::open(&journal).unwrap();
        database
            .execute("UPDATE package_activation SET phase='publishing'", [])
            .unwrap();
        drop(database);
        assert!(no_recovery_owner(&installation).is_err());
    }
}
