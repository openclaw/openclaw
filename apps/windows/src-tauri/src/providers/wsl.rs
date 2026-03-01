use crate::error::OpenClawError;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub trait WslProvider: Send + Sync {
    fn get_status(&self) -> bool;
    fn get_distro(&self) -> Option<String>;
    fn run_command(
        &self,
        args: &[&str],
        interactive: bool,
    ) -> crate::error::Result<std::process::Output>;
    fn spawn_command(&self, args: &[&str]) -> crate::error::Result<std::process::Child>;
}

pub struct RealWslProvider;

impl WslProvider for RealWslProvider {
    fn get_status(&self) -> bool {
        let output = Command::new("wsl")
            .args(&["--status"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }

    fn get_distro(&self) -> Option<String> {
        let output = Command::new("wsl")
            .args(&["-l", "-q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(o) => {
                // WSL output on Windows is often UTF-16LE.
                // If it contains null bytes, it's likely UTF-16LE.
                let stdout = if o.stdout.contains(&0) && o.stdout.len() % 2 == 0 {
                    let u16_data: Vec<u16> = o
                        .stdout
                        .chunks_exact(2)
                        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16_data)
                } else {
                    String::from_utf8_lossy(&o.stdout).to_string()
                };

                stdout
                    .lines()
                    .map(|l| l.trim().trim_matches('\0'))
                    .filter(|l| !l.is_empty() && !l.contains("Default Version"))
                    .next()
                    .map(|s| s.to_string())
            }
            Err(_) => None,
        }
    }

    fn run_command(
        &self,
        args: &[&str],
        interactive: bool,
    ) -> crate::error::Result<std::process::Output> {
        let mut cmd = Command::new("wsl");
        cmd.args(args);
        if !interactive {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.output().map_err(OpenClawError::from)
    }

    fn spawn_command(&self, args: &[&str]) -> crate::error::Result<std::process::Child> {
        Command::new("wsl")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(OpenClawError::from)
    }
}
