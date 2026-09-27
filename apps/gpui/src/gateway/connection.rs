use std::{
    future::pending,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

use async_channel::Receiver;
use openclaw_gateway_client::{Event, GatewaySession};
use tokio::{
    runtime::Handle,
    sync::{broadcast, watch},
};

use super::{access::Session, config::ConnectionConfig, profiles::GatewayProfile};

#[path = "connection_access.rs"]
mod access_connection;
mod worker;

pub enum ConnectionEvent {
    Checking,
    AccessRequired {
        message: Option<String>,
    },
    WaitingForBrowser {
        url: String,
    },
    AccessIdentity(Session),
    Connecting,
    Connected {
        session: GatewaySession,
        config: ConnectionConfig,
        transport_url: String,
        instance_id: String,
    },
    Disconnected {
        message: String,
        paused: bool,
        retry_after: Option<Duration>,
    },
    Event(Event),
}

#[derive(Clone, Debug)]
struct AccessChange {
    origin: String,
    instance_id: String,
}

fn access_changes() -> &'static broadcast::Sender<AccessChange> {
    static CHANGES: OnceLock<broadcast::Sender<AccessChange>> = OnceLock::new();
    CHANGES.get_or_init(|| broadcast::channel(64).0)
}

async fn access_changed(
    updates: &mut broadcast::Receiver<AccessChange>,
    origin: Option<&str>,
    instance_id: &str,
) {
    loop {
        match updates.recv().await {
            Ok(change)
                if Some(change.origin.as_str()) == origin && change.instance_id != instance_id =>
            {
                return;
            }
            Err(broadcast::error::RecvError::Lagged(_)) if origin.is_some() => return,
            Err(broadcast::error::RecvError::Closed) => pending::<()>().await,
            _ => {}
        }
    }
}

#[derive(Clone, Copy)]
enum Command {
    Idle,
    SignIn,
    SignOut,
}

#[derive(Default)]
struct Lifetime {
    retired: bool,
    revision: u64,
}

struct Shutdown {
    lifetime: Weak<Mutex<Lifetime>>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

fn actors() -> &'static Mutex<Vec<Shutdown>> {
    static ACTORS: OnceLock<Mutex<Vec<Shutdown>>> = OnceLock::new();
    ACTORS.get_or_init(|| Mutex::new(Vec::new()))
}

/// The native quit callback waits here before Cocoa terminates the process.
pub async fn shutdown_all() {
    super::remote_tunnel::shutdown_all();
    let active = actors()
        .lock()
        .map(|mut actors| std::mem::take(&mut *actors))
        .unwrap_or_default();
    for actor in &active {
        if let Some(lifetime) = actor.lifetime.upgrade()
            && let Ok(mut state) = lifetime.lock()
        {
            state.retired = true;
        }
        let _ = actor.stop.send(true);
    }
    for mut actor in active {
        while !*actor.done.borrow() {
            if actor.done.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Clone)]
struct Authority {
    lifetime: Arc<Mutex<Lifetime>>,
    revision: u64,
}

impl Authority {
    fn current(&self) -> bool {
        self.lifetime
            .lock()
            .is_ok_and(|state| !state.retired && state.revision == self.revision)
    }

    fn write<T>(&self, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let state = self
            .lifetime
            .lock()
            .map_err(|_| "Connection state lock failed")?;
        if state.retired || state.revision != self.revision {
            return Err("Connection was canceled".into());
        }
        // Cancellation and persistence share this boundary, including filesystem
        // commit. A late browser result cannot revive a signed-out connection.
        operation()
    }
}

/// Dropping the UI-owned handle retires authorization and closes its socket.
pub struct Connection {
    stop: watch::Sender<bool>,
    commands: watch::Sender<Command>,
    lifetime: Arc<Mutex<Lifetime>>,
}

impl Connection {
    pub fn sign_in(&self) {
        self.command(Command::SignIn);
    }
    pub fn sign_out(&self) {
        self.command(Command::SignOut);
    }

    fn command(&self, command: Command) {
        if let Ok(mut state) = self.lifetime.lock() {
            state.revision = state.revision.wrapping_add(1);
            self.commands.send_replace(command);
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(mut state) = self.lifetime.lock() {
            state.retired = true;
        }
        let _ = self.stop.send(true);
    }
}

pub fn connect(
    handle: &Handle,
    config: ConnectionConfig,
    profile: Option<GatewayProfile>,
) -> (Connection, Receiver<ConnectionEvent>) {
    let (events, receiver) = async_channel::bounded(256);
    let (stop, cancelled) = watch::channel(false);
    let (commands, instructions) = watch::channel(Command::Idle);
    let (finished, done) = watch::channel(false);
    let lifetime = Arc::new(Mutex::new(Lifetime::default()));
    if let Ok(mut actors) = actors().lock() {
        actors.retain(|actor| !*actor.done.borrow());
        actors.push(Shutdown {
            lifetime: Arc::downgrade(&lifetime),
            stop: stop.clone(),
            done,
        });
    }
    let actor_lifetime = lifetime.clone();
    handle.spawn(async move {
        worker::run(
            config,
            profile,
            events,
            cancelled,
            instructions,
            actor_lifetime,
        )
        .await;
        let _ = finished.send(true);
    });
    (
        Connection {
            stop,
            commands,
            lifetime,
        },
        receiver,
    )
}
