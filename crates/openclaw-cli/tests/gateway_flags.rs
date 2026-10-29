//! `openclaw gateway` must honor its documented flags.
//!
//! Official reference: `docs/cli/gateway/running.md` — `--port`, `--bind`,
//! `--token`, `--auth`, `--password`, `--verbose`, `--force`, `--dev`, `--reset`.
//! The Rust CLI recognized only `--config`/`--listen`/`--dashboard` and skipped
//! every other token, so `--port 19001` silently bound the default port and
//! `--token` never authenticated anything.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-gwflags-{}-{}",
            std::process::id(),
            label
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn config(&self) -> PathBuf {
        self.root.join("openclaw.json")
    }

    fn seed(&self) {
        let value = serde_json::json!({
            "gateway": {
                "mode": "local",
                "listen": "127.0.0.1:18789",
                "requireAuth": false,
                "controlUiEnabled": false
            },
            "database": { "path": self.root.join("db.sqlite").display().to_string() }
        });
        std::fs::write(self.config(), serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    fn spawn(&self, args: &[&str]) -> std::process::Child {
        Command::new(env!("CARGO_BIN_EXE_openclaw"))
            .args(args)
            .env("OPENCLAW_CONFIG_PATH", self.config())
            .env("OPENCLAW_STATE_DIR", &self.root)
            .env("HOME", &self.root)
            .env_remove("OPENCLAW_GATEWAY_TOKEN")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn openclaw")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn wait_for_port(port: u16, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn kill(mut child: std::process::Child) -> Output {
    let _ = child.kill();
    child.wait_with_output().expect("output")
}

#[test]
fn port_flag_selects_the_listener() {
    let sandbox = Sandbox::new("port");
    sandbox.seed();
    let port = free_port();

    let mut child = sandbox.spawn(&["gateway", "run", "--port", &port.to_string()]);
    let bound = wait_for_port(port, Duration::from_secs(8));
    let output = kill(child);
    assert!(
        bound,
        "`--port {port}` did not bind that port:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn token_flag_authenticates_without_a_config_secret() {
    let sandbox = Sandbox::new("token");
    sandbox.seed();
    let port = free_port();

    let child = sandbox.spawn(&[
        "gateway",
        "run",
        "--port",
        &port.to_string(),
        "--token",
        "synthetic-cli-token",
    ]);
    assert!(
        wait_for_port(port, Duration::from_secs(8)),
        "Gateway did not start with --token"
    );
    let output = kill(child);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // With --token the Gateway must require auth, not silently run open.
    assert!(
        !text.contains("requireAuth=false") && !text.contains("auth: none"),
        "`--token` was ignored:\n{text}"
    );
}

#[test]
fn unknown_flags_are_rejected_instead_of_ignored() {
    let sandbox = Sandbox::new("unknown");
    sandbox.seed();
    let mut child = sandbox.spawn(&["gateway", "run", "--frobnicate"]);
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(_) => {
                let output = child.wait_with_output().expect("output");
                assert!(
                    !output.status.success(),
                    "unknown gateway flag was silently ignored:\n{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("unknown flag did not fail — the Gateway started instead");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
