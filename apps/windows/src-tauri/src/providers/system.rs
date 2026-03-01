use crate::error::OpenClawError;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::os::windows::process::CommandExt;

pub trait SystemProvider: Send + Sync {
    fn get_accent_color(&self) -> Option<(u8, u8, u8, String)>;
    fn create_pty(
        &self,
        command: &str,
        args: &[String],
        rows: u16,
        cols: u16,
    ) -> crate::error::Result<PtyHandle>;
    fn kill_process_tree(&self, pid: u32) -> crate::error::Result<()>;
    fn run_command(
        &self,
        command: &[String],
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        timeout_ms: Option<u64>,
    ) -> crate::error::Result<std::process::Output>;
}

pub struct PtyHandle {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send>,
}

pub struct RealSystemProvider;

impl SystemProvider for RealSystemProvider {
    fn get_accent_color(&self) -> Option<(u8, u8, u8, String)> {
        let output = std::process::Command::new("reg")
            .args(&[
                "query",
                "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\DWM",
                "/v",
                "AccentColor",
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = stdout.split_whitespace().collect();
        let hex_str = parts.iter().find(|p| p.starts_with("0x"))?;

        let val = u32::from_str_radix(&hex_str[2..], 16).ok()?;

        let r = (val & 0xFF) as u8;
        let g = ((val >> 8) & 0xFF) as u8;
        let b = ((val >> 16) & 0xFF) as u8;

        Some((r, g, b, format!("#{:02x}{:02x}{:02x}", r, g, b)))
    }

    fn create_pty(
        &self,
        command: &str,
        args: &[String],
        rows: u16,
        cols: u16,
    ) -> crate::error::Result<PtyHandle> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| OpenClawError::Internal(format!("Failed to create PTY: {}", e)))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| OpenClawError::Internal(format!("Failed to spawn command: {}", e)))?;

        // Release slave immediately
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| OpenClawError::Internal(format!("Failed to take writer: {}", e)))?;

        Ok(PtyHandle {
            writer,
            master: pair.master,
            child,
        })
    }
    fn kill_process_tree(&self, pid: u32) -> crate::error::Result<()> {
        std::process::Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/F", "/T"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| OpenClawError::Internal(format!("Failed to kill process tree: {}", e)))?;
        Ok(())
    }

    fn run_command(
        &self,
        command: &[String],
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        timeout_ms: Option<u64>,
    ) -> crate::error::Result<std::process::Output> {
        if command.is_empty() {
            return Err(OpenClawError::Internal(
                "Command cannot be empty".to_string(),
            ));
        }

        let mut cmd = std::process::Command::new(&command[0]);
        cmd.args(&command[1..]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }

        if let Some(env) = env {
            cmd.envs(env);
        }

        if let Some(timeout_ms) = timeout_ms {
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| {
                let mut msg = format!("Failed to run command {:?}: {}", command, e);
                if command.len() == 1 && command[0].contains(' ') && e.kind() == std::io::ErrorKind::NotFound {
                    msg.push_str(". HINT: Split the command and arguments into separate strings in the array (e.g., [\"exe\", \"arg1\", \"arg2\"])");
                }
                OpenClawError::Internal(msg)
            })?;

            use wait_timeout::ChildExt;
            match child.wait_timeout(std::time::Duration::from_millis(timeout_ms)) {
                Ok(Some(status)) => {
                    let mut stdout = Vec::new();
                    let mut stderr = Vec::new();
                    if let Some(mut out) = child.stdout.take() {
                        use std::io::Read;
                        let _ = out.read_to_end(&mut stdout);
                    }
                    if let Some(mut err) = child.stderr.take() {
                        use std::io::Read;
                        let _ = err.read_to_end(&mut stderr);
                    }
                    Ok(std::process::Output {
                        status,
                        stdout,
                        stderr,
                    })
                }
                Ok(None) => {
                    let _ = child.kill();
                    Err(OpenClawError::Internal("Command timed out".to_string()))
                }
                Err(e) => Err(OpenClawError::Internal(format!(
                    "Wait timeout failed: {}",
                    e
                ))),
            }
        } else {
            cmd.output().map_err(|e| {
                let mut msg = format!("Failed to run command {:?}: {}", command, e);
                if command.len() == 1 && command[0].contains(' ') && e.kind() == std::io::ErrorKind::NotFound {
                    msg.push_str(". HINT: Split the command and arguments into separate strings in the array (e.g., [\"exe\", \"arg1\", \"arg2\"])");
                }
                OpenClawError::Internal(msg)
            })
        }
    }
}
