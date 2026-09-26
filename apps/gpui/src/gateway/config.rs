use std::{collections::HashMap, env, fmt, fs, path::PathBuf};

use serde_json::Value;

#[derive(Clone, Default, PartialEq, Eq)]
pub struct ConnectionConfig {
    pub url: String,
    pub token: Option<String>,
    pub password: Option<String>,
}

impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("url", &"<configured>")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Default)]
struct Overrides {
    url: Option<String>,
    token: Option<String>,
    password: Option<String>,
}

type Environment = HashMap<String, String>;

/// Resolve only the named Gateway settings; never enumerate or log environment secrets.
pub fn load() -> Result<ConnectionConfig, String> {
    let mut cli = parse_args(env::args().skip(1))?;
    let environment: Environment = [
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_STATE_DIR",
    ]
    .into_iter()
    .filter_map(|name| env::var(name).ok().map(|value| (name.to_owned(), value)))
    .collect();
    if cli.url.is_none() && env_value(&environment, "OPENCLAW_GATEWAY_URL").is_none() {
        cli.url = super::identity::Identity::last_gateway_url()?;
    }
    let home = dirs::home_dir().ok_or("Could not locate the home directory")?;
    let path = config_path(&environment, &home);
    let file = match fs::read_to_string(&path) {
        Ok(contents) => json5::from_str(&contents)
            .map_err(|_| format!("Could not parse JSON5 config at {}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => return Err(format!("Could not read config: {error}")),
    };
    resolve(&cli, &environment, &file)
}

/// Saved routes inherit only credentials owned by their configured endpoint.
pub fn for_profile(profile: &super::profiles::GatewayProfile) -> Result<ConnectionConfig, String> {
    let saved = super::profiles::ProfileStore::load()?.credentials(&profile.id);
    if saved.token.is_some() || saved.password.is_some() {
        return Ok(ConnectionConfig {
            url: profile.canonical_url(),
            token: saved.token,
            password: saved.password,
        });
    }
    let environment: Environment = ["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]
        .into_iter()
        .filter_map(|name| env::var(name).ok().map(|value| (name.to_owned(), value)))
        .collect();
    let home = dirs::home_dir().ok_or("Could not locate the home directory")?;
    let path = config_path(&environment, &home);
    let file = match fs::read_to_string(&path) {
        Ok(contents) => json5::from_str(&contents)
            .map_err(|_| format!("Could not parse JSON5 config at {}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(_) => return Err("Could not read Gateway config".into()),
    };
    Ok(profile_config(profile, &file))
}

fn profile_config(profile: &super::profiles::GatewayProfile, file: &Value) -> ConnectionConfig {
    use super::{profiles::GatewayKind, remote_tunnel::parse_ssh_target};
    let gateway = &file["gateway"];
    let remote = &gateway["remote"];
    let transport = remote["transport"].as_str().unwrap_or("direct");
    let auth = match &profile.kind {
        GatewayKind::Ssh {
            target,
            remote_port,
            ..
        } => {
            let configured_target = remote["sshTarget"]
                .as_str()
                .and_then(|target| parse_ssh_target(target).ok());
            let configured_port = match &remote["remotePort"] {
                Value::Null => Some(18789),
                port => port
                    .as_u64()
                    .and_then(|port| u16::try_from(port).ok())
                    .filter(|port| *port != 0),
            };
            // Match Tauri's credential_endpoint_matches, including SSH alias port semantics.
            (transport == "ssh"
                && configured_target.is_some()
                && configured_target == parse_ssh_target(target).ok()
                && configured_port == Some(*remote_port))
            .then_some(remote)
        }
        GatewayKind::Direct { url } => {
            let configured_url = remote["url"]
                .as_str()
                .and_then(|url| normalize_url(url).ok());
            if transport == "direct" && configured_url.as_ref() == Some(url) {
                Some(remote)
            } else if gateway["mode"].as_str() != Some("remote") {
                let port = gateway["port"].as_u64().unwrap_or(18789);
                (url == &format!("ws://127.0.0.1:{port}/")).then_some(&gateway["auth"])
            } else {
                None
            }
        }
    };
    // Mirror Mac GatewayRemoteConfig's literal-only remote credential resolution.
    ConnectionConfig {
        url: profile.canonical_url(),
        token: auth.and_then(|auth| nonempty(auth["token"].as_str())),
        password: auth.and_then(|auth| nonempty(auth["password"].as_str())),
    }
}

/// The HTTP page and the WebSocket use the same Gateway path, including `/`.
pub fn normalize_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 4096 {
        return Err("Enter a Gateway address, such as https://gateway.example".into());
    }
    let qualified = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let mut url = url::Url::parse(&qualified).map_err(|_| "Enter a valid Gateway address")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err("Gateway addresses cannot contain credentials, a query, or a fragment".into());
    }
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err("Use an HTTPS or WSS Gateway address".into()),
    };
    if scheme == "ws"
        && !url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    {
        return Err("Remote Gateways require HTTPS or WSS; only loopback permits WS".into());
    }
    url.set_scheme(scheme)
        .map_err(|_| "Invalid Gateway scheme")?;
    let result = url.to_string();
    openclaw_gateway_client::GatewayClientConfig::new(&result)
        .map_err(|_| "Remote Gateways require HTTPS or WSS; only loopback permits WS")?;
    Ok(result)
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Overrides, String> {
    let mut args = args.peekable();
    let mut cli = Overrides::default();
    while let Some(argument) = args.next() {
        let (flag, inline) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(flag, value)| {
                (flag, Some(value))
            });
        let target = match flag {
            "--url" => &mut cli.url,
            "--token" => &mut cli.token,
            "--password" => &mut cli.password,
            _ => {
                return Err(
                    "Usage: openclaw-gpui [--url URL] [--token TOKEN] [--password PASSWORD]".into(),
                );
            }
        };
        let value = if let Some(value) = inline {
            value.to_owned()
        } else {
            if args.peek().is_none_or(|value| value.starts_with("--")) {
                return Err(format!("{flag} requires a value"));
            }
            args.next().expect("checked next argument")
        };
        *target = nonempty(Some(value.as_str()));
    }
    Ok(cli)
}

fn config_path(environment: &Environment, home: &std::path::Path) -> PathBuf {
    let expand = |value: &str| {
        if value == "~" {
            home.to_path_buf()
        } else if let Some(relative) = value.strip_prefix("~/") {
            home.join(relative)
        } else {
            PathBuf::from(value)
        }
    };
    if let Some(path) = env_value(environment, "OPENCLAW_CONFIG_PATH") {
        return expand(&path);
    }
    env_value(environment, "OPENCLAW_STATE_DIR")
        .map(|path| expand(&path))
        .unwrap_or_else(|| home.join(".openclaw"))
        .join("openclaw.json")
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn env_value(environment: &Environment, name: &str) -> Option<String> {
    nonempty(environment.get(name).map(String::as_str))
}

fn resolve(
    cli: &Overrides,
    environment: &Environment,
    file: &Value,
) -> Result<ConnectionConfig, String> {
    let gateway = &file["gateway"];
    let remote = gateway["mode"].as_str() == Some("remote");
    let auth = if remote {
        &gateway["remote"]
    } else {
        &gateway["auth"]
    };
    let url = cli
        .url
        .clone()
        .or_else(|| env_value(environment, "OPENCLAW_GATEWAY_URL"));
    let url = match url {
        Some(url) => url,
        None if remote => nonempty(gateway["remote"]["url"].as_str())
            .ok_or("Remote Gateway mode requires gateway.remote.url or --url")?,
        None => {
            let port = gateway["port"].as_u64().unwrap_or(18789);
            if !(1..=65535).contains(&port) {
                return Err("Gateway port must be between 1 and 65535".into());
            }
            format!("ws://127.0.0.1:{port}")
        }
    };
    Ok(ConnectionConfig {
        url,
        token: cli
            .token
            .clone()
            .or_else(|| env_value(environment, "OPENCLAW_GATEWAY_TOKEN"))
            .or_else(|| nonempty(auth["token"].as_str())),
        password: cli
            .password
            .clone()
            .or_else(|| env_value(environment, "OPENCLAW_GATEWAY_PASSWORD"))
            .or_else(|| nonempty(auth["password"].as_str())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ssh_credentials_match_remote_endpoint_not_forwarded_loopback_url() {
        use super::super::profiles::{GatewayKind, GatewayProfile};
        let profile = GatewayProfile::new(
            "Fixture",
            GatewayKind::Ssh {
                target: "operator@host:2222".into(),
                remote_port: 19971,
                identity_file: None,
            },
        )
        .unwrap();
        let root = json!({"gateway":{"auth":{"token":"wrong-local"},"remote":{
            "transport":"ssh", "sshTarget":"operator@host:2222", "remotePort":19971,
            "url":"ws://127.0.0.1:59999", "token":"matching-remote"
        }}});
        assert_eq!(
            profile_config(&profile, &root).token.as_deref(),
            Some("matching-remote")
        );
        for (field, value) in [
            ("transport", json!("direct")),
            ("sshTarget", json!("operator@other:2222")),
            ("remotePort", json!(19972)),
        ] {
            let mut mismatch = root.clone();
            mismatch["gateway"]["remote"][field] = value;
            assert_eq!(profile_config(&profile, &mismatch).token, None);
        }
        let alias = GatewayProfile::new(
            "Alias",
            GatewayKind::Ssh {
                target: "operator@host".into(),
                remote_port: 18789,
                identity_file: None,
            },
        )
        .unwrap();
        let implicit = json!({"gateway":{"remote":{"transport":"ssh","sshTarget":"operator@host","token":"matching"}}});
        assert_eq!(
            profile_config(&alias, &implicit).token.as_deref(),
            Some("matching")
        );
        let mut explicit = implicit.clone();
        explicit["gateway"]["remote"]["sshTarget"] = json!("operator@host:22");
        assert_eq!(profile_config(&alias, &explicit).token, None);
        let mut reference = implicit;
        reference["gateway"]["remote"]["token"] = json!({"source":"exec","id":"never-run"});
        assert_eq!(profile_config(&alias, &reference).token, None);
    }

    #[test]
    fn gateway_addresses_normalize_to_the_existing_websocket_path() {
        for input in [
            "gateway.example",
            "https://gateway.example",
            "wss://GATEWAY.example:443",
        ] {
            assert_eq!(normalize_url(input).unwrap(), "wss://gateway.example/");
        }
        assert_eq!(
            normalize_url("https://gateway.example/control/").unwrap(),
            "wss://gateway.example/control/"
        );
        assert_eq!(
            normalize_url("ws://127.0.0.1:19471").unwrap(),
            "ws://127.0.0.1:19471/"
        );
        assert_eq!(
            normalize_url("http://[::1]:19471").unwrap(),
            "ws://[::1]:19471/"
        );
        for input in [
            "",
            "ws://remote.example",
            "http://10.0.0.1",
            "https://user:secret@gateway.example",
            "https://gateway.example/?token=secret",
            "https://gateway.example/#fragment",
            "ftp://gateway.example",
            "https://gateway.example:0",
        ] {
            assert!(normalize_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn cli_env_and_json5_config_follow_per_field_precedence() {
        let file: Value = json5::from_str(
            "{gateway: {port: 19471, auth: {token: 'file-token', password: 'file-password',},},}",
        )
        .unwrap();
        let environment = Environment::from([
            ("OPENCLAW_GATEWAY_URL".into(), "ws://127.0.0.1:19472".into()),
            ("OPENCLAW_GATEWAY_TOKEN".into(), "env-token".into()),
        ]);
        let cli = parse_args(
            ["--url=ws://127.0.0.1:19473", "--token", "cli-token"]
                .into_iter()
                .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(
            resolve(&cli, &environment, &file).unwrap(),
            ConnectionConfig {
                url: "ws://127.0.0.1:19473".into(),
                token: Some("cli-token".into()),
                password: Some("file-password".into()),
            }
        );
        let config = resolve(&Overrides::default(), &environment, &file).unwrap();
        assert_eq!(config.url, "ws://127.0.0.1:19472");
        assert_eq!(config.token.as_deref(), Some("env-token"));
        assert_eq!(
            resolve(&Overrides::default(), &Environment::new(), &file)
                .unwrap()
                .url,
            "ws://127.0.0.1:19471"
        );
    }

    #[test]
    fn remote_mode_uses_remote_credentials_and_requires_an_endpoint() {
        let file = json!({"gateway": {"mode": "remote", "remote": {
            "url": "wss://gateway.example", "token": "remote-token", "password": "remote-password"
        }, "auth": {"token": "local-token"}}});
        let config = resolve(&Overrides::default(), &Environment::new(), &file).unwrap();
        assert_eq!(config.url, "wss://gateway.example");
        assert_eq!(config.token.as_deref(), Some("remote-token"));
        assert_eq!(config.password.as_deref(), Some("remote-password"));
        assert!(
            resolve(
                &Overrides::default(),
                &Environment::new(),
                &json!({"gateway": {"mode": "remote"}})
            )
            .is_err()
        );
        assert_eq!(
            resolve(&Overrides::default(), &Environment::new(), &Value::Null)
                .unwrap()
                .url,
            "ws://127.0.0.1:18789"
        );
    }

    #[test]
    fn config_path_obeys_explicit_path_then_state_directory() {
        let home = std::path::Path::new("/fixture-home");
        let mut environment = Environment::new();
        assert_eq!(
            config_path(&environment, home),
            home.join(".openclaw/openclaw.json")
        );
        environment.insert("OPENCLAW_STATE_DIR".into(), "~/isolated".into());
        assert_eq!(
            config_path(&environment, home),
            home.join("isolated/openclaw.json")
        );
        environment.insert(
            "OPENCLAW_CONFIG_PATH".into(),
            "/fixture/config.json5".into(),
        );
        assert_eq!(
            config_path(&environment, home),
            PathBuf::from("/fixture/config.json5")
        );
    }
}
