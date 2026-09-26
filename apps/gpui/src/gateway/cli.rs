//! Non-interactive profile seeding; JSON projections never include credentials.
use serde_json::{Value, json};

use super::profiles::{GatewayKind, GatewayProfile, ProfileCredentials, ProfileStore};

pub fn run(args: &[String]) -> Result<Option<Value>, String> {
    if args.first().map(String::as_str) != Some("gateways") {
        return Ok(None);
    }
    let mut store = ProfileStore::load()?;
    execute(&mut store, &args[1..]).map(Some)
}

fn execute(store: &mut ProfileStore, args: &[String]) -> Result<Value, String> {
    match args.first().map(String::as_str) {
        Some("list") if args.len() == 1 => {
            Ok(json!({"profiles":store.list(), "primary":store.primary_id()}))
        }
        Some("remove") if args.len() == 2 => {
            let profile = store.find(&args[1])?;
            let removal = store.remove(&profile.id)?;
            Ok(json!({"removed":removal.profile.id, "webScopes":removal.web_scopes}))
        }
        Some("set-primary") if args.len() == 2 => {
            let profile = store.find(&args[1])?;
            store.set_primary(&profile.id)?;
            Ok(json!({"primary":profile.id}))
        }
        Some("add") => {
            let mut name = None;
            let mut url = None;
            let mut target = None;
            let mut remote_port = 18789;
            let mut has_remote_port = false;
            let mut identity_file = None;
            let mut primary = false;
            let mut credentials = ProfileCredentials::default();
            let mut flags = args[1..].iter();
            while let Some(argument) = flags.next() {
                if argument == "--primary" {
                    primary = true;
                    continue;
                }
                let (flag, inline) = argument
                    .split_once('=')
                    .map_or((argument.as_str(), None), |(flag, value)| {
                        (flag, Some(value))
                    });
                if !matches!(
                    flag,
                    "--name"
                        | "--url"
                        | "--ssh"
                        | "--remote-port"
                        | "--identity-file"
                        | "--token"
                        | "--password"
                ) {
                    return Err(usage());
                }
                let value = inline
                    .map(str::to_owned)
                    .or_else(|| flags.next().cloned())
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                match flag {
                    "--name" => name = Some(value),
                    "--url" => url = Some(value),
                    "--ssh" => target = Some(value),
                    "--remote-port" => {
                        has_remote_port = true;
                        remote_port = value
                            .parse::<u16>()
                            .ok()
                            .filter(|port| *port != 0)
                            .ok_or("Remote Gateway port must be between 1 and 65535")?
                    }
                    "--identity-file" => identity_file = Some(value),
                    "--token" => credentials.token = Some(value),
                    "--password" => credentials.password = Some(value),
                    _ => unreachable!(),
                }
            }
            if credentials.token.is_some() && credentials.password.is_some() {
                return Err("Enter either a Gateway token or password, not both".into());
            }
            let kind = match (url, target) {
                (Some(url), None) if identity_file.is_none() && !has_remote_port => {
                    GatewayKind::Direct { url }
                }
                (None, Some(target)) => GatewayKind::Ssh {
                    target,
                    remote_port,
                    identity_file,
                },
                _ => {
                    return Err(
                        "Choose exactly one --url or --ssh; SSH options require --ssh".into(),
                    );
                }
            };
            let profile = GatewayProfile::new(name.as_deref().ok_or("--name is required")?, kind)?;
            let profile = store.save_with_credentials(profile, primary, Some(credentials))?;
            Ok(json!({"profile":profile,"primary":store.primary_id()}))
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "Usage: openclaw-gpui gateways list | add --name NAME (--url URL | --ssh TARGET [--remote-port PORT] [--identity-file PATH]) [--primary] [--token TOKEN | --password PASSWORD] | remove NAME_OR_ID | set-primary NAME_OR_ID".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_seed_select_list_and_remove_without_disclosing_credentials() {
        let root = std::env::temp_dir().join(format!("gpui-cli-{}", uuid::Uuid::new_v4()));
        let mut store = ProfileStore::load_at(&root).unwrap();
        let command = |words: &[&str]| {
            words
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>()
        };
        let added = execute(
            &mut store,
            &command(&[
                "add",
                "--name",
                "Fixture",
                "--ssh",
                "user@fixture.invalid:2222",
                "--remote-port",
                "19971",
                "--identity-file",
                "/fixture/key with spaces",
                "--primary",
                "--token",
                "fixture-secret",
            ]),
        )
        .unwrap();
        let id = added["profile"]["id"].as_str().unwrap();
        assert_eq!(added["primary"], id);
        assert_eq!(added["profile"]["kind"]["remote_port"], 19971);
        assert!(!added.to_string().contains("fixture-secret"));
        assert_eq!(
            store.credentials(id).token.as_deref(),
            Some("fixture-secret")
        );
        execute(
            &mut store,
            &command(&[
                "add",
                "--name",
                "Direct",
                "--url",
                "https://fixture.example",
            ]),
        )
        .unwrap();
        let selected = execute(&mut store, &command(&["set-primary", "Direct"])).unwrap();
        let listing = execute(&mut store, &command(&["list"])).unwrap();
        assert_eq!(listing["profiles"].as_array().unwrap().len(), 2);
        assert_eq!(listing["primary"], selected["primary"]);
        assert!(!listing.to_string().contains("fixture-secret"));
        assert!(
            execute(
                &mut store,
                &command(&[
                    "add",
                    "--name",
                    "Invalid",
                    "--url",
                    "https://fixture.example",
                    "--remote-port",
                    "18789"
                ])
            )
            .is_err()
        );
        assert_eq!(store.list().len(), 2);
        let removed = execute(&mut store, &command(&["remove", "Fixture"])).unwrap();
        assert_eq!(removed["removed"], id);
        assert_eq!(ProfileStore::load_at(&root).unwrap().list().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
