use std::{
    collections::HashSet,
    ffi::OsString,
    io::Read,
    net::{Ipv6Addr, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

const READY_TIMEOUT: Duration = Duration::from_secs(8);
const STDERR_LIMIT: usize = 4096;

#[derive(Default)]
struct ProcessRegistry {
    closing: bool,
    pids: HashSet<u32>,
}

fn processes() -> &'static Mutex<ProcessRegistry> {
    static PROCESSES: OnceLock<Mutex<ProcessRegistry>> = OnceLock::new();
    PROCESSES.get_or_init(Mutex::default)
}

fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // Every registered spawn created its own process group, including SSH proxies.
        if let Ok(pid) = i32::try_from(pid) {
            unsafe { kill(-pid, 9) };
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Cocoa allows only a short asynchronous quit drain. Fence spawns and terminate
/// owned processes synchronously before waiting for connection actors to finish.
pub fn shutdown_all() {
    let mut registry = processes()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    registry.closing = true;
    for pid in &registry.pids {
        kill_process_tree(*pid);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    pub target: String,
    pub port: Option<u16>,
}

pub fn parse_ssh_target(raw: &str) -> Result<SshTarget, String> {
    let invalid = || "Enter an SSH target such as user@host or user@host:2222".to_owned();
    let value = raw.trim();
    if value.is_empty()
        || value.starts_with('-')
        || value.matches('@').count() > 1
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid());
    }
    let (user, host_port) = value
        .split_once('@')
        .map_or((None, value), |(user, host)| (Some(user), host));
    if user.is_some_and(|user| user.is_empty() || user.starts_with('-'))
        || host_port.is_empty()
        || host_port.starts_with('-')
    {
        return Err(invalid());
    }
    let port = |value: &str| {
        value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(invalid)
    };
    let (host, ssh_port) = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']').ok_or_else(invalid)?;
        host.parse::<Ipv6Addr>().map_err(|_| invalid())?;
        let ssh_port = if suffix.is_empty() {
            None
        } else {
            Some(port(suffix.strip_prefix(':').ok_or_else(invalid)?)?)
        };
        (host, ssh_port)
    } else if let Some((host, suffix)) = host_port.rsplit_once(':') {
        if host.contains(':') {
            return Err("Use brackets around an IPv6 SSH host, such as user@[::1]:2222".into());
        }
        (host, Some(port(suffix)?))
    } else {
        (host_port, None)
    };
    if host.is_empty() || host.starts_with('-') || host.contains(['[', ']']) {
        return Err(invalid());
    }
    Ok(SshTarget {
        target: user.map_or_else(|| host.to_owned(), |user| format!("{user}@{host}")),
        port: ssh_port,
    })
}

fn ssh_arguments(
    target: &SshTarget,
    local_port: u16,
    remote_port: u16,
    identity_file: Option<&Path>,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-N"),
        OsString::from("-L"),
        OsString::from(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}")),
    ];
    if let Some(port) = target.port {
        args.extend([OsString::from("-p"), OsString::from(port.to_string())]);
    }
    if let Some(identity) = identity_file.filter(|path| !path.as_os_str().is_empty()) {
        // As in the Mac app, explicit keys restrict identities; otherwise SSH agents work.
        args.extend(["-o", "IdentitiesOnly=yes", "-i"].map(OsString::from));
        args.push(identity.as_os_str().to_owned());
    }
    args.extend(
        [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ControlPersist=no",
            "-o",
            "ForkAfterAuthentication=no",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "--",
            &target.target,
        ]
        .map(OsString::from),
    );
    args
}

fn reserve_loopback_port() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a local SSH tunnel port: {error}"))
}

/// One connection actor owns this child and its restart/backoff policy.
/// The forwarding URL is transport only; pairing identity belongs to the profile.
pub struct SshTunnel {
    child: Child,
    url: String,
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    stopped: bool,
}

impl SshTunnel {
    /// Blocking preparation; run off the UI/runtime executor and cancel on window retirement.
    pub fn start(
        target: &str,
        remote_port: u16,
        identity_file: Option<&Path>,
        cancelled: impl Fn() -> bool,
    ) -> Result<Self, String> {
        if remote_port == 0 {
            return Err("Remote Gateway port must be between 1 and 65535".into());
        }
        let target = parse_ssh_target(target)?;
        let reservation = reserve_loopback_port()?;
        let local_port = reservation
            .local_addr()
            .map_err(|error| format!("Could not read the local SSH tunnel port: {error}"))?
            .port();
        let mut command = Command::new("ssh");
        command
            .args(ssh_arguments(
                &target,
                local_port,
                remote_port,
                identity_file,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        if cancelled() {
            return Err("SSH connection was canceled".into());
        }
        // SSH must bind the listener itself. ExitOnForwardFailure handles a bind race.
        drop(reservation);
        let child = {
            // Registration and the shutdown fence are atomic with respect to spawn.
            let mut registry = processes()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if registry.closing || cancelled() {
                return Err("SSH connection was canceled".into());
            }
            let child = command.spawn().map_err(|error| {
                format!("Could not start SSH; verify OpenSSH is installed: {error}")
            })?;
            registry.pids.insert(child.id());
            child
        };
        let mut tunnel = Self {
            child,
            url: format!("ws://127.0.0.1:{local_port}/"),
            stderr: Arc::default(),
            stderr_reader: None,
            stopped: false,
        };
        let stderr = tunnel.stderr.clone();
        let mut pipe = tunnel.child.stderr.take().expect("piped SSH stderr");
        tunnel.stderr_reader = Some(
            thread::Builder::new()
                .name("gateway-ssh-stderr".into())
                .spawn(move || {
                    let mut buffer = [0; 1024];
                    loop {
                        let count = match pipe.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => count,
                        };
                        if let Ok(mut tail) = stderr.lock() {
                            tail.extend_from_slice(&buffer[..count]);
                            let excess = tail.len().saturating_sub(STDERR_LIMIT);
                            tail.drain(..excess);
                        }
                    }
                })
                .map_err(|error| format!("Could not capture SSH diagnostics: {error}"))?,
        );
        let deadline = Instant::now() + READY_TIMEOUT;
        let address = SocketAddr::from(([127, 0, 0, 1], local_port));
        loop {
            if cancelled() {
                return Err("SSH connection was canceled".into());
            }
            if !tunnel.is_running()? {
                // Drop kills any remaining proxy children before joining the pipe reader.
                tunnel.stop();
                let detail = tunnel
                    .stderr
                    .lock()
                    .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
                    .unwrap_or_default();
                return Err(if detail.is_empty() {
                    "SSH exited before listening. Verify the host key and SSH key authentication"
                        .into()
                } else {
                    format!(
                        "SSH connection failed: {detail}. Verify the host key and SSH key authentication"
                    )
                });
            }
            if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
                return Ok(tunnel);
            }
            if Instant::now() >= deadline {
                return Err("SSH tunnel did not become ready. Verify the host and SSH key".into());
            }
            thread::sleep(Duration::from_millis(75));
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn is_running(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|exit| exit.is_none())
            .map_err(|error| format!("Could not inspect SSH tunnel: {error}"))
    }

    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        {
            let mut registry = processes()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            kill_process_tree(self.child.id());
            registry.pids.remove(&self.child.id());
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_targets_preserve_alias_ports_and_reject_options_or_ambiguous_addresses() {
        for (raw, target, port) in [
            (
                " operator@studio.local:2222 ",
                "operator@studio.local",
                Some(2222),
            ),
            ("studio", "studio", None),
            ("studio:22", "studio", Some(22)),
            ("operator@[::1]:2222", "operator@::1", Some(2222)),
            ("[::1]", "::1", None),
        ] {
            assert_eq!(
                parse_ssh_target(raw).unwrap(),
                SshTarget {
                    target: target.into(),
                    port
                }
            );
        }
        for raw in [
            "",
            "-oProxyCommand=touch",
            "operator@-unsafe",
            "operator@studio -p22",
            "operator@@studio",
            "@studio",
            "operator@",
            "studio:0",
            "studio:65536",
            "studio:",
            "operator@studio\n-oControlPath=bad",
            "::1",
            "[bad]:22",
            "[::1]oops",
        ] {
            assert!(parse_ssh_target(raw).is_err(), "accepted {raw:?}");
        }
    }

    #[test]
    fn invocation_matches_tauri_and_keeps_identity_paths_as_one_argument() {
        let target = parse_ssh_target("operator@studio.local:2222").unwrap();
        let args = ssh_arguments(&target, 49153, 19471, Some(Path::new("/keys/a key's file")));
        let expected = [
            "-N",
            "-L",
            "127.0.0.1:49153:127.0.0.1:19471",
            "-p",
            "2222",
            "-o",
            "IdentitiesOnly=yes",
            "-i",
            "/keys/a key's file",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ControlPersist=no",
            "-o",
            "ForkAfterAuthentication=no",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "--",
            "operator@studio.local",
        ]
        .map(OsString::from);
        assert_eq!(args, expected);
        let agent_args = ssh_arguments(&parse_ssh_target("studio").unwrap(), 49154, 19471, None);
        assert!(
            !agent_args
                .iter()
                .any(|arg| arg == "IdentitiesOnly=yes" || arg == "-i" || arg == "-p")
        );
        assert_eq!(&agent_args[agent_args.len() - 2..], ["--", "studio"]);
    }

    #[test]
    fn ephemeral_reservations_never_reuse_an_existing_listener() {
        let first = reserve_loopback_port().unwrap();
        let second = reserve_loopback_port().unwrap();
        let first_address = first.local_addr().unwrap();
        let second_address = second.local_addr().unwrap();
        assert!(first_address.ip().is_loopback());
        assert!(second_address.ip().is_loopback());
        assert_ne!(first_address.port(), 0);
        assert_ne!(first_address, second_address);
        assert!(TcpListener::bind(first_address).is_err());
        assert!(TcpListener::bind(second_address).is_err());
    }
}
