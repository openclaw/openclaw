use crate::connection::handle_connection;
use crate::session_registry::SessionRegistry;
use openclaw_config::GatewayConfig;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tracing::{info, warn};

/// Server-pushed event shared with every connection.
#[derive(Debug, Clone)]
pub enum GatewayEvent {
    Tick { ts: u64 },
    Shutdown { reason: String },
}

/// The Gateway server. Owns the listener, session registry, and shared state.
pub struct Gateway {
    config: GatewayConfig,
    registry: Arc<SessionRegistry>,
    dispatcher: Arc<crate::dispatch::Dispatcher>,
}

/// A handle to a running Gateway, used for graceful shutdown.
pub struct GatewayHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    events: broadcast::Sender<GatewayEvent>,
}

impl GatewayHandle {
    /// Signal the Gateway to shut down.
    ///
    /// A `shutdown` event is published first so connected clients can retire
    /// pending requests instead of hanging on a closed socket.
    pub fn shutdown(&self) {
        let _ = self.events.send(GatewayEvent::Shutdown {
            reason: "gateway stopping".to_owned(),
        });
        let _ = self.shutdown.send(true);
    }
}

impl Gateway {
    /// Create a new Gateway with the given configuration.
    #[must_use]
    pub fn new(config: GatewayConfig) -> Self {
        let registry = Arc::new(SessionRegistry::new());
        let dispatcher = Arc::new(crate::dispatch::Dispatcher::new(Arc::clone(&registry)));
        Self {
            config,
            registry,
            dispatcher,
        }
    }

    /// Attach a durable transcript reader so `sessions.get` serves stored messages.
    #[must_use]
    pub fn with_transcripts(
        mut self,
        reader: Arc<dyn crate::dispatch::TranscriptReader>,
    ) -> Self {
        self.dispatcher = Arc::new(
            crate::dispatch::Dispatcher::new(Arc::clone(&self.registry))
                .with_transcripts(reader),
        );
        self
    }

    /// Access the session registry.
    #[must_use]
    pub fn registry(&self) -> &Arc<SessionRegistry> {
        &self.registry
    }

    /// Run the Gateway until shutdown is signalled.
    pub async fn run(self) -> std::io::Result<GatewayHandle> {
        let auth = self.config.resolved_auth().map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, error)
        })?;
        let addr: SocketAddr = self
            .config
            .listen
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;

        let listener = TcpListener::bind(addr).await?;
        let local = listener.local_addr()?;
        info!(listen = %local, "gateway listening");

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        // Bounded channel: a slow client must not grow server memory without limit.
        let (events_tx, _) = broadcast::channel::<GatewayEvent>(256);
        let registry = Arc::clone(&self.registry);
        let max_connections = self.config.max_connections;
        let max_frame_bytes = self.config.max_frame_bytes;
        let tick_interval_secs = self.config.ping_interval_secs.max(1);
        let dispatcher = Arc::clone(&self.dispatcher);

        // Tick producer: clients use this as an inbound-silence watchdog budget.
        {
            let events = events_tx.clone();
            let mut tick_shutdown = shutdown_rx.clone();
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(tick_interval_secs));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let ts = chrono::Utc::now().timestamp_millis().max(0) as u64;
                            let _ = events.send(GatewayEvent::Tick { ts });
                        }
                        _ = tick_shutdown.changed() => break,
                    }
                }
            });
        }

        let accept_events = events_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer)) => {
                                if registry.connection_count() >= max_connections {
                                    warn!(%peer, "connection rejected: at capacity");
                                    drop(stream);
                                    continue;
                                }
                                let registry = Arc::clone(&registry);
                                let auth = auth.clone();
                                let events = accept_events.subscribe();
                                let dispatcher = Arc::clone(&dispatcher);
                                tokio::spawn(async move {
                                    if let Err(error) = handle_connection(
                                        stream, peer, registry, auth, max_frame_bytes, events,
                                        dispatcher,
                                    ).await {
                                        warn!(%peer, %error, "connection error");
                                    }
                                });
                            }
                            Err(error) => {
                                warn!(%error, "accept failed");
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            }
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        info!("gateway shutting down");
                        break;
                    }
                }
            }
        });

        Ok(GatewayHandle {
            shutdown: shutdown_tx,
            events: events_tx,
        })
    }
}
