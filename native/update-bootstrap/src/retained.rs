//! Retained launch is passive original-run custody, never a fresh TUF admission or execution lease.
use super::*;
use serde_json::Value;

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| error("retained-original-custody-required"))
}
fn identity(path: &Path) -> Result<String> {
    let stat = fs::symlink_metadata(path)?;
    Ok(format!("{}:{}", stat.dev(), stat.ino()))
}
fn authority(value: &Value, selected: &Path) -> Result<()> {
    private(selected, false)?;
    let parent = selected
        .parent()
        .ok_or_else(|| error("retained-original-custody-required"))?;
    private(parent, true)?;
    if field(value, "databasePath")?
        != selected
            .to_str()
            .ok_or_else(|| error("invalid-recovery-path"))?
        || field(value, "databaseIdentity")? != identity(selected)?
        || field(value, "parentIdentity")? != identity(parent)?
    {
        return Err(error("retained-original-store-changed"));
    }
    Ok(())
}
fn artifact_bytes(reference: &Value, limit: u64, options: &Options) -> Result<Vec<u8>> {
    let file = PathBuf::from(field(reference, "path")?);
    if !file.is_absolute()
        || file.starts_with(&options.installation)
        || options.workspaces.iter().any(|root| file.starts_with(root))
    {
        return Err(error("trust-storage-overlaps-live-or-agent-roots"));
    }
    private(
        file.parent()
            .ok_or_else(|| error("invalid-recovery-path"))?,
        true,
    )?;
    let bytes = bounded(&file, limit)?;
    if reference["length"].as_u64() != Some(bytes.len() as u64)
        || field(reference, "sha256")? != digest(&bytes)
    {
        return Err(error("retained-original-artifact-changed"));
    }
    Ok(bytes)
}
fn command(options: &Options, run_id: &str, ledger: &Path) -> Result<Vec<String>> {
    if options.verify_only
        || !matches!(
            options.command.first().map(String::as_str),
            Some("resume" | "status")
        )
    {
        return Err(error("retained-original-command-required"));
    }
    let mut args = Vec::new();
    let mut seen_run = false;
    let mut seen_ledger = false;
    let mut index = 0;
    while index < options.command.len() {
        let arg = &options.command[index];
        let mut selected = None;
        for name in ["--run", "--retained-ledger", "--state-database"] {
            if arg == name {
                index += 1;
                selected = Some((
                    name,
                    options
                        .command
                        .get(index)
                        .ok_or_else(|| error("retained-original-command-required"))?
                        .as_str(),
                ));
            } else if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                selected = Some((name, value));
            }
        }
        if let Some((name, value)) = selected {
            if name == "--run" {
                if seen_run || value != run_id {
                    return Err(error("retained-original-command-required"));
                }
                seen_run = true;
            } else {
                if seen_ledger || Path::new(value) != ledger {
                    return Err(error("retained-original-command-required"));
                }
                seen_ledger = true;
            }
        } else {
            args.push(arg.clone());
        }
        index += 1;
    }
    args.extend([
        "--run".into(),
        run_id.into(),
        "--state-database".into(),
        ledger.to_string_lossy().into_owned(),
    ]);
    bind_runner_installation(&args, &options.installation)
}
fn original_journal(options: &Options, retained: &Value) -> Result<()> {
    let install = &options.installation;
    let parent = install
        .parent()
        .ok_or_else(|| error("installation-parent-missing"))?;
    let anchor = parent.join(format!(
        ".openclaw.package-activation-{}",
        &digest(install.to_string_lossy().as_bytes())[..24]
    ));
    for legacy in [
        PathBuf::from(format!("{}.sqlite", anchor.display())),
        PathBuf::from(format!("{}.recovery.mjs", anchor.display())),
    ] {
        if present(&legacy)? {
            return Err(error("active-recovery-owner"));
        }
    }
    let control = PathBuf::from(format!("{}.control", anchor.display()));
    if present(&anchor)? || present(&control)? {
        private(&control, true)?;
        let rows=sqlite_preserving::inspect(&control.join("operation.sqlite"),"SELECT descriptor_json FROM package_activation WHERE slot=1 AND length(descriptor_json)<=1048576 AND ?1 IS NOT NULL LIMIT 2", &install.to_string_lossy())?;
        if rows.len() != 1 {
            return Err(error("active-recovery-owner"));
        }
        let descriptor: Value = serde_json::from_str(&rows[0])?;
        let mut expected = retained["nativeAuthority"].clone();
        expected["owner"] = retained["originalNativeOwner"].clone();
        if descriptor["authority"] != expected {
            return Err(error("active-recovery-owner"));
        }
    }
    // All native handoff rows must correlate to this original run; never adopt a foreign/legacy owner.
    let native = Path::new(field(&retained["nativeAuthority"], "databasePath")?);
    let rows = sqlite_preserving::inspect(
        native,
        "SELECT json_object('owner',owner,'payload',json(payload_json)) FROM managed_update_handoffs WHERE install_root=?1 AND length(payload_json)<=1048576 LIMIT 2",
        &install.to_string_lossy(),
    )?;
    for row in rows {
        let payload: Value = serde_json::from_str(&row)?;
        if payload["owner"] != retained["originalNativeOwner"]
            || payload["payload"]["version"] != 2
            || payload["payload"]["action"]["mutationProtocol"] != "original-cancellation-v1"
        {
            return Err(error("active-recovery-owner"));
        }
    }
    Ok(())
}
async fn known_revocations(
    options: &Options,
    original: &Value,
) -> Result<(Vec<Value>, Vec<String>)> {
    if original["admission"]["targetPath"].as_str() != Some(options.catalog_target.as_str()) {
        return Err(error("retained-original-custody-required"));
    }
    let metadata = options.control.join("metadata");
    private(&metadata, true)?;
    let mut same = true;
    for role in ["root", "timestamp", "snapshot", "targets"] {
        let bytes = bounded(&metadata.join(format!("{role}.json")), METADATA_LIMIT)?;
        if original["admission"]["metadataDigests"][role].as_str() != Some(digest(&bytes).as_str())
        {
            same = false;
        }
    }
    if same {
        return Ok((
            serde_json::from_value(original["revokedRecipes"].clone())?,
            serde_json::from_value(original["revokedArtifactIds"].clone())?,
        ));
    }
    // Changed known metadata needs normal fresh signature/rollback/expiry verification. No expiry switch.
    validate_endpoint(&options.metadata_url, options)?;
    validate_endpoint(&options.targets_url, options)?;
    let root = bounded(&metadata.join("root.json"), METADATA_LIMIT)?;
    let datastore = options.control.join("native-tuf");
    private(&datastore, true)?;
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
    let latest: Envelope = serde_json::from_slice(
        &target_bytes(&repo, &options.catalog_target, CATALOG_LIMIT).await?,
    )?;
    Ok((latest.revoked_recipes, latest.revoked_artifact_ids))
}
fn qualification_retained_command(
    action: &str,
    installation: &Path,
    ledger: &Path,
    run_id: &str,
) -> Result<Vec<String>> {
    if !["resume", "status"].contains(&action) {
        return Err(error("qualification-command-required"));
    }
    Ok(vec![
        format!("--{action}"),
        "--installation".into(),
        installation.to_string_lossy().into_owned(),
        "--ledger".into(),
        ledger.to_string_lossy().into_owned(),
        "--run-id".into(),
        run_id.into(),
    ])
}

pub(super) async fn run(options: &Options) -> Result<i32> {
    let (run_id, ledger) = options
        .retained
        .as_ref()
        .ok_or_else(|| error("retained-original-custody-required"))?;
    if run_id.len() != 36
        || !run_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(error("retained-original-custody-required"));
    }
    let mut args = command(options, run_id, ledger)?;
    let rows=sqlite_preserving::inspect(ledger,"SELECT json_object('runId',r.run_id,'createdAtMs',r.created_at_ms,'status',r.status,'pointer',json(p.value_json)) FROM update_runs r JOIN config_machine_state p ON p.state_key='update.recipe-run.'||r.run_id WHERE r.run_id=?1 AND length(p.value_json)<=1048576 LIMIT 2",run_id)?;
    if rows.len() != 1 {
        return Err(error("retained-original-custody-required"));
    }
    let row: Value = serde_json::from_str(&rows[0])?;
    let pointer = &row["pointer"];
    if pointer["schemaVersion"] != 1
        || pointer["runId"] != *run_id
        || pointer["originalCreatedAtMs"] != row["createdAtMs"]
        || (options.command[0] == "resume"
            && row["status"] != "running"
            && row["status"] != "succeeded")
    {
        return Err(error("retained-original-custody-required"));
    }
    // Lost success delivery is a status request, never authority to reopen a
    // terminal history or reenter the publication/service owners.
    if options.command[0] == "resume" && row["status"] == "succeeded" {
        args[0] = "status".into();
    }
    authority(&pointer["ledgerAuthority"], ledger)?;
    let envelope_bytes = artifact_bytes(&pointer["envelope"], MANIFEST_LIMIT, options)?;
    let retained: Value = serde_json::from_slice(&envelope_bytes)?;
    if retained["schemaVersion"] != 1
        || retained["binding"]["runId"] != *run_id
        || retained["binding"]["installationKey"].as_str() != options.installation.to_str()
        || retained["ledgerAuthority"] != pointer["ledgerAuthority"]
        || retained["nativeAuthority"] != pointer["nativeAuthority"]
    {
        return Err(error("retained-original-custody-required"));
    }
    let native = Path::new(field(&retained["nativeAuthority"], "databasePath")?);
    authority(&retained["nativeAuthority"], native)?;
    let plan: Value = serde_json::from_slice(&artifact_bytes(
        &retained["planArtifact"],
        16 * MANIFEST_LIMIT,
        options,
    )?)?;
    artifact_bytes(&retained["configArtifact"], 16 * MANIFEST_LIMIT, options)?;
    let authorization: Value = serde_json::from_slice(&artifact_bytes(
        &retained["authorizationArtifact"],
        16 * MANIFEST_LIMIT,
        options,
    )?)?;
    if plan["maintenance"]["binding"] != retained["binding"]
        || plan["catalogDigest"] != authorization["digest"]
        || plan["catalog"]["controlRoot"].as_str() != options.control.to_str()
        || plan["catalog"]["targetPath"].as_str() != Some(options.catalog_target.as_str())
        || plan["runner"]["manifestArtifactId"] != options.manifest_artifact
    {
        return Err(error("retained-original-custody-required"));
    }
    let catalog: Catalog = serde_json::from_value(authorization["catalog"].clone())?;
    let (mut revoked_recipes, mut revoked_artifacts) =
        known_revocations(options, &authorization).await?;
    revoked_recipes.extend(serde_json::from_value::<Vec<Value>>(
        authorization["revokedRecipes"].clone(),
    )?);
    revoked_artifacts.extend(serde_json::from_value::<Vec<String>>(
        authorization["revokedArtifactIds"].clone(),
    )?);
    if revoked_recipes
        .iter()
        .any(|entry| entry == &plan["route"]["recipe"])
    {
        return Err(error("recipe-revoked"));
    }
    let root = PathBuf::from(field(&retained["runner"], "root")?);
    if root.starts_with(&options.installation)
        || options
            .workspaces
            .iter()
            .any(|workspace| root.starts_with(workspace))
    {
        return Err(error("trust-storage-overlaps-live-or-agent-roots"));
    }
    private(&root, true)?;
    let manifest_artifact = artifact(&catalog, &options.manifest_artifact, &revoked_artifacts)?;
    let manifest_bytes = bounded(&root.join("runner-manifest.json"), MANIFEST_LIMIT)?;
    if manifest_artifact.length != manifest_bytes.len() as u64
        || manifest_artifact.sha256 != digest(&manifest_bytes)
        || retained["runner"]["manifestDigest"] != manifest_artifact.sha256
    {
        return Err(error("runner-closure-identity-mismatch"));
    }
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest(&manifest)?;
    verify_bootstrap(&manifest, &catalog, &revoked_artifacts)?;
    let qualification = !plan["releaseQualification"].is_null();
    let entry = if qualification {
        qualification_machine(Some(&plan["releaseQualification"]))?;
        for selected in [&options.control, &root, ledger] {
            qualification_path(selected)?;
        }
        if present(&options.installation)? {
            qualification_path(&options.installation)?;
        } else {
            let parent = options
                .installation
                .parent()
                .ok_or_else(|| error("qualification-path-required"))?;
            qualification_path(parent)?;
            if fs::canonicalize(parent)?.join(
                options
                    .installation
                    .file_name()
                    .ok_or_else(|| error("qualification-path-required"))?,
            ) != options.installation
            {
                return Err(error("qualification-path-required"));
            }
        }
        release_entry(&manifest)?
    } else {
        if options.qualification_inspector {
            return Err(error("qualification-launch-required"));
        }
        manifest.entrypoint.as_str()
    };
    let mut files: Vec<_> = manifest.files.iter().collect();
    files.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let mut closure = Sha256::new();
    closure.update(b"openclaw-worker-bundle-v1\0");
    let mut declared = HashSet::new();
    declared.insert(PathBuf::from("runner-manifest.json"));
    for file in files {
        let bound = artifact(&catalog, &file.artifact_id, &revoked_artifacts)?;
        if bound.sha256 != file.sha256 || bound.length != file.length {
            return Err(error("runner-closure-identity-mismatch"));
        }
        let location = root.join(&file.path);
        validate_file(&location, bound, file.executable)?;
        let stat = fs::metadata(&location)?;
        closure.update(
            format!(
                "{}\0{:o}\0{}\0{}\0",
                file.path,
                stat.mode() & 0o777,
                stat.len(),
                file.sha256
            )
            .as_bytes(),
        );
        declared.insert(PathBuf::from(&file.path));
    }
    walk(&root, &root, &declared)?;
    if retained["runner"]["closureDigest"] != hex::encode(closure.finalize())
        || Path::new(field(&retained["runner"], "runtimePath")?)
            != root.join(&manifest.runtime.path)
        || Path::new(field(&retained["runner"], "entrypointPath")?) != root.join(entry)
    {
        return Err(error("runner-closure-identity-mismatch"));
    }
    let (current_revoked_recipes, current_revoked_artifacts) =
        known_revocations(options, &authorization).await?;
    if current_revoked_recipes
        .iter()
        .chain(revoked_recipes.iter())
        .any(|entry| entry == &plan["route"]["recipe"])
        || current_revoked_artifacts
            .iter()
            .chain(revoked_artifacts.iter())
            .any(|id| {
                id == &options.manifest_artifact
                    || retained["binding"]["targetArtifactId"].as_str() == Some(id.as_str())
                    || manifest.files.iter().any(|file| &file.artifact_id == id)
            })
    {
        return Err(error("recipe-revoked"));
    }
    original_journal(options, &retained)?;
    authority(&pointer["ledgerAuthority"], ledger)?;
    if artifact_bytes(&pointer["envelope"], MANIFEST_LIMIT, options)? != envelope_bytes {
        return Err(error("retained-original-custody-required"));
    }
    let current_rows=sqlite_preserving::inspect(ledger,"SELECT json_object('runId',r.run_id,'createdAtMs',r.created_at_ms,'status',r.status,'pointer',json(p.value_json)) FROM update_runs r JOIN config_machine_state p ON p.state_key='update.recipe-run.'||r.run_id WHERE r.run_id=?1 AND length(p.value_json)<=1048576 LIMIT 2",run_id)?;
    if current_rows != rows {
        return Err(error("retained-original-custody-required"));
    }
    if qualification {
        // Terminal success is never replayed. The release entry must support passive status.
        let expected = vec![
            args[0].clone(),
            "--run".into(),
            run_id.clone(),
            "--state-database".into(),
            ledger.to_string_lossy().into_owned(),
            "--installation".into(),
            options.installation.to_string_lossy().into_owned(),
        ];
        if args != expected {
            return Err(error("qualification-command-required"));
        }
        args = qualification_retained_command(&args[0], &options.installation, ledger, run_id)?;
        qualification_machine(Some(&plan["releaseQualification"]))?;
    }
    let mut child = Command::new(root.join(&manifest.runtime.path));
    if options.qualification_inspector {
        child.arg("--inspect-brk=127.0.0.1:0");
    }
    child
        .arg(root.join(entry))
        .args(args)
        .current_dir(&options.control);
    runner_environment(&mut child, qualification);
    Ok(child.status()?.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revocation_admission_cannot_select_another_signed_catalog() {
        let original = serde_json::json!({"admission":{"targetPath":"original-catalog.json"}});
        let failure = known_revocations(&options(&["resume"]), &original)
            .await
            .unwrap_err();
        assert_eq!(failure.to_string(), "retained-original-custody-required");
    }
    #[test]
    fn release_recovery_translates_status_without_replaying_apply() {
        for action in ["status", "resume"] {
            let args = qualification_retained_command(
                action,
                Path::new("/selected"),
                Path::new("/ledger"),
                "original",
            )
            .unwrap();
            assert_eq!(
                args,
                vec![
                    format!("--{action}"),
                    "--installation".into(),
                    "/selected".into(),
                    "--ledger".into(),
                    "/ledger".into(),
                    "--run-id".into(),
                    "original".into()
                ]
            );
        }
        for action in ["plan", "apply", "--resume"] {
            assert!(qualification_retained_command(
                action,
                Path::new("/selected"),
                Path::new("/ledger"),
                "original"
            )
            .is_err());
        }
    }
    fn options(command_args: &[&str]) -> Options {
        Options {
            control: PathBuf::from("/private/control"),
            installation: PathBuf::from("/private/installation"),
            workspaces: vec![PathBuf::from("/private/workspace")],
            metadata_url: Url::parse("https://updates.example/metadata/").unwrap(),
            targets_url: Url::parse("https://updates.example/targets/").unwrap(),
            catalog_target: "catalog.json".into(),
            manifest_artifact: "runner".into(),
            verify_only: false,
            release_qualification: false,
            qualification_inspector: false,
            command: command_args.iter().map(|value| value.to_string()).collect(),
            retained: Some((
                "00000000-0000-4000-8000-000000000001".into(),
                PathBuf::from("/private/ledger.sqlite"),
            )),
        }
    }
    #[test]
    fn binds_original_selectors_and_refuses_fresh_or_conflicting_commands() {
        let run = "00000000-0000-4000-8000-000000000001";
        let ledger = Path::new("/private/ledger.sqlite");
        for action in ["resume", "status"] {
            let bound = command(&options(&[action]), run, ledger).unwrap();
            assert!(bound.windows(2).any(|pair| pair == ["--run", run]));
            assert!(bound
                .windows(2)
                .any(|pair| pair == ["--state-database", "/private/ledger.sqlite"]));
        }
        for args in [
            vec!["apply"],
            vec!["plan"],
            vec!["resume", "--run=foreign"],
            vec!["status", "--retained-ledger=/other.sqlite"],
            vec!["resume", "--state-database=/other.sqlite"],
            vec!["resume", "--state-database", "/other.sqlite"],
            vec![
                "resume",
                "--retained-ledger=/private/ledger.sqlite",
                "--state-database=/private/ledger.sqlite",
            ],
            vec!["resume", "--"],
            vec!["resume", "--installation=/other-installation"],
        ] {
            assert!(command(&options(&args), run, ledger).is_err());
        }
    }
    #[test]
    fn independently_pins_ledger_and_native_store_identity() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let ledger = root.join("ledger.sqlite");
        let native = root.join("native.sqlite");
        for file in [&ledger, &native] {
            fs::write(file, b"private identity fixture").unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let selected = serde_json::json!({"databasePath":ledger,"databaseIdentity":identity(&ledger).unwrap(),"parentIdentity":identity(&root).unwrap()});
        authority(&selected, &ledger).unwrap();
        assert!(authority(&selected, &native).is_err());
        let old = root.join("old.sqlite");
        fs::rename(&ledger, &old).unwrap();
        fs::write(&ledger, b"substituted").unwrap();
        fs::set_permissions(&ledger, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(authority(&selected, &ledger).is_err());
    }
}
