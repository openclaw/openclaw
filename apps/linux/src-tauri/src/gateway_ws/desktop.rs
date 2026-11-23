#[cfg(target_os = "linux")]
use super::{classify_chat_ack, ChatSendAck, GatewayGeneration, GatewayOwnership, GatewayRequest};
use super::{GatewayClient, Ordering};
#[cfg(target_os = "linux")]
use serde_json::{json, Value};

#[cfg(target_os = "linux")]
pub(crate) enum DesktopMethod {
    Agents,
    Sessions,
    Send,
    Create,
    NodePairList,
    DevicePairList,
}

#[cfg(target_os = "linux")]
impl DesktopMethod {
    pub(super) fn name(&self) -> &'static str {
        match self {
            Self::Agents => "agents.list",
            Self::Sessions => "sessions.list",
            Self::Send => "chat.send",
            Self::Create => "sessions.create",
            Self::NodePairList => "node.pair.list",
            Self::DevicePairList => "device.pair.list",
        }
    }
}

impl GatewayClient {
    #[cfg(target_os = "linux")]
    pub(crate) fn desktop_state(&self) -> (u64, bool) {
        let _config = self
            .inner
            .config
            .lock()
            .expect("gateway config mutex poisoned");
        (
            self.inner.config_generation.load(Ordering::SeqCst),
            self.is_connected(),
        )
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn set_desktop_demand(&self, active: bool) {
        self.inner.desktop_demand.store(active, Ordering::SeqCst);
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn with_desktop_route<T>(
        &self,
        generation: u64,
        action: impl FnOnce(Option<&str>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Keep route replacement fenced without holding the config read across
        // UI navigation: its callbacks read the live native bootstrap again.
        let _publication = self
            .inner
            .route_publication
            .lock()
            .map_err(|_| "Gateway route unavailable")?;
        let url = {
            let config = self
                .inner
                .config
                .lock()
                .map_err(|_| "Gateway route unavailable")?;
            if self.inner.config_generation.load(Ordering::SeqCst) != generation {
                return Err("Desktop Gateway changed; refresh before trying again.".into());
            }
            config.config.as_ref().map(|config| config.ws_url.clone())
        };
        action(url.as_deref())
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn desktop_request(
        &self,
        generation: u64,
        method: DesktopMethod,
        params: Value,
    ) -> Result<Value, String> {
        self.with_desktop_route(generation, |url| {
            url.map(|_| ())
                .ok_or_else(|| "Select a Gateway in the desktop app first.".into())
        })?;
        let is_send = matches!(method, DesktopMethod::Send);
        let value: Value = self
            .request(GatewayRequest::Desktop {
                generation,
                method,
                params,
            })
            .await?;
        self.with_desktop_route(generation, |_| Ok(()))?;
        if is_send {
            let ack: ChatSendAck = serde_json::from_value(value.clone())
                .map_err(|error| format!("Invalid chat.send response: {error}"))?;
            classify_chat_ack(&ack)?;
        }
        Ok(value)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn local_watchdog_generation(&self) -> Option<GatewayGeneration> {
        let current = self.inner.config.lock().ok()?;
        let config = current.config.as_ref()?;
        (config.ownership == GatewayOwnership::Local && self.is_connected())
            .then(|| self.generation())
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn pairing_lists(
        &self,
        generation: GatewayGeneration,
    ) -> Result<(Value, Value), String> {
        tokio::try_join!(
            self.desktop_request(generation.0, DesktopMethod::NodePairList, json!({})),
            self.desktop_request(generation.0, DesktopMethod::DevicePairList, json!({})),
        )
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{GatewayClient, GatewayGeneration, GatewayOwnership, Ordering};
    use crate::gateway_ws::{GatewayConnectionState, GatewayWsConfig};

    #[test]
    fn watchdog_uses_only_the_connected_local_route() {
        let gateway = GatewayClient::new();
        let route =
            |owner| GatewayWsConfig::new("ws://127.0.0.1:18789".into(), None, None, None, owner);
        let mark_connected = || {
            gateway
                .inner
                .connection_state
                .store(GatewayConnectionState::Up as u64, Ordering::SeqCst);
        };

        assert_eq!(gateway.local_watchdog_generation(), None);
        let local = gateway.replace_configuration(Some(route(GatewayOwnership::Local)));
        assert_eq!(gateway.local_watchdog_generation(), None);
        mark_connected();
        assert_eq!(
            gateway.local_watchdog_generation(),
            Some(GatewayGeneration(local))
        );

        gateway.replace_configuration(Some(route(GatewayOwnership::Remote)));
        mark_connected();
        assert_eq!(gateway.local_watchdog_generation(), None);
    }
}
