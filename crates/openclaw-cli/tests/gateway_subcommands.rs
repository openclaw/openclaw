//! `openclaw gateway <subcommand>` must dispatch, not fall through to `run`.
//!
//! Reproduced with a *valid* config: without one, `run_gateway` fails validation
//! and the fall-through bug is masked. With a valid config, `gateway stop` starts
//! a foreground Gateway and blocks the terminal, and `restart` dies on
//! EADDRINUSE after binding a second listener.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-gwsub-{}-{}",
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

    /// Valid config on an ephemeral-ish port, with the Control UI disabled so the
    /// run path has nothing else to bind.
    fn seed(&self, port: u16) {
        let value = serde_json::json!({
            "gateway": {
                "mode": "local",
                "listen": format!("127.0.0.1:{port}"),
                "requireAuth": false,
                "controlUiEnabled": false
            },
            "database": { "path": self.root.join("db.sqlite").display().to_string() }
        });
        std::fs::write(self.config(), serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    fn run(&self, args: &[&str], wait: Duration) -> Option<Output> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_openclaw"))
            .args(args)
            .env("OPENCLAW_CONFIG_PATH", self.config())
            .env("OPENCLAW_STATE_DIR", &self.root)
            .env("HOME", &self.root)
            .env_remove("OPENCLAW_GATEWAY_TOKEN")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn openclaw");
        let deadline = Instant::now() + wait;
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => return Some(child.wait_with_output().expect("output")),
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn gateway_stop_with_a_valid_config_does_not_start_a_gateway() {
    let sandbox = Sandbox::new("stop");
    sandbox.seed(free_port());
    let output = sandbox
        .run(&["gateway", "stop"], Duration::from_secs(6))
        .expect("`gateway stop` did not exit — it fell through to `run` and started a Gateway");
    let text = combined(&output);
    assert!(
        !text.contains("openclaw ready"),
        "`gateway stop` started a Gateway:\n{text}"
    );
    assert!(
        !output.status.success(),
        "`gateway stop` exited 0 without stopping anything:\n{text}"
    );
}

#[test]
fn gateway_restart_with_a_valid_config_does_not_start_a_gateway() {
    let sandbox = Sandbox::new("restart");
    sandbox.seed(free_port());
    let output = sandbox
        .run(&["gateway", "restart"], Duration::from_secs(6))
        .expect("`gateway restart` did not exit — it fell through to `run`");
    let text = combined(&output);
    assert!(
        !text.contains("openclaw ready"),
        "`gateway restart` started a Gateway:\n{text}"
    );
    assert!(!output.status.success(), "`gateway restart` exited 0:\n{text}");
}

#[test]
fn unknown_gateway_subcommand_with_a_valid_config_is_rejected() {
    let sandbox = Sandbox::new("unknown");
    sandbox.seed(free_port());
    let output = sandbox
        .run(&["gateway", "frobnicate"], Duration::from_secs(6))
        .expect("unknown subcommand did not exit — it fell through to `run`");
    assert!(
        !output.status.success(),
        "unknown subcommand exited 0:\n{}",
        combined(&output)
    );
}
