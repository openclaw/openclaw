#![cfg(target_os = "linux")]

#[path = "../src/quickchat_portal.rs"]
mod quickchat_portal;

use futures_util::StreamExt;
use quickchat_portal::{Event, PortalShortcut, Registration, Status};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
type Properties = HashMap<String, OwnedValue>;
type Shortcuts = Vec<(String, Properties)>;

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

struct Registry(mpsc::UnboundedSender<String>);

#[zbus::interface(name = "org.freedesktop.host.portal.Registry")]
impl Registry {
    fn register(
        &self,
        app_id: &str,
        _options: Properties,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) {
        assert_eq!(app_id, "ai.openclaw.linux");
        self.0
            .send(format!("register:{}", header.sender().unwrap()))
            .unwrap();
    }
}

struct Session(mpsc::UnboundedSender<String>);

#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl Session {
    fn close(&self) {
        self.0.send("close".to_string()).unwrap();
    }
}

struct Portal {
    mode: Arc<AtomicU8>,
    configuration_release: Arc<tokio::sync::Notify>,
    calls: mpsc::UnboundedSender<String>,
}

fn text(properties: &Properties, name: &str) -> String {
    <&str>::try_from(properties.get(name).unwrap())
        .unwrap()
        .to_string()
}

fn shortcuts(trigger: &str) -> Shortcuts {
    vec![(
        "quickchat".to_string(),
        HashMap::from([(
            "trigger_description".to_string(),
            Value::from(trigger).try_to_owned().unwrap(),
        )]),
    )]
}

async fn response(
    connection: &zbus::Connection,
    sender: &str,
    token: &str,
    code: u32,
    values: Properties,
) -> OwnedObjectPath {
    let path = OwnedObjectPath::try_from(format!(
        "{PATH}/request/{}/{}",
        sender.trim_start_matches(':').replace('.', "_"),
        token,
    ))
    .unwrap();
    // Emitting before the method reply exposes response-subscription races.
    connection
        .emit_signal(
            Some(sender),
            &path,
            "org.freedesktop.portal.Request",
            "Response",
            &(code, values),
        )
        .await
        .unwrap();
    path
}

#[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
impl Portal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        2
    }

    async fn create_session(
        &self,
        options: Properties,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> OwnedObjectPath {
        self.calls.send("create".to_string()).unwrap();
        let sender = header.sender().unwrap().as_str();
        let path = format!(
            "{PATH}/session/{}/{}",
            sender.trim_start_matches(':').replace('.', "_"),
            text(&options, "session_handle_token"),
        );
        connection
            .object_server()
            .at(path.as_str(), Session(self.calls.clone()))
            .await
            .unwrap();
        response(
            connection,
            sender,
            &text(&options, "handle_token"),
            0,
            HashMap::from([(
                "session_handle".to_string(),
                Value::from(path.as_str()).try_to_owned().unwrap(),
            )]),
        )
        .await
    }

    async fn bind_shortcuts(
        &self,
        session: OwnedObjectPath,
        requested: Shortcuts,
        parent: &str,
        options: Properties,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> OwnedObjectPath {
        assert_eq!(parent, "");
        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0].0, "quickchat");
        assert_eq!(
            text(&requested[0].1, "preferred_trigger"),
            "CTRL+SHIFT+space"
        );
        assert_eq!(text(&requested[0].1, "description"), "Open Quick Chat");
        self.calls.send(format!("bind:{session}")).unwrap();
        let sender = header.sender().unwrap().as_str();
        let token = text(&options, "handle_token");
        let mode = self.mode.load(Ordering::SeqCst);
        if mode == 2 {
            // A pending permission dialog returns a handle but never a Response.
            return OwnedObjectPath::try_from(format!(
                "{PATH}/request/{}/{token}",
                sender.trim_start_matches(':').replace('.', "_")
            ))
            .unwrap();
        }
        if mode == 0 {
            connection
                .emit_signal(
                    Some(sender),
                    PATH,
                    INTERFACE,
                    "ShortcutsChanged",
                    &(&session, shortcuts("Super+K")),
                )
                .await
                .unwrap();
        }
        response(
            connection,
            sender,
            &token,
            u32::from(mode == 1),
            HashMap::from([(
                "shortcuts".to_string(),
                Value::from(if mode == 3 {
                    Vec::new()
                } else {
                    shortcuts("Ctrl+Shift+Space")
                })
                .try_to_owned()
                .unwrap(),
            )]),
        )
        .await
    }

    async fn configure_shortcuts(
        &self,
        _session: OwnedObjectPath,
        parent: &str,
        _options: Properties,
    ) -> zbus::fdo::Result<()> {
        assert_eq!(parent, "");
        self.calls.send("configure".to_string()).unwrap();
        match self.mode.load(Ordering::SeqCst) {
            4 => self.configuration_release.notified().await,
            5 => return Err(zbus::fdo::Error::Failed("fixture settings failure".into())),
            _ => {}
        }
        Ok(())
    }
}

async fn next<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn status(
    events: &mut mpsc::UnboundedReceiver<(Arc<Registration>, Event)>,
) -> (Arc<Registration>, Status) {
    match next(events).await {
        (owner, Event::Status(status)) => (owner, status),
        (_, Event::Activated { .. }) => panic!("unexpected activation"),
    }
}

async fn disconnected(connection: &zbus::Connection, sender: &str) {
    let bus = zbus::fdo::DBusProxy::new(connection).await.unwrap();
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
            changes.next().await.expect("bus ownership stream ended");
        }
    })
    .await
    .expect("portal connection leaked");
}

async fn registered(calls: &mut mpsc::UnboundedReceiver<String>) -> (String, OwnedObjectPath) {
    let call = next(calls).await;
    eprintln!("portal fixture: {call}");
    let sender = call
        .strip_prefix("register:")
        .expect("identify before any portal method")
        .to_string();
    assert_eq!(next(calls).await, "create");
    let call = next(calls).await;
    eprintln!("portal fixture: {call}");
    let session = OwnedObjectPath::try_from(call.strip_prefix("bind:").unwrap()).unwrap();
    (sender, session)
}

#[tokio::test]
async fn desktop_owns_binding_and_cancelled_or_retired_sessions_cannot_activate() {
    let _bus = Bus::start();
    let (calls, mut observed) = mpsc::unbounded_channel();
    let mode = Arc::new(AtomicU8::new(0));
    let configuration_release = Arc::new(tokio::sync::Notify::new());
    let service = zbus::connection::Builder::session()
        .unwrap()
        .name(DESTINATION)
        .unwrap()
        .serve_at(PATH, Registry(calls.clone()))
        .unwrap()
        .serve_at(
            PATH,
            Portal {
                mode: mode.clone(),
                configuration_release: configuration_release.clone(),
                calls,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let (reports, mut events) = mpsc::unbounded_channel();
    let shortcut = PortalShortcut::start("ai.openclaw.linux".into(), true, move |owner, event| {
        if let Event::Status(status) = &event {
            eprintln!("shortcut status: {status:?}");
        }
        reports.send((owner, event)).unwrap();
    });
    assert!(status(&mut events).await.1.pending);
    let (sender, session) = registered(&mut observed).await;
    let (owner, active) = status(&mut events).await;
    assert!(active.enabled && active.configurable && !active.pending);
    assert_eq!(
        active.trigger, "Super+K",
        "do not overwrite ShortcutsChanged with an older Bind response"
    );
    shortcut.configure().await.unwrap();
    assert_eq!(next(&mut observed).await, "configure");
    mode.store(5, Ordering::SeqCst);
    assert!(shortcut
        .configure()
        .await
        .unwrap_err()
        .contains("fixture settings failure"));
    assert_eq!(next(&mut observed).await, "configure");
    assert!(
        owner.is_active(),
        "settings failures do not tear down the shortcut"
    );
    mode.store(0, Ordering::SeqCst);

    for (handle, id, token) in [
        (
            OwnedObjectPath::try_from("/other").unwrap(),
            "quickchat",
            "wrong-session",
        ),
        (session.clone(), "another-action", "wrong-action"),
        (session.clone(), "quickchat", "activation-from-desktop"),
    ] {
        service
            .emit_signal(
                Some(sender.as_str()),
                PATH,
                INTERFACE,
                "Activated",
                &(
                    handle,
                    id,
                    123_u64,
                    HashMap::from([("activation_token", Value::from(token))]),
                ),
            )
            .await
            .unwrap();
    }
    let (activation_owner, activation) = next(&mut events).await;
    let binding = match activation {
        Event::Activated { token, binding } => {
            assert_eq!(token.as_deref(), Some("activation-from-desktop"));
            binding
        }
        Event::Status(_) => panic!("expected activation"),
    };
    assert!(activation_owner.is_active());
    service
        .emit_signal(
            Some(sender.as_str()),
            PATH,
            INTERFACE,
            "ShortcutsChanged",
            &(&session, shortcuts("Super+J")),
        )
        .await
        .unwrap();
    assert_eq!(status(&mut events).await.1.trigger, "Super+J");
    assert!(
        !activation_owner.can_activate(binding),
        "a changed binding retires queued activations"
    );
    shortcut.set_enabled(false);
    assert!(
        !activation_owner.is_active(),
        "queued UI activation loses authority synchronously"
    );
    assert_eq!(next(&mut observed).await, "close");
    disconnected(&service, &sender).await;
    assert!(!status(&mut events).await.1.enabled);

    // Cancellation, ungranted bindings, and an outstanding human prompt are
    // distinct outcomes; none may report a working shortcut or leak its peer.
    for scenario in [1, 3, 2] {
        mode.store(scenario, Ordering::SeqCst);
        shortcut.set_enabled(true);
        let (pending_owner, pending) = status(&mut events).await;
        assert!(pending.pending);
        let (sender, _) = registered(&mut observed).await;
        if scenario != 2 {
            let (_, result) = status(&mut events).await;
            assert!(!result.enabled && !result.pending);
            assert_eq!(result.error.is_some(), scenario == 1);
            if scenario == 3 {
                shortcut.configure().await.unwrap();
                assert_eq!(next(&mut observed).await, "configure");
            }
        }
        shortcut.set_enabled(false);
        assert!(!pending_owner.is_active());
        assert_eq!(next(&mut observed).await, "close");
        disconnected(&service, &sender).await;
        assert!(!status(&mut events).await.1.enabled);
    }
    mode.store(0, Ordering::SeqCst);
    shortcut.set_enabled(true);
    assert!(status(&mut events).await.1.pending);
    let (sender, session) = registered(&mut observed).await;
    let (last_owner, _) = status(&mut events).await;
    mode.store(4, Ordering::SeqCst);
    let configuring = shortcut.configure();
    tokio::pin!(configuring);
    tokio::select! {
        result = &mut configuring => panic!("configuration should still be pending: {result:?}"),
        call = next(&mut observed) => assert_eq!(call, "configure"),
    }
    service
        .emit_signal(
            Some(sender.as_str()),
            session.as_str(),
            "org.freedesktop.portal.Session",
            "Closed",
            &(HashMap::<String, OwnedValue>::new(),),
        )
        .await
        .unwrap();
    let (_, closed) = status(&mut events).await;
    assert!(!closed.enabled && closed.error.is_some());
    assert!(!last_owner.is_active());
    assert!(
        configuring.await.is_err(),
        "session closure interrupts configuration"
    );
    configuration_release.notify_one();
    assert_eq!(next(&mut observed).await, "close");
    disconnected(&service, &sender).await;
    assert!(!owner.is_current());
    shortcut.shutdown();
}
