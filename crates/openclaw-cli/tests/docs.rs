//! The docs must not claim commands that do not exist, and must not omit
//! implemented ones.
//!
//! `docs/COMMANDS.md` is user-facing; a stale table there is a lie. This test ties
//! the "Not implemented" section to the same `parity-commands.tsv` the CLI test
//! enforces, and ties the implemented sections to the binary's own help output.

const COMMANDS_DOC: &str = include_str!("../../docs/COMMANDS.md");
const README: &str = include_str!("../../README.md");
const INSTALL: &str = include_str!("../../docs/INSTALL.md");
const UPDATE: &str = include_str!("../../docs/UPDATE.md");

fn help_text() -> String {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .arg("help")
        .output()
        .expect("run openclaw help");
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Commands the binary actually implements, parsed from the `COMMANDS:` block.
fn implemented() -> Vec<String> {
    let help = help_text();
    let mut out = Vec::new();
    let mut in_commands = false;
    for line in help.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("COMMANDS:") {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        if trimmed.is_empty() {
            break;
        }
        if let Some(first) = trimmed.split_whitespace().next() {
            out.push(first.to_owned());
        }
    }
    out.sort();
    out.dedup();
    out
}

#[test]
fn every_implemented_command_is_documented() {
    let doc = COMMANDS_DOC.to_lowercase();
    let mut missing = Vec::new();
    for command in implemented() {
        // Each implemented command must appear as a heading or code span.
        let needle = format!("openclaw {command}");
        if !doc.contains(&needle.to_lowercase()) {
            missing.push(command);
        }
    }
    assert!(
        missing.is_empty(),
        "docs/COMMANDS.md omits implemented commands: {missing:?}"
    );
}

#[test]
fn unimplemented_commands_are_listed_in_the_doc() {
    // Mirror of the table the CLI test enforces, limited to the `MISSING` rows.
    const TABLE: &str = include_str!("../../parity-commands.tsv");
    let mut missing_rows = Vec::new();
    for line in TABLE.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let command = fields.next().unwrap_or_default();
        if fields.next() == Some("MISSING") {
            missing_rows.push(command.split(' ').next().unwrap_or(command).to_owned());
        }
    }
    missing_rows.sort();
    missing_rows.dedup();
    assert!(!missing_rows.is_empty(), "table has no MISSING rows?");

    let doc = COMMANDS_DOC.to_lowercase();
    let mut absent = Vec::new();
    for command in &missing_rows {
        if !doc.contains(command.as_str()) {
            absent.push(command.clone());
        }
    }
    assert!(
        absent.is_empty(),
        "docs/COMMANDS.md does not name these MISSING commands: {absent:?}"
    );
}

#[test]
fn docs_do_not_promise_a_self_update_or_backup_command() {
    // Both are absent; a doc that offers them would be wrong.
    for doc in [&README, &INSTALL, &UPDATE] {
        assert!(
            !doc.contains("openclaw update --channel"),
            "docs must not offer an update channel command"
        );
    }
    assert!(
        UPDATE.to_lowercase().contains("no self-update")
            || UPDATE.to_lowercase().contains("not implemented"),
        "UPDATE.md must state that self-update does not exist"
    );
    assert!(
        INSTALL.to_lowercase().contains("no `openclaw backup`")
            || INSTALL.to_lowercase().contains("there is no `openclaw backup`"),
        "INSTALL.md must warn that backup is unavailable"
    );
}

#[test]
fn docs_state_arm64_is_unverified() {
    let combined = format!("{README}\n{INSTALL}");
    assert!(
        combined.to_lowercase().contains("arm64"),
        "ARM64 must be mentioned"
    );
    assert!(
        combined.to_lowercase().contains("unverified")
            || combined.to_lowercase().contains("not been executed")
            || combined.to_lowercase().contains("has not been built"),
        "docs must not imply verified ARM64 support"
    );
}

#[test]
fn docs_do_not_claim_full_parity() {
    for doc in [&README, &INSTALL, &UPDATE, &COMMANDS_DOC] {
        let lower = doc.to_lowercase();
        assert!(
            !lower.contains("100% parity")
                && !lower.contains("full parity")
                && !lower.contains("feature-complete"),
            "docs must not claim parity"
        );
    }
    assert!(
        README.to_lowercase().contains("partial prototype"),
        "README must lead with the prototype status"
    );
}
