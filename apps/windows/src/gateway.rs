use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GatewayMessage {
    Connect { gateway_url: String },
    Disconnect,
    Send { to: String, content: String },
    Receive { from: String, content: String },
    DeviceList,
    DeviceListResponse(Vec<String>),
}

pub struct GatewayConnection {
    pub connected: bool,
    pub gateway_url: Option<String>,
}

impl GatewayConnection {
    pub fn new() -> Self {
        Self {
            connected: false,
            gateway_url: None,
        }
    }

    pub async fn connect(&mut self, url: String) -> Result<(), Box<dyn std::error::Error>> {
        let (ws_stream, _) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        self.connected = true;
        self.gateway_url = Some(url);

        // Handle incoming messages
        while let Some(msg) = read.next().await {
            if let Ok(WsMessage::Text(text)) = msg {
                println!("Received: {}", text);
            }
        }

        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.connected = false;
        self.gateway_url = None;
    }
}

pub type SharedGateway = Arc<RwLock<GatewayConnection>>;

pub fn create_gateway() -> SharedGateway {
    Arc::new(RwLock::new(GatewayConnection::new()))
}
