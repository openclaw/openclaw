//! The parity loop, enforced by the test suite.
//!
//! `parity-commands.tsv` records every documented command with a status. This test
//! keeps that table honest in both directions:
//!
//!   * a `MATCH`/`PARTIAL` row whose command the CLI does not know fails, so the
//!     table can never claim coverage that does not exist;
//!   * a `MISSING` row whose command the CLI *does* know fails, so implementing a
//!     command forces its row to be updated with real evidence.
//!
//! That second rule is what makes the loop converge instead of drifting: the
//! table cannot silently under-report or over-report the surface.

use std::collections::BTreeMap;

const TABLE: &str = include_str!("../../parity-commands.tsv");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Match,
    Partial,
    Missing,
}

fn parse_table() -> Vec<(String, Status, String)> {
    let mut rows = Vec::new();
    for line in TABLE.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let command = fields.next().expect("command field").to_owned();
        let status = match fields.next().expect("status field") {
            "MATCH" => Status::Match,
            "PARTIAL" => Status::Partial,
            "MISSING" => Status::Missing,
            other => panic!("unknown status {other:?} for command {command:?}"),
        };
        let note = fields.next().unwrap_or_default().to_owned();
        rows.push((command, status, note));
    }
    assert!(!rows.is_empty(), "parity table is empty");
    rows
}

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

/// First token of a row: the command group the CLI must recognize.
fn group(command: &str) -> &str {
    command.split(' ').next().unwrap_or(command)
}

/// True when the help output lists this command as a whole word.
///
/// Only the `COMMANDS:` block counts: the help also names unimplemented commands
/// in a separate section, and substring matching would let `agent` match
/// "agents" or `status` match the `gateway status` row.
fn help_lists(help: &str, command: &str) -> bool {
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
        match trimmed.strip_prefix(command) {
            Some(rest) => {
                if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                    return true;
                }
            }
            None => {}
        }
    }
    false
}

#[test]
fn every_documented_command_is_accounted_for() {
    let help = help_text();
    let mut problems = Vec::new();

    for (command, status, note) in parse_table() {
        let known = help_lists(&help, group(&command));
        match (status, known) {
            (Status::Missing, true) => problems.push(format!(
                "{command} is marked MISSING but the CLI already exposes it — \
                 implement/verify it and update the row (note was: {note})"
            )),
            (Status::Match | Status::Partial, false) => problems.push(format!(
                "{command} is marked {status:?} but the CLI does not expose it"
            )),
            _ => {}
        }
    }

    assert!(
        problems.is_empty(),
        "parity table disagrees with the CLI:\n{}",
        problems.join("\n")
    );
}

/// A parent row and its subcommands may differ: `gateway` is PARTIAL while
/// `gateway install` is MATCH. Only rows naming the same command must agree.
#[test]
fn rows_naming_the_same_command_do_not_contradict_each_other() {
    let mut seen: BTreeMap<String, Status> = BTreeMap::new();
    let mut problems = Vec::new();
    for (command, status, _) in parse_table() {
        if let Some(previous) = seen.insert(command.clone(), status) {
            if previous != status {
                problems.push(format!(
                    "conflicting statuses for {command}: {previous:?} vs {status:?}"
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_table_has_no_duplicate_rows() {
    let mut seen = BTreeMap::new();
    for (command, status, _) in parse_table() {
        assert!(
            seen.insert(command.clone(), status).is_none(),
            "duplicate row for {command}"
        );
    }
}

#[test]
fn known_gaps_are_recorded_rather_than_omitted() {
    // Spot-check that the table still names the large missing subsystems; if one
    // is implemented, its row flips and this guard is updated deliberately.
    let rows: BTreeMap<String, Status> = parse_table()
        .into_iter()
        .map(|(command, status, _)| (command, status))
        .collect();
    for required in ["update", "backup", "plugins", "agents", "devices", "tui"] {
        assert!(
            rows.contains_key(required),
            "documented command {required} is absent from the parity table"
        );
    }
}
