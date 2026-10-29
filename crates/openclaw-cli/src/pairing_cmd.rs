//! `openclaw pairing` — list and approve DM pairing requests.
//!
//! Official reference: `docs/cli/pairing.md`. Supports the positional channel,
//! `--channel`, `--account`, `--notify`, `--json`, and the single-channel
//! shorthand for `approve`.

use openclaw_state::SqliteStateStore;

#[derive(Debug, Default)]
pub struct Args {
    pub sub: String,
    pub channel: Option<String>,
    pub account: Option<String>,
    pub code: Option<String>,
    pub notify: bool,
    pub json: bool,
    pub config: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("usage: openclaw pairing <list|approve> [channel] [code] [--channel <c>] [--account <id>] [--notify] [--json]")]
    Usage,
    #[error("--account must not be blank")]
    BlankAccount,
    #[error("pairing code '{0}' was not found for {1}; it may have expired or already been approved")]
    NotFound(String, String),
    #[error("state error: {0}")]
    State(String),
}

fn is_flag(value: &str) -> bool {
    value.starts_with("--")
}

pub fn parse(args: &[String]) -> Result<Args, PairingError> {
    let mut parsed = Args::default();
    let mut positional: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--channel" => {
                parsed.channel = args.get(index + 1).cloned();
                index += 2;
            }
            "--account" => {
                let value = args.get(index + 1).cloned().unwrap_or_default();
                if value.trim().is_empty() {
                    return Err(PairingError::BlankAccount);
                }
                parsed.account = Some(value);
                index += 2;
            }
            "--config" => {
                parsed.config = args.get(index + 1).cloned();
                index += 2;
            }
            "--notify" => {
                parsed.notify = true;
                index += 1;
            }
            "--json" => {
                parsed.json = true;
                index += 1;
            }
            other if is_flag(other) => index += 1,
            other => {
                positional.push(other.to_owned());
                index += 1;
            }
        }
    }

    parsed.sub = positional.first().cloned().unwrap_or_else(|| "list".to_owned());
    match parsed.sub.as_str() {
        "list" => {
            // `pairing list telegram` — first positional after `list`.
            if parsed.channel.is_none() {
                parsed.channel = positional.get(1).cloned();
            }
        }
        "approve" => {
            // Accept `<channel> <code>`, `--channel <c> <code>`, or `<code>`.
            let rest: Vec<&String> = positional.iter().skip(1).collect();
            match (parsed.channel.is_some(), rest.as_slice()) {
                (true, [code]) => parsed.code = Some((*code).clone()),
                (true, [_, code, ..]) => parsed.code = Some((*code).clone()),
                (false, [channel, code, ..]) => {
                    parsed.channel = Some((*channel).clone());
                    parsed.code = Some((*code).clone());
                }
                (false, [code]) => parsed.code = Some((*code).clone()),
                _ => return Err(PairingError::Usage),
            }
        }
        _ => {}
    }
    Ok(parsed)
}

/// Resolve the channel for `approve` when the code alone was supplied.
///
/// Official resolves this from the set of *configured* pairing-capable channels,
/// not from rows that happen to be pending — otherwise a fresh install with one
/// configured channel reports a misleading "multiple channels" error.
fn resolve_single_channel(config: &openclaw_config::Config) -> Option<String> {
    let mut channels: Vec<String> = config
        .channels
        .keys()
        .filter_map(|key| key.split(':').next())
        .map(str::to_owned)
        .collect();
    channels.sort();
    channels.dedup();
    (channels.len() == 1).then(|| channels.remove(0))
}

pub fn run(args: &[String]) -> Result<String, PairingError> {
    let parsed = parse(args)?;
    let (config, _) = crate::resolve_config(parsed.config.as_deref())
        .map_err(|error| PairingError::State(error.to_string()))?;
    let store = SqliteStateStore::open(&config.database.path)
        .map_err(|error| PairingError::State(error.to_string()))?;

    match parsed.sub.as_str() {
        "list" => {
            let requests = store
                .list_pairings_filtered(parsed.channel.as_deref(), parsed.account.as_deref())
                .map_err(|error| PairingError::State(error.to_string()))?;
            if parsed.json {
                return Ok(serde_json::json!({
                    "channel": parsed.channel,
                    "requests": requests,
                })
                .to_string());
            }
            if requests.is_empty() {
                return Ok("No pending pairing requests.".to_owned());
            }
            let mut out = format!(
                "{:<10} {:<12} {:<12} {:<18} {:<20}\n",
                "CODE", "CHANNEL", "ACCOUNT", "SENDER_ID", "NAME"
            );
            for request in requests {
                out.push_str(&format!(
                    "{:<10} {:<12} {:<12} {:<18} {:<20}\n",
                    request.code,
                    request.channel,
                    request.account_id,
                    request.sender_id,
                    request.sender_name
                ));
            }
            Ok(out.trim_end().to_owned())
        }
        "approve" => {
            let code = parsed.code.clone().ok_or(PairingError::Usage)?;
            let channel = match parsed.channel.clone() {
                Some(channel) => channel,
                None => resolve_single_channel(&config).ok_or_else(|| {
                    PairingError::State(
                        "multiple pairing-capable channels are configured; pass --channel".to_owned(),
                    )
                })?,
            };
            let approved = store
                .approve_pairing_in(&channel, parsed.account.as_deref(), &code)
                .map_err(|error| PairingError::State(error.to_string()))?
                .ok_or_else(|| PairingError::NotFound(code.clone(), channel.clone()))?;

            if parsed.json {
                return Ok(serde_json::to_string(&approved).unwrap_or_default());
            }
            let mut out = format!(
                "Approved pairing code {} for {} ({}) on {}:{}",
                approved.code, approved.sender_name, approved.sender_id, approved.channel, approved.account_id
            );
            if parsed.notify {
                // Notification requires a live channel transport; report honestly
                // instead of claiming the requester was told.
                out.push_str("\nNote: --notify is not delivered yet (no channel transport wired to the CLI).");
            }
            Ok(out)
        }
        other => Err(PairingError::State(format!(
            "unknown pairing subcommand: {other} (expected `list` or `approve`)"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn approve_accepts_channel_and_code_positionally() {
        let parsed = parse(&args(&["approve", "telegram", "ABCD2345"])).unwrap();
        assert_eq!(parsed.channel.as_deref(), Some("telegram"));
        assert_eq!(parsed.code.as_deref(), Some("ABCD2345"));
    }

    #[test]
    fn approve_accepts_channel_flag_and_bare_code() {
        let parsed = parse(&args(&["approve", "--channel", "telegram", "ABCD2345"])).unwrap();
        assert_eq!(parsed.channel.as_deref(), Some("telegram"));
        assert_eq!(parsed.code.as_deref(), Some("ABCD2345"));

        let bare = parse(&args(&["approve", "ABCD2345"])).unwrap();
        assert!(bare.channel.is_none());
        assert_eq!(bare.code.as_deref(), Some("ABCD2345"));
    }

    #[test]
    fn list_accepts_positional_and_flag_channel_with_account() {
        let positional = parse(&args(&["list", "telegram"])).unwrap();
        assert_eq!(positional.channel.as_deref(), Some("telegram"));

        let flagged = parse(&args(&[
            "list",
            "--channel",
            "telegram",
            "--account",
            "work",
            "--json",
        ]))
        .unwrap();
        assert_eq!(flagged.channel.as_deref(), Some("telegram"));
        assert_eq!(flagged.account.as_deref(), Some("work"));
        assert!(flagged.json);
    }

    #[test]
    fn blank_account_is_rejected() {
        assert!(matches!(
            parse(&args(&["list", "--account", ""])),
            Err(PairingError::BlankAccount)
        ));
    }
}
