#![cfg(target_os = "linux")]

#[path = "../src/keep_awake.rs"]
mod keep_awake;
#[path = "../src/keep_awake_platform.rs"]
mod keep_awake_platform;

use futures_util::StreamExt;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::mpsc;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

struct Bus {
    child: Child,
    previous: Option<String>,
}
impl Bus {
    fn start() -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("install dbus-daemon for portal tests");
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        assert!(!address.trim().is_empty());
        let previous = std::env::var("DBUS_SESSION_BUS_ADDRESS").ok();
        std::env::set_var("DBUS_SESSION_BUS_ADDRESS", address.trim());
        Self { child, previous }
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("DBUS_SESSION_BUS_ADDRESS", previous);
        } else {
            std::env::remove_var("DBUS_SESSION_BUS_ADDRESS");
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Request {
    events: mpsc::UnboundedSender<String>,
    fail_close: Arc<AtomicBool>,
}
#[zbus::interface(name = "org.freedesktop.portal.Request")]
impl Request {
    fn close(&self) -> zbus::fdo::Result<()> {
        self.events.send("close".into()).unwrap();
        if self.fail_close.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::Failed("fixture close failure".into()));
        }
        Ok(())
    }
}

struct Portal {
    events: mpsc::UnboundedSender<String>,
    fail: Arc<AtomicBool>,
    fail_close: Arc<AtomicBool>,
}
#[zbus::interface(name = "org.freedesktop.portal.Inhibit")]
impl Portal {
    async fn inhibit(
        &self,
        window: &str,
        flags: u32,
        options: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert_eq!(window, "");
        assert_eq!(flags, 8, "must not inhibit manual suspend/logout");
        assert_eq!(
            options.get("reason").and_then(|v| <&str>::try_from(v).ok()),
            Some("OpenClaw: Keep computer awake")
        );
        let token = options
            .get("handle_token")
            .and_then(|v| <&str>::try_from(v).ok())
            .unwrap();
        let sender = header.sender().unwrap();
        let path = format!(
            "/org/freedesktop/portal/desktop/request/{}/{}",
            sender.as_str().trim_start_matches(':').replace('.', "_"),
            token
        );
        connection
            .object_server()
            .at(
                path.as_str(),
                Request {
                    events: self.events.clone(),
                    fail_close: Arc::clone(&self.fail_close),
                },
            )
            .await
            .unwrap();
        self.events.send(sender.to_string()).unwrap();
        // Deliberately emit before the method reply: subscribing after Inhibit loses it.
        let code = if self.fail.load(Ordering::SeqCst) {
            2_u32
        } else {
            0_u32
        };
        connection
            .emit_signal(
                Some(sender.as_str()),
                path.as_str(),
                "org.freedesktop.portal.Request",
                "Response",
                &(code, HashMap::<String, OwnedValue>::new()),
            )
            .await
            .unwrap();
        Ok(OwnedObjectPath::try_from(path).unwrap())
    }
}

struct GnomeSession {
    events: mpsc::UnboundedSender<String>,
    fail: Arc<AtomicBool>,
}

#[zbus::interface(name = "org.gnome.SessionManager")]
impl GnomeSession {
    fn inhibit(
        &self,
        app_id: &str,
        window: u32,
        reason: &str,
        flags: u32,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<u32> {
        assert_eq!(
            (app_id, window, reason, flags),
            ("OpenClaw", 0, "OpenClaw: Keep computer awake", 8)
        );
        self.events
            .send(header.sender().unwrap().to_string())
            .unwrap();
        if self.fail.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::Failed("fixture GNOME refusal".into()));
        }
        Ok(41)
    }

    fn uninhibit(&self, cookie: u32) {
        assert_eq!(cookie, 41);
        self.events.send("gnome-release".into()).unwrap();
    }
}

async fn event(events: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn status(
    reports: &mut mpsc::UnboundedReceiver<keep_awake::Status>,
    active: bool,
    error: bool,
) {
    let status = tokio::time::timeout(Duration::from_secs(5), reports.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.active, active);
    assert_eq!(status.error.is_some(), error, "{status:?}");
}

async fn disconnected(bus: &zbus::fdo::DBusProxy<'_>, sender: &str) {
    let mut changes = bus
        .receive_name_owner_changed_with_args(&[(0, sender)])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while bus
            .name_has_owner(sender.try_into().unwrap())
            .await
            .unwrap()
        {
            changes.next().await.expect("bus owner-change stream ended");
        }
    })
    .await
    .expect("portal client connection leaked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn portal_native_boundary_handles_early_response_errors_release_and_shutdown() {
    let _bus = Bus::start();
    let (events, mut observed) = mpsc::unbounded_channel();
    let fail = Arc::new(AtomicBool::new(false));
    let fail_close = Arc::new(AtomicBool::new(false));
    let server = zbus::connection::Builder::session()
        .unwrap()
        .name("org.freedesktop.portal.Desktop")
        .unwrap()
        .serve_at(
            "/org/freedesktop/portal/desktop",
            Portal {
                events: events.clone(),
                fail: Arc::clone(&fail),
                fail_close: Arc::clone(&fail_close),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let saved = Arc::new(AtomicBool::new(false));
    let write = Arc::clone(&saved);
    let (report, mut reports) = mpsc::unbounded_channel();
    let owner = keep_awake::KeepAwake::start(
        || Ok(false),
        move |enabled| {
            write.store(enabled, Ordering::SeqCst);
            Ok(())
        },
        keep_awake_platform::Inhibitor::acquire,
        move |status| {
            report.send(status).unwrap();
        },
    )
    .unwrap();
    status(&mut reports, false, false).await;
    assert!(
        observed.try_recv().is_err(),
        "default-off must not request a portal lease"
    );
    owner.toggle().unwrap();
    let first_sender = event(&mut observed).await;
    status(&mut reports, true, false).await;
    assert!(saved.load(Ordering::SeqCst));
    fail_close.store(true, Ordering::SeqCst);
    owner.toggle().unwrap();
    assert_eq!(event(&mut observed).await, "close");
    status(&mut reports, true, true).await;
    fail_close.store(false, Ordering::SeqCst);
    owner.toggle().unwrap();
    assert_eq!(event(&mut observed).await, "close");
    status(&mut reports, false, false).await;
    assert!(!saved.load(Ordering::SeqCst));
    let bus = zbus::fdo::DBusProxy::new(&server).await.unwrap();
    disconnected(&bus, &first_sender).await;
    fail.store(true, Ordering::SeqCst);
    owner.toggle().unwrap();
    let failed_sender = event(&mut observed).await;
    status(&mut reports, false, true).await;
    assert!(
        !saved.load(Ordering::SeqCst),
        "a backend error must not persist enabled"
    );
    disconnected(&bus, &failed_sender).await;
    fail.store(false, Ordering::SeqCst);
    owner.toggle().unwrap();
    let last_sender = event(&mut observed).await;
    status(&mut reports, true, false).await;
    tokio::task::spawn_blocking(move || owner.wait_stopped())
        .await
        .unwrap();
    assert_eq!(event(&mut observed).await, "close");
    assert!(
        saved.load(Ordering::SeqCst),
        "quitting must retain user intent for next launch"
    );
    disconnected(&bus, &last_sender).await;

    // A native GNOME owner takes precedence even with a working portal. Its
    // synchronous cookie avoids the GTK portal's empty unsandboxed app ID.
    let gnome = zbus::connection::Builder::session()
        .unwrap()
        .name("org.gnome.SessionManager")
        .unwrap()
        .serve_at(
            "/org/gnome/SessionManager",
            GnomeSession {
                events,
                fail: Arc::clone(&fail),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    saved.store(false, Ordering::SeqCst);
    let write = Arc::clone(&saved);
    let (report, mut reports) = mpsc::unbounded_channel();
    let owner = keep_awake::KeepAwake::start(
        || Ok(false),
        move |enabled| {
            write.store(enabled, Ordering::SeqCst);
            Ok(())
        },
        keep_awake_platform::Inhibitor::acquire,
        move |status| {
            report.send(status).unwrap();
        },
    )
    .unwrap();
    status(&mut reports, false, false).await;
    owner.toggle().unwrap();
    let gnome_sender = event(&mut observed).await;
    status(&mut reports, true, false).await;
    owner.toggle().unwrap();
    assert_eq!(event(&mut observed).await, "gnome-release");
    status(&mut reports, false, false).await;
    disconnected(&bus, &gnome_sender).await;
    fail.store(true, Ordering::SeqCst);
    owner.toggle().unwrap();
    let failed_sender = event(&mut observed).await;
    status(&mut reports, false, true).await;
    assert!(!saved.load(Ordering::SeqCst));
    disconnected(&bus, &failed_sender).await;
    assert!(
        observed.try_recv().is_err(),
        "GNOME refusal must not fall back to a false portal success"
    );
    tokio::task::spawn_blocking(move || owner.wait_stopped())
        .await
        .unwrap();
    drop(gnome);
}
