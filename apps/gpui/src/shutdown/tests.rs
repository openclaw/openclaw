use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

use crate::gateway::remote_tunnel::SshTunnel;

const FIXTURE: &str = "shutdown::tests::signal_process_fixture";
const TIMEOUT: Duration = Duration::from_secs(5);

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

fn fixture_command(role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
        .env("OPENCLAW_GPUI_SIGNAL_TEST_ROLE", role)
        .stdout(Stdio::null());
    command
}

fn report_ready(role: &str) -> UnixStream {
    let mut stream =
        UnixStream::connect(std::env::var_os("OPENCLAW_GPUI_SIGNAL_TEST_SOCKET").unwrap()).unwrap();
    writeln!(stream, "{role}:{}", std::process::id()).unwrap();
    stream
}

#[test]
#[ignore = "subprocess fixture for unix_signals_terminate_tunnel_process_groups"]
fn signal_process_fixture() {
    match std::env::var("OPENCLAW_GPUI_SIGNAL_TEST_ROLE")
        .unwrap()
        .as_str()
    {
        "app" => {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let termination = super::watch_signals(runtime.handle()).unwrap();
            let tunnel = SshTunnel::start("fixture@127.0.0.1", 49250, None, || false).unwrap();
            let mut control = report_ready("app");
            runtime.block_on(termination.recv()).unwrap();
            assert!(
                SshTunnel::start("fixture@127.0.0.1", 49250, None, || false)
                    .is_err_and(|error| error == "SSH connection was canceled")
            );
            control.write_all(b"fenced\n").unwrap();
            // Keep the owner alive until the parent observes both SSH and proxy
            // sockets closing. Drop alone must not make this regression pass.
            control.read_exact(&mut [0]).unwrap();
            drop(tunnel);
        }
        "ssh" => {
            let forward = std::env::var("OPENCLAW_GPUI_SIGNAL_TEST_FORWARD").unwrap();
            let port: u16 = forward.split(':').nth(1).unwrap().parse().unwrap();
            let _listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
            let mut proxy = fixture_command("proxy").spawn().unwrap();
            let mut control = report_ready("ssh");
            let _ = control.read(&mut [0]);
            let _ = proxy.wait();
        }
        "proxy" => {
            let mut control = report_ready("proxy");
            let _ = control.read(&mut [0]);
        }
        role => panic!("unexpected fixture role {role}"),
    }
}

struct Fixture {
    directory: PathBuf,
    app: Option<Child>,
    ssh_pid: Option<i32>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Own only these process groups; clean up even when the regression fails.
        unsafe {
            if let Some(app) = &self.app {
                kill(-(app.id() as i32), 9);
            }
            if let Some(pid) = self.ssh_pid {
                kill(-pid, 9);
            }
        }
        if let Some(app) = &mut self.app {
            let _ = app.wait();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
async fn unix_signals_terminate_tunnel_process_groups() {
    // SIGTERM is the reported bug. INT/HUP share the same owner; the final case
    // also proves that a busy foreground quit can still be interrupted again.
    for (first_signal, second_signal) in [(15, None), (2, None), (1, None), (15, Some(1))] {
        let directory =
            std::env::temp_dir().join(format!("oc-sig-{:x}", uuid::Uuid::new_v4().as_u64_pair().0));
        fs::create_dir(&directory).unwrap();
        let mut fixture = Fixture {
            directory: directory.clone(),
            app: None,
            ssh_pid: None,
        };
        let script = directory.join("ssh");
        fs::write(
            &script,
            "#!/bin/sh\nexport OPENCLAW_GPUI_SIGNAL_TEST_ROLE=ssh\nexport OPENCLAW_GPUI_SIGNAL_TEST_FORWARD=\"$3\"\nexec \"$OPENCLAW_GPUI_SIGNAL_TEST_EXECUTABLE\" --exact shutdown::tests::signal_process_fixture --ignored --nocapture\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = directory.join("control.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let app = fixture_command("app")
            .env("PATH", &directory)
            .env("OPENCLAW_GPUI_SIGNAL_TEST_SOCKET", &socket)
            .env(
                "OPENCLAW_GPUI_SIGNAL_TEST_EXECUTABLE",
                std::env::current_exe().unwrap(),
            )
            .env("OPENCLAW_GPUI_STATE_DIR", directory.join("state"))
            .process_group(0)
            .spawn()
            .unwrap();
        let app_pid = app.id() as i32;
        fixture.app = Some(app);
        let mut clients = HashMap::new();
        for _ in 0..3 {
            let (stream, _) = tokio::time::timeout(TIMEOUT, listener.accept())
                .await
                .expect("fixture did not become ready")
                .unwrap();
            let stream = stream.into_std().unwrap();
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(TIMEOUT)).unwrap();
            let mut stream = BufReader::new(stream);
            let mut ready = String::new();
            stream.read_line(&mut ready).unwrap();
            let (role, pid) = ready.trim().split_once(':').unwrap();
            if role == "ssh" {
                fixture.ssh_pid = Some(pid.parse().unwrap());
            }
            clients.insert(role.to_owned(), stream);
        }
        assert_eq!(unsafe { kill(app_pid, first_signal) }, 0);
        let mut app = clients.remove("app").unwrap();
        let mut receipt = String::new();
        app.read_line(&mut receipt).unwrap();
        assert_eq!(
            receipt, "fenced\n",
            "signal did not request normal shutdown"
        );
        for role in ["ssh", "proxy"] {
            assert_eq!(
                clients.get_mut(role).unwrap().read(&mut [0]).unwrap(),
                0,
                "signal left {role} alive"
            );
        }
        fixture.ssh_pid = None;
        if let Some(second_signal) = second_signal {
            assert_eq!(unsafe { kill(app_pid, second_signal) }, 0);
        } else {
            app.get_mut().write_all(b"q").unwrap();
        }
        assert_eq!(app.read(&mut [0]).unwrap(), 0);
        assert_eq!(
            fixture.app.as_mut().unwrap().wait().unwrap().code(),
            Some(second_signal.map_or(0, |signal| 128 + signal))
        );
        fixture.app = None;
    }
}
