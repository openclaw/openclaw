//! A dedicated portal connection owns the shortcut and any outstanding consent UI.
use futures_util::{future::BoxFuture, FutureExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};
use zbus::{
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    Connection, MatchRule, Message, MessageStream, Proxy,
};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const SHORTCUT_ID: &str = "quickchat";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);
type Properties = HashMap<String, OwnedValue>;
type Shortcuts = Vec<(String, Properties)>;

#[derive(Clone, Debug, Default)]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub pending: bool,
    pub configurable: bool,
    pub trigger: String,
    pub error: Option<String>,
}

pub enum Event {
    Status(Status),
    Activated { token: Option<String>, binding: u64 },
}

/// Queued GTK callbacks must still belong to the current, live registration.
pub struct Registration {
    current: AtomicBool,
    active: AtomicBool,
    session_live: AtomicBool,
    binding: AtomicU64,
    enabled: bool,
}

impl Registration {
    fn new(enabled: bool) -> Self {
        Self {
            current: AtomicBool::new(true),
            active: AtomicBool::new(false),
            session_live: AtomicBool::new(false),
            binding: AtomicU64::new(0),
            enabled,
        }
    }

    pub fn is_current(&self) -> bool {
        self.current.load(Ordering::SeqCst)
    }

    pub fn is_active(&self) -> bool {
        self.is_current() && self.active.load(Ordering::SeqCst)
    }

    pub fn can_activate(&self, binding: u64) -> bool {
        self.is_active() && self.binding.load(Ordering::SeqCst) == binding
    }

    fn is_live(&self) -> bool {
        self.is_current() && self.session_live.load(Ordering::SeqCst)
    }

    fn update_binding(&self, enabled: bool) {
        self.binding.fetch_add(1, Ordering::SeqCst);
        self.active.store(enabled, Ordering::SeqCst);
    }
}

struct Configure {
    registration: Arc<Registration>,
    reply: oneshot::Sender<Result<(), String>>,
}

pub struct PortalShortcut {
    intent: watch::Sender<Option<Arc<Registration>>>,
    configure: mpsc::Sender<Configure>,
}

impl PortalShortcut {
    /// The caller must install an app-ID desktop entry visible to the portal.
    pub fn start(
        app_id: String,
        enabled: bool,
        publish: impl Fn(Arc<Registration>, Event) + Send + Sync + 'static,
    ) -> Self {
        let (intent, changes) = watch::channel(Some(Arc::new(Registration::new(enabled))));
        let (configure, requests) = mpsc::channel(1);
        tauri::async_runtime::spawn(run(app_id, changes, requests, publish));
        Self { intent, configure }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.intent.send_modify(|current| {
            if let Some(previous) = current.take() {
                previous.current.store(false, Ordering::SeqCst);
                *current = Some(Arc::new(Registration::new(enabled)));
            }
        });
    }

    pub fn shutdown(&self) {
        self.intent.send_modify(|current| {
            if let Some(previous) = current.take() {
                previous.current.store(false, Ordering::SeqCst);
            }
        });
    }

    pub async fn configure(&self) -> Result<(), String> {
        let registration = self
            .intent
            .borrow()
            .clone()
            .filter(|registration| registration.is_live())
            .ok_or("Enable the Quick Chat shortcut from the tray menu first.")?;
        let (reply, result) = oneshot::channel();
        self.configure
            .try_send(Configure {
                registration,
                reply,
            })
            .map_err(|_| "A shortcut configuration request is already pending.")?;
        result
            .await
            .map_err(|_| "The desktop shortcut session ended.".to_string())?
    }
}

impl Drop for PortalShortcut {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn run(
    app_id: String,
    mut changes: watch::Receiver<Option<Arc<Registration>>>,
    mut configure: mpsc::Receiver<Configure>,
    publish: impl Fn(Arc<Registration>, Event),
) {
    loop {
        let Some(registration) = changes.borrow_and_update().clone() else {
            return;
        };
        let mut status = Status {
            supported: true,
            pending: registration.enabled,
            ..Status::default()
        };
        publish(registration.clone(), Event::Status(status.clone()));
        if registration.enabled {
            let result = tokio::select! {
                biased;
                _ = changes.changed() => continue,
                result = tokio::time::timeout(CALL_TIMEOUT, Connection::session()) => result,
            };
            match result {
                Ok(Ok(connection)) => {
                    let session = session_path(&connection);
                    let result = tokio::select! {
                        biased;
                        _ = changes.changed() => None,
                        result = serve(
                            &connection, &app_id, &session, &registration,
                            &mut configure, &mut status, &publish,
                        ) => Some(result),
                    };
                    registration.active.store(false, Ordering::SeqCst);
                    registration.session_live.store(false, Ordering::SeqCst);
                    // Closing the dedicated connection also cancels requests whose
                    // method reply was lost, including an open permission dialog.
                    let _ = tokio::time::timeout(CALL_TIMEOUT, async {
                        if let Ok(proxy) = Proxy::new(
                            &connection,
                            DESTINATION,
                            session.as_str(),
                            "org.freedesktop.portal.Session",
                        )
                        .await
                        {
                            let _ = proxy.call::<_, _, ()>("Close", &()).await;
                        }
                    })
                    .await;
                    let _ = connection.close().await;
                    let Some(result) = result else {
                        continue;
                    };
                    status.enabled = false;
                    status.pending = false;
                    status.configurable = false;
                    status.error = result.err();
                }
                result => {
                    status.supported = false;
                    status.pending = false;
                    status.error = Some(match result {
                        Ok(Err(error)) => {
                            format!("Could not connect to the desktop portal: {error}")
                        }
                        Err(_) => "The desktop session did not answer.".to_string(),
                        Ok(Ok(_)) => unreachable!(),
                    });
                }
            }
            publish(registration.clone(), Event::Status(status));
        }
        loop {
            tokio::select! {
                biased;
                _ = changes.changed() => break,
                Some(request) = configure.recv() => {
                    let _ = request.reply.send(Err(
                        "Enable the Quick Chat shortcut from the tray menu first.".to_string()
                    ));
                }
            }
        }
    }
}

fn session_path(connection: &Connection) -> OwnedObjectPath {
    OwnedObjectPath::try_from(format!(
        "{PATH}/session/{}/openclaw_{}",
        sender_token(connection),
        uuid::Uuid::new_v4().simple()
    ))
    .expect("generated portal session path")
}

fn sender_token(connection: &Connection) -> String {
    connection
        .unique_name()
        .expect("a session bus connection has a unique name")
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_")
}

async fn serve(
    connection: &Connection,
    app_id: &str,
    session: &OwnedObjectPath,
    registration: &Arc<Registration>,
    configure: &mut mpsc::Receiver<Configure>,
    status: &mut Status,
    publish: &impl Fn(Arc<Registration>, Event),
) -> Result<(), String> {
    let bus = zbus::fdo::DBusProxy::new(connection)
        .await
        .map_err(error_text)?;
    let mut owners = bus
        .receive_name_owner_changed_with_args(&[(0, DESTINATION)])
        .await
        .map_err(error_text)?;
    let registry = Proxy::new(
        connection,
        DESTINATION,
        PATH,
        "org.freedesktop.host.portal.Registry",
    )
    .await
    .map_err(error_text)?;
    match registry
        .call::<_, _, ()>("Register", &(app_id, HashMap::<&str, Value<'_>>::new()))
        .await
    {
        Ok(()) => {}
        // Older portals identify host apps themselves and do not expose Registry.
        Err(zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownInterface"
                    | "org.freedesktop.DBus.Error.UnknownMethod"
            ) => {}
        Err(error) => {
            return Err(format!(
                "Could not identify OpenClaw to the desktop: {error}"
            ))
        }
    }
    let owner = bus
        .get_name_owner(DESTINATION.try_into().expect("portal bus name"))
        .await
        .map_err(error_text)?;
    let proxy = Proxy::new(connection, owner.as_str(), PATH, INTERFACE)
        .await
        .map_err(error_text)?;
    let version: u32 = match proxy.get_property("version").await {
        Ok(version) => version,
        Err(error) => {
            status.supported = false;
            return Err(format!(
                "This desktop has no GlobalShortcuts portal. Open Quick Chat from the tray menu. {error}"
            ));
        }
    };
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(owner.as_str())
        .map_err(error_text)?
        .path_namespace(PATH)
        .map_err(error_text)?
        .build();
    let mut signals = MessageStream::for_match_rule(rule, connection, Some(64))
        .await
        .map_err(error_text)?;
    let operation = async {
        let session_token = session.as_str().rsplit('/').next().expect("session token");
        let (token, request) = request_path(connection);
        let options = HashMap::from([
            ("handle_token", Value::from(token.as_str())),
            ("session_handle_token", Value::from(session_token)),
        ]);
        let mut changed = None;
        let created = request_response(
            &mut signals,
            session,
            &request,
            &mut changed,
            CALL_TIMEOUT,
            proxy.call("CreateSession", &(options,)),
        )
        .await?;
        // The portal contract deliberately represents session_handle as a string.
        if created
            .get("session_handle")
            .and_then(|value| <&str>::try_from(value).ok())
            != Some(session.as_str())
        {
            return Err("The desktop returned an unexpected shortcut session.".to_string());
        }
        let (token, request) = request_path(connection);
        let shortcuts = vec![(
            SHORTCUT_ID,
            HashMap::from([
                ("description", Value::from("Open Quick Chat")),
                ("preferred_trigger", Value::from("CTRL+SHIFT+space")),
            ]),
        )];
        let options = HashMap::from([("handle_token", Value::from(token.as_str()))]);
        let mut bound = request_response(
            &mut signals,
            session,
            &request,
            &mut changed,
            CONSENT_TIMEOUT,
            proxy.call("BindShortcuts", &(session, shortcuts, "", options)),
        )
        .await?;
        let shortcuts = match changed {
            Some(shortcuts) => shortcuts,
            None => Shortcuts::try_from(
                bound
                    .remove("shortcuts")
                    .ok_or("The desktop omitted its shortcut registration result.")?,
            )
            .map_err(error_text)?,
        };
        status.pending = false;
        status.configurable = version >= 2;
        update_binding(status, shortcuts);
        registration.session_live.store(true, Ordering::SeqCst);
        registration.update_binding(status.enabled);
        publish(registration.clone(), Event::Status(status.clone()));
        let mut configuration: BoxFuture<'_, Result<(), String>> = std::future::pending().boxed();
        let mut configuration_reply: Option<oneshot::Sender<Result<(), String>>> = None;
        loop {
            tokio::select! {
                biased;
                signal = signals.next() => {
                    let signal = signal.ok_or("The desktop portal disconnected.")?
                        .map_err(error_text)?;
                    if let Some(shortcuts) = binding_change(&signal, session)? {
                        update_binding(status, shortcuts);
                        registration.update_binding(status.enabled);
                        publish(registration.clone(), Event::Status(status.clone()));
                    } else if is_signal(&signal, PATH, INTERFACE, "Activated") {
                        let (handle, id, _, options): (OwnedObjectPath, String, u64, Properties) =
                            signal.body().deserialize().map_err(error_text)?;
                        if handle == *session && id == SHORTCUT_ID && registration.is_active() {
                            let token = options.get("activation_token")
                                .and_then(|value| <&str>::try_from(value).ok())
                                .map(str::to_string);
                            publish(registration.clone(), Event::Activated {
                                token,
                                binding: registration.binding.load(Ordering::SeqCst),
                            });
                        }
                    }
                }
                result = &mut configuration, if configuration_reply.is_some() => {
                    if let Some(reply) = configuration_reply.take() {
                        let _ = reply.send(result);
                    }
                    configuration = std::future::pending().boxed();
                }
                Some(request) = configure.recv() => {
                    let error = if !Arc::ptr_eq(&request.registration, registration)
                        || !registration.is_live() {
                        Some("The desktop shortcut session changed. Try again.")
                    } else if version < 2 {
                        Some("Change this shortcut in your desktop's keyboard settings.")
                    } else if configuration_reply.is_some() {
                        Some("A shortcut configuration request is already pending.")
                    } else {
                        None
                    };
                    if let Some(error) = error {
                        let _ = request.reply.send(Err(error.to_string()));
                        continue;
                    }
                    let proxy = proxy.clone();
                    let session = session.clone();
                    configuration_reply = Some(request.reply);
                    // Keep polling session closure and binding changes while the
                    // desktop launches settings. A settings failure is not a lost session.
                    configuration = async move {
                        tokio::time::timeout(CALL_TIMEOUT, proxy.call::<_, _, ()>(
                            "ConfigureShortcuts", &(&session, "", HashMap::<&str, Value<'_>>::new()),
                        )).await
                            .map_err(|_| "The desktop shortcut settings did not answer.".to_string())
                            .and_then(|result| result.map_err(error_text))
                    }.boxed();
                }
            }
        }
    };
    tokio::pin!(operation);
    loop {
        tokio::select! {
            biased;
            change = owners.next() => {
                let change = change.ok_or("The desktop session disconnected.")?;
                if change.args().map_err(error_text)?.new_owner().as_ref().map(|name| name.as_str())
                    != Some(owner.as_str()) {
                    return Err("The desktop portal restarted. Enable the Quick Chat shortcut again from the tray menu.".to_string());
                }
            }
            result = &mut operation => return result,
        }
    }
}

fn request_path(connection: &Connection) -> (String, OwnedObjectPath) {
    let token = format!("openclaw_{}", uuid::Uuid::new_v4().simple());
    let path = OwnedObjectPath::try_from(format!(
        "{PATH}/request/{}/{token}",
        sender_token(connection)
    ))
    .expect("generated portal request path");
    (token, path)
}

async fn request_response(
    signals: &mut MessageStream,
    session: &OwnedObjectPath,
    request: &OwnedObjectPath,
    changed: &mut Option<Shortcuts>,
    deadline: Duration,
    call: impl std::future::Future<Output = zbus::Result<OwnedObjectPath>>,
) -> Result<Properties, String> {
    tokio::pin!(call);
    let mut returned = false;
    let mut response = None;
    tokio::time::timeout(deadline, async {
        loop {
            tokio::select! {
                result = &mut call, if !returned => {
                    if result.map_err(error_text)? != *request {
                        return Err("The desktop returned an unexpected shortcut request.".to_string());
                    }
                    returned = true;
                }
                signal = signals.next() => {
                    let signal = signal.ok_or("The desktop portal disconnected.")?
                        .map_err(error_text)?;
                    if is_signal(&signal, request.as_str(), "org.freedesktop.portal.Request", "Response") {
                        let (code, result): (u32, Properties) =
                            signal.body().deserialize().map_err(error_text)?;
                        match code {
                            0 => response = Some(result),
                            1 => return Err("Shortcut permission was cancelled. Quick Chat is still available from the tray menu.".to_string()),
                            _ => return Err("The desktop could not register the shortcut. Check its keyboard settings, then try again.".to_string()),
                        }
                    } else if let Some(shortcuts) = binding_change(&signal, session)? {
                        *changed = Some(shortcuts);
                    }
                }
            }
            if returned {
                if let Some(response) = response.take() {
                    return Ok(response);
                }
            }
        }
    }).await.map_err(|_| "The desktop did not finish shortcut registration. Try again from the tray menu.".to_string())?
}

fn binding_change(
    signal: &Message,
    session: &OwnedObjectPath,
) -> Result<Option<Shortcuts>, String> {
    if is_signal(
        signal,
        session.as_str(),
        "org.freedesktop.portal.Session",
        "Closed",
    ) {
        return Err(
            "The desktop closed the shortcut session. Enable it again from the tray menu."
                .to_string(),
        );
    }
    if is_signal(signal, PATH, INTERFACE, "ShortcutsChanged") {
        let (handle, shortcuts): (OwnedObjectPath, Shortcuts) =
            signal.body().deserialize().map_err(error_text)?;
        if handle == *session {
            return Ok(Some(shortcuts));
        }
    }
    Ok(None)
}

fn update_binding(status: &mut Status, shortcuts: Shortcuts) {
    let binding = shortcuts.into_iter().find(|(id, _)| id == SHORTCUT_ID);
    status.enabled = binding.is_some();
    status.trigger = binding
        .and_then(|(_, properties)| {
            properties
                .get("trigger_description")
                .and_then(|value| <&str>::try_from(value).ok())
                .map(str::to_string)
        })
        .unwrap_or_default();
}

fn is_signal(signal: &Message, path: &str, interface: &str, member: &str) -> bool {
    let header = signal.header();
    header.path().is_some_and(|value| value.as_str() == path)
        && header
            .interface()
            .is_some_and(|value| value.as_str() == interface)
        && header
            .member()
            .is_some_and(|value| value.as_str() == member)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
