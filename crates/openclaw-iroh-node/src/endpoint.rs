//! Endpoint binding and dialing.

use std::{str::FromStr, sync::Arc};

use iroh::{
    Endpoint as IrohEndpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, Watcher,
    endpoint::{RelayStatus, presets},
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::{Mutex, watch};

use crate::{conn::Connection, js_err};

/// Options for `bind`.
#[napi(object)]
pub struct BindOptions {
    /// 32 secret key bytes.
    pub secret_key: Uint8Array,
    /// The only relay in the relay map; omitted means relays disabled.
    pub relay_url: Option<String>,
    /// ALPNs this endpoint accepts (needed only to accept connections).
    pub alpns: Option<Vec<Uint8Array>>,
    /// Local UDP socket address (`host:port`); default is iroh's default.
    pub bind_addr: Option<String>,
    /// When false, no IP transports are bound: relay-only (like the browser). Default true.
    pub ip_transports: Option<bool>,
}

/// Binds an endpoint with the Minimal preset (no pkarr, no n0 DNS, no n0 relays) and our relay only.
#[napi]
pub async fn bind(opts: BindOptions) -> Result<Endpoint> {
    let key: [u8; 32] = opts
        .secret_key
        .as_ref()
        .try_into()
        .map_err(|_| js_err("secretKey must be 32 bytes"))?;
    let relay = match opts.relay_url {
        Some(u) => RelayMode::custom([RelayUrl::from_str(&u).map_err(js_err)?]),
        None => RelayMode::Disabled,
    };
    let alpns = opts
        .alpns
        .unwrap_or_default()
        .iter()
        .map(|a| a.to_vec())
        .collect();
    let mut b = IrohEndpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&key))
        .alpns(alpns)
        .relay_mode(relay);
    if opts.ip_transports == Some(false) {
        b = b.clear_ip_transports();
    }
    if let Some(addr) = opts.bind_addr {
        let sock = std::net::SocketAddr::from_str(&addr).map_err(js_err)?;
        b = b.bind_addr(sock).map_err(js_err)?;
    }
    let ep = b.bind().await.map_err(js_err)?;
    Ok(Endpoint(Arc::new(ep)))
}

/// Options for `Endpoint.connect`.
#[napi(object)]
pub struct ConnectOptions {
    /// Relay URL of the remote endpoint.
    pub relay_url: Option<String>,
    /// Known direct UDP addresses (`host:port`) of the remote endpoint.
    pub direct_addrs: Option<Vec<String>>,
}

/// Connection state of one home relay.
#[napi(object)]
#[derive(Clone)]
pub struct HomeRelayStatus {
    /// Relay URL.
    pub url: String,
    /// True while attached to the relay.
    pub connected: bool,
    /// Most recent connection error, for display only.
    pub last_error: Option<String>,
    /// Set when the relay refused this endpoint's admission; retrying will not help
    /// until the relay's access policy changes.
    pub auth_denied_reason: Option<String>,
}

fn home_relay_statuses(list: Vec<RelayStatus>) -> Vec<HomeRelayStatus> {
    list.iter()
        .map(|status| HomeRelayStatus {
            url: status.url().to_string(),
            connected: status.is_connected(),
            last_error: status.last_error().map(|error| format!("{error:#}")),
            auth_denied_reason: status.auth_denied_reason().map(ToOwned::to_owned),
        })
        .collect()
}

/// Follows home relay status changes; see `Endpoint.watchHomeRelay`.
#[napi]
pub struct HomeRelayWatcher(Mutex<watch::Receiver<Vec<HomeRelayStatus>>>);

#[napi]
impl HomeRelayWatcher {
    /// Resolves with the status: at once on the first call, then after each change.
    /// Resolves null once the endpoint is gone.
    #[napi]
    pub async fn next(&self) -> Option<Vec<HomeRelayStatus>> {
        let mut rx = self.0.lock().await;
        rx.changed().await.ok()?;
        Some(rx.borrow_and_update().clone())
    }
}

/// A bound iroh endpoint.
#[napi]
pub struct Endpoint(Arc<IrohEndpoint>);

#[napi]
impl Endpoint {
    /// This endpoint's id (lowercase hex public key).
    #[napi]
    pub fn id(&self) -> String {
        self.0.id().to_string()
    }

    /// Local UDP socket addresses (`host:port`), for dialing directly.
    #[napi]
    pub fn bound_sockets(&self) -> Vec<String> {
        self.0
            .bound_sockets()
            .iter()
            .map(|a| a.to_string())
            .collect()
    }

    /// Resolves once the endpoint is attached to its home relay.
    #[napi]
    pub async fn online(&self) {
        self.0.online().await;
    }

    /// Current status of each home relay (empty before one is selected).
    #[napi]
    pub fn home_relay_status(&self) -> Vec<HomeRelayStatus> {
        home_relay_statuses(self.0.home_relay_status().get())
    }

    /// Starts following home relay status, including a relay-side admission denial.
    #[napi]
    pub async fn watch_home_relay(&self) -> HomeRelayWatcher {
        let mut source = self.0.home_relay_status();
        let (tx, mut rx) = watch::channel(home_relay_statuses(source.get()));
        rx.mark_changed();
        tokio::spawn(async move {
            while let Ok(list) = source.updated().await {
                if tx.send(home_relay_statuses(list)).is_err() {
                    break;
                }
            }
        });
        HomeRelayWatcher(Mutex::new(rx))
    }

    /// Waits for the next incoming connection and completes its handshake.
    /// Resolves null once the endpoint is closed. A failed handshake rejects; call again.
    #[napi]
    pub async fn accept(&self) -> Result<Option<Connection>> {
        let Some(incoming) = self.0.accept().await else {
            return Ok(None);
        };
        let conn = incoming.accept().map_err(js_err)?.await.map_err(js_err)?;
        Ok(Some(Connection::new(conn)))
    }

    /// Dials `endpointId` (hex) on `alpn`, via the given relay and/or direct addresses.
    #[napi]
    pub async fn connect(
        &self,
        endpoint_id: String,
        alpn: Uint8Array,
        opts: Option<ConnectOptions>,
    ) -> Result<Connection> {
        let id = EndpointId::from_str(&endpoint_id).map_err(js_err)?;
        let mut addr = EndpointAddr::new(id);
        if let Some(o) = opts {
            if let Some(u) = o.relay_url {
                addr = addr.with_relay_url(RelayUrl::from_str(&u).map_err(js_err)?);
            }
            for a in o.direct_addrs.unwrap_or_default() {
                addr = addr.with_ip_addr(std::net::SocketAddr::from_str(&a).map_err(js_err)?);
            }
        }
        let conn = self.0.connect(addr, &alpn).await.map_err(js_err)?;
        Ok(Connection::new(conn))
    }

    /// Closes all connections and the endpoint.
    #[napi]
    pub async fn close(&self) {
        self.0.close().await;
    }
}
