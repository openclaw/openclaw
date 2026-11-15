use std::{net::SocketAddr, str::FromStr, sync::Arc, time::Duration};

use crate::{CancelToken, Connection, IrohError, cancelled, invalid, transport};
use iroh::{
    EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, Watcher,
    endpoint::{QuicTransportConfig, RelayStatus, presets},
};
use tokio::sync::{Mutex, watch};
use zeroize::{Zeroize, Zeroizing};

// Erase the owned FFI input even on validation failure, before any network await.
fn take_key(bytes: &mut [u8]) -> Result<SecretKey, IrohError> {
    let result = <&[u8; 32]>::try_from(&*bytes)
        .map(SecretKey::from_bytes)
        .map_err(|_| invalid("secretKey must be 32 bytes"));
    bytes.zeroize();
    result
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn bind(
    secret_key: Vec<u8>,
    relay_url: Option<String>,
    alpns: Vec<Vec<u8>>,
    ip_transports: bool,
    keep_alive_ms: u32,
) -> Result<Arc<Endpoint>, IrohError> {
    let mut secret_key = Zeroizing::new(secret_key);
    let key = take_key(&mut secret_key)?;
    #[cfg(target_os = "android")]
    crate::android::require_context()?;
    if keep_alive_ms == 0 {
        return Err(invalid("keepAliveMs must be positive"));
    }
    if alpns.iter().any(|a| a.is_empty() || a.len() > 255) {
        return Err(invalid("ALPN must contain 1..255 bytes"));
    }
    let relay = match relay_url {
        Some(url) => RelayMode::custom([parse_relay(&url)?]),
        None => RelayMode::Disabled,
    };
    let mut builder = iroh::Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(alpns)
        .relay_mode(relay)
        .transport_config(
            QuicTransportConfig::builder()
                .max_concurrent_bidi_streams(iroh::endpoint::VarInt::from_u32(64))
                .max_concurrent_uni_streams(iroh::endpoint::VarInt::from_u32(0))
                .keep_alive_interval(Duration::from_millis(u64::from(keep_alive_ms)))
                .build(),
        );
    if !ip_transports {
        builder = builder.clear_ip_transports();
    }
    // Never expose arbitrary dependency error text at the credential boundary.
    let inner = builder
        .bind()
        .await
        .map_err(|_| transport("endpoint bind failed"))?;
    Ok(Arc::new(Endpoint {
        inner,
        shutdown: watch::Sender::new(false),
        done: watch::Sender::new(false),
        runtime: tokio::runtime::Handle::current(),
    }))
}

fn parse_relay(url: &str) -> Result<RelayUrl, IrohError> {
    RelayUrl::from_str(url).map_err(|_| invalid("invalid relay URL"))
}

#[derive(uniffi::Object)]
pub struct Endpoint {
    inner: iroh::Endpoint,
    shutdown: watch::Sender<bool>,
    done: watch::Sender<bool>,
    runtime: tokio::runtime::Handle,
}

impl Endpoint {
    // Detached cleanup survives cancellation of the foreign shutdown future or final ARC/GC drop.
    fn start_shutdown(&self) {
        if !self.shutdown.send_replace(true) {
            let inner = self.inner.clone();
            let done = self.done.clone();
            self.runtime.spawn(async move {
                inner.close().await;
                done.send_replace(true);
            });
        }
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.start_shutdown();
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl Endpoint {
    pub fn id(&self) -> String {
        self.inner.id().to_string()
    }
    pub fn bound_sockets(&self) -> Vec<String> {
        self.inner
            .bound_sockets()
            .iter()
            .map(ToString::to_string)
            .collect()
    }
    /// Dials a verified endpoint. Cancelling `cancel` aborts only this dial.
    #[uniffi::method(default(cancel = None))]
    pub async fn connect(
        &self,
        endpoint_id: String,
        alpn: Vec<u8>,
        relay_url: Option<String>,
        direct_addrs: Vec<String>,
        cancel: Option<Arc<CancelToken>>,
    ) -> Result<Arc<Connection>, IrohError> {
        let id = EndpointId::from_str(&endpoint_id).map_err(|_| invalid("invalid endpoint ID"))?;
        if alpn.is_empty() || alpn.len() > 255 {
            return Err(invalid("ALPN must contain 1..255 bytes"));
        }
        let mut addr = EndpointAddr::new(id);
        if let Some(url) = relay_url {
            addr = addr.with_relay_url(parse_relay(&url)?);
        }
        for value in direct_addrs {
            addr = addr.with_ip_addr(
                SocketAddr::from_str(&value).map_err(|_| invalid("invalid direct address"))?,
            );
        }
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.subscribe()) => Err(IrohError::EndpointClosed),
            () = CancelToken::wait(cancel.as_ref()) => Err(IrohError::Cancelled),
            result = self.inner.connect(addr, &alpn) => {
                let inner = result.map_err(|_| transport("connection failed"))?;
                Ok(Connection::new(inner, self.shutdown.subscribe()))
            }
        }
    }
    pub async fn accept(&self) -> Result<Option<Arc<Connection>>, IrohError> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.subscribe()) => Ok(None),
            result = async {
                let Some(incoming) = self.inner.accept().await else { return Ok(None); };
                let inner = incoming.accept().map_err(|_| transport("incoming handshake failed"))?
                    .await.map_err(|_| transport("incoming handshake failed"))?;
                Ok(Some(Connection::new(inner, self.shutdown.subscribe())))
            } => result,
        }
    }
    pub async fn watch_home_relay(&self) -> Arc<HomeRelayWatcher> {
        let mut source = self.inner.home_relay_status();
        let (tx, mut rx) = watch::channel(statuses(source.get()));
        rx.mark_changed();
        let shutdown = self.shutdown.subscribe();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                () = cancelled(shutdown) => {},
                () = tx.closed() => {},
                () = async {
                    while let Ok(list) = source.updated().await {
                        if tx.send(statuses(list)).is_err() { break; }
                    }
                } => {},
            }
        });
        Arc::new(HomeRelayWatcher {
            rx: Mutex::new(rx),
            shutdown: self.shutdown.subscribe(),
        })
    }
    pub async fn shutdown(&self) {
        self.start_shutdown();
        cancelled(self.done.subscribe()).await;
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct HomeRelayStatus {
    pub url: String,
    pub connected: bool,
    pub last_error: Option<String>,
    pub auth_denied_reason: Option<String>,
}
fn statuses(list: Vec<RelayStatus>) -> Vec<HomeRelayStatus> {
    list.iter()
        .map(|s| HomeRelayStatus {
            url: s.url().to_string(),
            connected: s.is_connected(),
            last_error: s.last_error().map(|_| "relay connection failed".into()),
            auth_denied_reason: s.auth_denied_reason().map(ToOwned::to_owned),
        })
        .collect()
}
#[derive(uniffi::Object)]
pub struct HomeRelayWatcher {
    rx: Mutex<watch::Receiver<Vec<HomeRelayStatus>>>,
    shutdown: watch::Receiver<bool>,
}
#[uniffi::export(async_runtime = "tokio")]
impl HomeRelayWatcher {
    pub async fn next(&self) -> Option<Vec<HomeRelayStatus>> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => None,
            result = async {
                let mut rx = self.rx.lock().await;
                rx.changed().await.ok()?;
                let value = rx.borrow_and_update().clone();
                Some(value)
            } => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_seed_erased_on_success_and_failure() {
        let mut valid = [42; 32];
        assert!(take_key(&mut valid).is_ok());
        assert_eq!(valid, [0; 32]);
        let mut invalid = [42; 31];
        assert!(take_key(&mut invalid).is_err());
        assert_eq!(invalid, [0; 31]);
    }
}
