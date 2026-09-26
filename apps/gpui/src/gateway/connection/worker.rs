use std::{
    future::pending,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_channel::Sender;
use openclaw_gateway_client::{
    ClientError, ConnectErrorDetails, GatewayClient, GatewaySession, reconnect_backoff,
};
use tokio::{
    sync::watch,
    time::{Instant, sleep},
};

use super::access_connection::{connect_params, redact, redacted_error};
use super::{
    AccessChange, Authority, Command, ConnectionEvent, Lifetime, access_changed, access_changes,
    access_connection,
};
use crate::gateway::{
    access::{self, AccessClient, Application, Session},
    config::{ConnectionConfig, normalize_url},
    identity::{Identity, random_id},
    profiles::{GatewayKind, GatewayProfile},
    remote_tunnel::SshTunnel,
};

pub(super) async fn run(
    mut config: ConnectionConfig,
    profile: Option<GatewayProfile>,
    events: Sender<ConnectionEvent>,
    mut cancelled: watch::Receiver<bool>,
    mut instructions: watch::Receiver<Command>,
    lifetime: Arc<Mutex<Lifetime>>,
) {
    let setup = async {
        config.url = normalize_url(
            &profile
                .as_ref()
                .map(GatewayProfile::canonical_url)
                .unwrap_or_else(|| config.url.clone()),
        )?;
        load_identity().await
    }
    .await;
    let identity = match setup {
        Ok(identity) => identity,
        Err(message) => {
            let _ = events
                .send(ConnectionEvent::Disconnected {
                    message,
                    paused: true,
                    retry_after: None,
                })
                .await;
            return;
        }
    };
    let mut worker = Worker {
        token_key: profile
            .as_ref()
            .map(GatewayProfile::device_token_key)
            .unwrap_or_else(|| config.url.clone()),
        instance_id: random_id(),
        profile,
        config,
        identity,
        events,
        access: None,
        checked: false,
        remembered: false,
        reauthorization_required: false,
        active: None,
        tunnel: None,
        tunnel_startup: None,
    };
    let mut access_updates = access_changes().subscribe();
    let lifetime_events = worker.events.clone();
    let access_origin = access::origin(&worker.config.url).ok();
    let instance_id = worker.instance_id.clone();
    let mut paused = false;
    let mut sign_in = false;
    loop {
        let revision = lifetime
            .lock()
            .map(|state| state.revision)
            .unwrap_or_default();
        let authority = Authority {
            lifetime: lifetime.clone(),
            revision,
        };
        if !authority.current() || *cancelled.borrow() {
            worker.close().await;
            return;
        }
        tokio::select! {
            biased;
            _ = cancelled.changed() => { worker.close().await; return; }
            _ = lifetime_events.closed() => { worker.close().await; return; }
            _ = access_changed(&mut access_updates, access_origin.as_deref(), &instance_id) => {
                let revision = match lifetime.lock() {
                    Ok(mut state) => { state.revision = state.revision.wrapping_add(1); state.revision }
                    Err(_) => return,
                };
                let authority = Authority { lifetime: lifetime.clone(), revision };
                worker.close().await;
                worker.checked = false;
                worker.access = None;
                worker.reauthorization_required = false;
                worker.emit(&authority, ConnectionEvent::AccessRequired { message: None }).await;
                sign_in = false;
                paused = false;
            }
            changed = instructions.changed() => {
                worker.close().await;
                if changed.is_err() { return; }
                let command = *instructions.borrow_and_update();
                let revision = lifetime.lock().map(|state| state.revision).unwrap_or_default();
                let authority = Authority { lifetime: lifetime.clone(), revision };
                match command {
                    Command::SignIn => { sign_in = true; paused = false; }
                    Command::SignOut => {
                        sign_in = false;
                        paused = true;
                        if let Err(message) = worker.sign_out(&authority).await {
                            worker.emit(&authority, ConnectionEvent::Disconnected { message, paused: true, retry_after: None }).await;
                        }
                    }
                    Command::Idle => {}
                }
            }
            result = async { if paused { pending().await } else { worker.work(&authority, sign_in).await } } => {
                worker.close().await;
                sign_in = false;
                paused = true;
                if let Err(message) = result {
                    worker.emit(&authority, ConnectionEvent::Disconnected { message, paused: true, retry_after: None }).await;
                }
            }
        }
    }
}

struct AccessConnection {
    client: AccessClient,
    application: Application,
}

struct Worker {
    config: ConnectionConfig,
    profile: Option<GatewayProfile>,
    token_key: String,
    instance_id: String,
    identity: Identity,
    events: Sender<ConnectionEvent>,
    access: Option<AccessConnection>,
    checked: bool,
    remembered: bool,
    reauthorization_required: bool,
    active: Option<GatewaySession>,
    tunnel: Option<SshTunnel>,
    tunnel_startup: Option<TunnelStartup>,
}

struct TunnelStartup {
    canceled: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<Result<SshTunnel, String>>,
}

impl Drop for TunnelStartup {
    fn drop(&mut self) {
        self.canceled.store(true, Ordering::Release);
    }
}

impl Worker {
    async fn emit(&self, authority: &Authority, event: ConnectionEvent) -> bool {
        authority.current() && self.events.send(event).await.is_ok()
    }

    async fn close(&mut self) {
        if let Some(session) = self.active.take() {
            session.close().await;
        }
        self.tunnel.take();
        if let Some(mut startup) = self.tunnel_startup.take() {
            startup.canceled.store(true, Ordering::Release);
            // A blocking spawn cannot be aborted. Await its teardown before
            // acknowledging window/app shutdown, including a readiness race.
            let _ = (&mut startup.task).await;
        }
    }

    fn publish_access_change(&self, origin: String) {
        let _ = access_changes().send(AccessChange {
            origin,
            instance_id: self.instance_id.clone(),
        });
    }

    async fn transport_url(&mut self, authority: &Authority) -> Result<String, String> {
        let Some(GatewayProfile {
            kind:
                GatewayKind::Ssh {
                    target,
                    remote_port,
                    identity_file,
                },
            ..
        }) = &self.profile
        else {
            return Ok(self.config.url.clone());
        };
        if let Some(tunnel) = &mut self.tunnel
            && tunnel.is_running()?
        {
            return Ok(tunnel.url().to_owned());
        }
        self.tunnel.take();
        let (target, remote_port, identity_file) =
            (target.clone(), *remote_port, identity_file.clone());
        let authority = authority.clone();
        let canceled = Arc::new(AtomicBool::new(false));
        let startup_canceled = canceled.clone();
        let task = tokio::task::spawn_blocking(move || {
            SshTunnel::start(
                &target,
                remote_port,
                identity_file.as_deref().map(Path::new),
                || startup_canceled.load(Ordering::Acquire) || !authority.current(),
            )
        });
        self.tunnel_startup = Some(TunnelStartup { canceled, task });
        let result = (&mut self
            .tunnel_startup
            .as_mut()
            .expect("startup installed")
            .task)
            .await;
        self.tunnel_startup.take();
        let tunnel = result.map_err(|_| "Could not start the SSH tunnel")??;
        let url = tunnel.url().to_owned();
        self.tunnel = Some(tunnel);
        Ok(url)
    }

    async fn save(
        &mut self,
        authority: &Authority,
        change: impl FnOnce(&mut Identity, Option<&GatewayProfile>) -> Result<(), String>
        + Send
        + 'static,
    ) -> Result<(), String> {
        let mut identity = self.identity.clone();
        let profile = self.profile.clone();
        let authority = authority.clone();
        self.identity = tokio::task::spawn_blocking(move || {
            authority.write(|| {
                change(&mut identity, profile.as_ref())?;
                Ok(identity)
            })
        })
        .await
        .map_err(|_| "Could not save Gateway state".to_owned())??;
        Ok(())
    }

    async fn discover(&mut self, authority: &Authority) -> Result<(), String> {
        if self.checked {
            return Ok(());
        }
        self.emit(authority, ConnectionEvent::Checking).await;
        if self.config.url.starts_with("wss://") {
            let origin = access::origin(&self.config.url)?;
            let client = AccessClient::new()?;
            if let Some(session) = self.identity.access_session(&origin)
                && (session.application.origin != origin || !session.is_valid(access::now()))
            {
                let key = origin.clone();
                let token = session.token.clone();
                self.save(authority, move |identity, profile| {
                    identity.clear_access_session_if_for_profile(profile, &key, &token)
                })
                .await?;
                self.reauthorization_required = true;
            }
            let application = match self.identity.access_session(&origin).filter(|session| {
                session.application.origin == origin && session.is_valid(access::now())
            }) {
                Some(session) => Some(session.application.clone()),
                None => client.discover(&self.config.url).await?,
            };
            self.access = application.map(|application| AccessConnection {
                client,
                application,
            });
        }
        self.checked = true;
        Ok(())
    }

    async fn sign_out(&mut self, authority: &Authority) -> Result<(), String> {
        if let Ok(origin) = access::origin(&self.config.url) {
            let changed_origin = origin.clone();
            self.save(authority, move |identity, profile| {
                identity.set_access_session_for_profile(profile, &origin, None)
            })
            .await?;
            self.publish_access_change(changed_origin);
        }
        if self.access.is_some() {
            self.emit(
                authority,
                ConnectionEvent::AccessRequired {
                    message: Some("Signed out. Sign in with your browser to reconnect.".into()),
                },
            )
            .await;
        } else {
            self.emit(
                authority,
                ConnectionEvent::Disconnected {
                    message: "Signed out. Choose a Gateway to reconnect.".into(),
                    paused: true,
                    retry_after: None,
                },
            )
            .await;
        }
        Ok(())
    }

    async fn require_access(
        &mut self,
        authority: &Authority,
        rejected: &Session,
    ) -> Result<bool, String> {
        let origin = access::origin(&self.config.url)?;
        let key = origin.clone();
        let token = rejected.token.clone();
        self.save(authority, move |identity, profile| {
            identity.clear_access_session_if_for_profile(profile, &key, &token)
        })
        .await?;
        let current = self.identity.access_session(&origin);
        if current.is_some_and(|session| {
            session.application.origin == origin && session.is_valid(access::now())
        }) {
            return Ok(false);
        }
        self.publish_access_change(origin);
        self.emit(
            authority,
            ConnectionEvent::AccessRequired {
                message: Some(
                    "Cloudflare Access authorization expired or was rejected. Sign in again."
                        .into(),
                ),
            },
        )
        .await;
        Ok(true)
    }

    async fn work(&mut self, authority: &Authority, sign_in: bool) -> Result<(), String> {
        if !self.remembered && self.profile.is_none() {
            let url = self.config.url.clone();
            self.save(authority, move |identity, _| {
                identity.remember_gateway(&url)
            })
            .await?;
            self.remembered = true;
        }
        self.discover(authority).await?;
        if sign_in && let Some(access) = &self.access {
            let application = access.application.clone();
            let client = access.client.clone();
            let transfer = client.prepare_sign_in(&application)?;
            if !self
                .emit(
                    authority,
                    ConnectionEvent::WaitingForBrowser {
                        url: transfer.browser_url().to_owned(),
                    },
                )
                .await
            {
                return Ok(());
            }
            let session = match client.sign_in(&application, transfer).await {
                Ok(session) => session,
                Err(message) => {
                    self.emit(
                        authority,
                        ConnectionEvent::AccessRequired {
                            message: Some(message),
                        },
                    )
                    .await;
                    return Ok(());
                }
            };
            let origin = application.origin;
            let changed_origin = origin.clone();
            self.save(authority, move |identity, profile| {
                if !session.is_valid(access::now()) {
                    return Err(
                        "Browser sign-in expired before it could be saved. Sign in again.".into(),
                    );
                }
                identity.set_access_session_for_profile(profile, &origin, Some(session))
            })
            .await?;
            self.publish_access_change(changed_origin);
        }
        let config = access_connection::gateway_credentials(&self.config, self.access.is_some());
        let mut attempt = 0_u32;
        loop {
            self.identity = load_identity().await?;
            if let Some(profile) = &self.profile
                && !self
                    .identity
                    .profiles
                    .iter()
                    .any(|saved| saved.id == profile.id && saved.kind == profile.kind)
            {
                return Err("This Gateway profile was removed or changed. Open it again from the Gateways menu.".into());
            }
            if !authority.current() {
                return Ok(());
            }
            let access_session = self
                .access
                .as_ref()
                .and_then(|access| self.identity.access_session(&access.application.origin))
                .cloned();
            if self.access.is_some() {
                match &access_session {
                    Some(session)
                        if access::origin(&self.config.url)
                            .is_ok_and(|origin| origin == session.application.origin)
                            && session.is_valid(access::now()) =>
                    {
                        self.emit(authority, ConnectionEvent::AccessIdentity(session.clone()))
                            .await;
                    }
                    Some(session) => {
                        if self.require_access(authority, session).await? {
                            return Ok(());
                        }
                        continue;
                    }
                    None => {
                        self.emit(
                            authority,
                            ConnectionEvent::AccessRequired {
                                message: self.reauthorization_required.then(|| {
                                    "Cloudflare Access authorization expired. Sign in again.".into()
                                }),
                            },
                        )
                        .await;
                        return Ok(());
                    }
                }
            }
            self.emit(authority, ConnectionEvent::Connecting).await;
            let transport_url = match self.transport_url(authority).await {
                Ok(url) => url,
                Err(message) => {
                    self.retry(authority, &mut attempt, message).await;
                    continue;
                }
            };
            let transport = access_connection::transport(&transport_url, access_session.as_ref())?;
            let connected = GatewayClient::connect(transport, |challenge| {
                let params = connect_params(
                    &config,
                    &self.identity,
                    &self.token_key,
                    &self.instance_id,
                    &challenge.nonce,
                    challenge.issued_at_ms,
                );
                async move { params }
            })
            .await;
            let message = match connected {
                Ok(session) => {
                    self.active = Some(session.clone());
                    if !authority.current() {
                        return Ok(());
                    }
                    if let Some(token) = session.hello()["auth"]["deviceToken"]
                        .as_str()
                        .filter(|token| !token.is_empty())
                        && self.identity.device_token(&self.token_key) != Some(token)
                    {
                        let token = token.to_owned();
                        let url = self.token_key.clone();
                        self.save(authority, move |identity, profile| {
                            identity.set_device_token_for_profile(profile, &url, Some(&token))
                        })
                        .await?;
                    }
                    if !self
                        .emit(
                            authority,
                            ConnectionEvent::Connected {
                                session: session.clone(),
                                config: config.clone(),
                                transport_url,
                                instance_id: self.instance_id.clone(),
                            },
                        )
                        .await
                    {
                        return Ok(());
                    }
                    attempt = 0;
                    let reason = self
                        .connected(authority, &session, access_session.as_ref())
                        .await;
                    self.close().await;
                    match reason {
                        Some(message) => message,
                        None => {
                            if let Some(session) = &access_session
                                && self.require_access(authority, session).await?
                            {
                                return Ok(());
                            }
                            continue;
                        }
                    }
                }
                Err(error) => {
                    if let (Some(access), Some(session)) = (&self.access, &access_session) {
                        // The shared crate erases upgrade response headers. Re-probe
                        // with the same grant before treating transport loss as logout.
                        let rejected = access_connection::identity_proxy_rejection(&error)
                            || matches!(error, ClientError::Transport(_))
                                && access
                                    .client
                                    .session_rejected(&config.url, session)
                                    .await
                                    .unwrap_or(false);
                        if rejected {
                            if self.require_access(authority, session).await? {
                                return Ok(());
                            }
                            continue;
                        }
                    }
                    let details = match &error {
                        ClientError::Gateway { details, .. } => {
                            ConnectErrorDetails::from_value(details.as_ref())
                        }
                        _ => ConnectErrorDetails::default(),
                    };
                    let mut message =
                        redacted_error(&error, &self.config, &self.identity, &self.token_key);
                    if let Some(hint) = details.remediation_hint() {
                        message.push('\n');
                        message.push_str(&redact(
                            hint.to_owned(),
                            &self.config,
                            &self.identity,
                            &self.token_key,
                        ));
                    }
                    if details.invalidates_device_token() {
                        let url = self.token_key.clone();
                        self.save(authority, move |identity, profile| {
                            identity.set_device_token_for_profile(profile, &url, None)
                        })
                        .await?;
                    }
                    if details.should_pause_reconnect()
                        || details.code() == Some("PAIRING_REQUIRED")
                    {
                        self.emit(
                            authority,
                            ConnectionEvent::Disconnected {
                                message,
                                paused: true,
                                retry_after: None,
                            },
                        )
                        .await;
                        return Ok(());
                    }
                    message
                }
            };
            self.close().await;
            self.retry(authority, &mut attempt, message).await;
        }
    }

    async fn retry(&self, authority: &Authority, attempt: &mut u32, message: String) {
        *attempt = attempt.saturating_add(1);
        let retry_after = reconnect_backoff(*attempt, Duration::from_secs(30));
        self.emit(
            authority,
            ConnectionEvent::Disconnected {
                message: redact(message, &self.config, &self.identity, &self.token_key),
                paused: false,
                retry_after: Some(retry_after),
            },
        )
        .await;
        sleep(retry_after).await;
    }

    async fn connected(
        &self,
        authority: &Authority,
        session: &GatewaySession,
        access_session: Option<&Session>,
    ) -> Option<String> {
        let mut activity = session.subscribe_transport_activity();
        let watchdog = Duration::from_millis(
            session.hello()["policy"]["tickIntervalMs"]
                .as_u64()
                .filter(|interval| *interval > 0)
                .unwrap_or(30_000)
                .saturating_mul(2),
        );
        let timeout = sleep(watchdog);
        tokio::pin!(timeout);
        let expiry = async {
            if let Some(access) = access_session {
                while access.is_valid(access::now()) {
                    let remaining = (access.expires_at - access::now()).clamp(0.0, 86_400.0);
                    sleep(Duration::from_secs_f64(remaining)).await;
                }
            } else {
                pending::<()>().await
            }
        };
        tokio::pin!(expiry);
        loop {
            tokio::select! {
                biased;
                _ = &mut expiry => return None,
                changed = activity.changed() => {
                    if changed.is_err() { return Some("Gateway connection closed".into()) }
                    timeout.as_mut().reset(Instant::now() + watchdog);
                }
                event = session.next_event() => match event {
                    Ok(event) => { if !self.emit(authority, ConnectionEvent::Event(event)).await { return Some("Connection was canceled".into()) } }
                    Err(error) => return Some(redacted_error(&error, &self.config, &self.identity, &self.token_key)),
                },
                _ = &mut timeout => return Some("Gateway stopped responding; reconnecting".into()),
            }
        }
    }
}

async fn load_identity() -> Result<Identity, String> {
    tokio::task::spawn_blocking(Identity::load)
        .await
        .map_err(|_| "Could not load the device identity".to_owned())?
}
