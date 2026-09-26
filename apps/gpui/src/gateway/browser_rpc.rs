//! The Browser plugin owns browser.request and its one-use screencast grants.
use futures_util::{SinkExt, StreamExt};
use openclaw_gateway_client::{DispatchRejection, GatewaySession};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use url::Url;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "target", rename_all = "lowercase")]
pub enum BrowserRoute {
    Host { profile: String },
    Node { profile: String, node: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTarget {
    #[serde(flatten)]
    pub route: BrowserRoute,
    pub target_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserTab {
    pub tab_id: String,
    pub target_id: String,
    pub title: String,
    pub url: String,
    pub url_unavailable_reason: Option<String>,
}

impl BrowserTab {
    pub fn id(&self) -> &str {
        if self.tab_id.is_empty() {
            &self.target_id
        } else {
            &self.tab_id
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMetadata {
    pub url: String,
    pub css_width: f32,
    pub css_height: f32,
}

pub enum BrowserEvent {
    Tabs {
        running: bool,
        tabs: Vec<BrowserTab>,
        active: Option<String>,
        revision: u64,
    },
    Metadata {
        url: String,
        title: String,
        revision: u64,
    },
    Frame {
        metadata: FrameMetadata,
        jpeg: Vec<u8>,
        revision: u64,
    },
    Snapshot {
        metadata: FrameMetadata,
        png: Vec<u8>,
        revision: u64,
    },
    StreamError {
        message: String,
        revision: u64,
    },
    Error(String),
}

pub enum BrowserCommand {
    Refresh,
    Start,
    Select(String),
    Navigate(String),
    NewTab(String),
    Close(String),
    Click { x: f32, y: f32 },
    Key(String),
    Insert(String),
    Scroll { x: f32, y: f32 },
    History(i8),
}

pub struct BrowserConnection {
    pub commands: mpsc::Sender<BrowserCommand>,
    live: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl Drop for BrowserConnection {
    fn drop(&mut self) {
        self.live.store(false, Ordering::Release);
        self.task.abort();
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Tabs {
    running: bool,
    tabs: Vec<BrowserTab>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Screencast {
    ws_path: String,
}

struct AbortTask(JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct BrowserActor {
    gateway: GatewaySession,
    gateway_url: String,
    access_token: Option<String>,
    live: Arc<AtomicBool>,
    events: async_channel::Sender<BrowserEvent>,
    active: Option<String>,
    stream: Option<AbortTask>,
    revision: u64,
    route: Option<BrowserRoute>,
    input_ready: bool,
    snapshot_mode: bool,
}

impl BrowserConnection {
    pub fn start(
        runtime: &tokio::runtime::Handle,
        gateway: GatewaySession,
        gateway_url: String,
        access_token: Option<String>,
        target: Option<BrowserTarget>,
    ) -> (Self, async_channel::Receiver<BrowserEvent>) {
        let (commands, mut receiver) = mpsc::channel(64);
        let (events, event_rx) = async_channel::bounded(2);
        let live = Arc::new(AtomicBool::new(true));
        let mut actor = BrowserActor {
            gateway,
            gateway_url,
            access_token,
            live: live.clone(),
            events,
            active: target.as_ref().map(|target| target.target_id.clone()),
            stream: None,
            revision: 0,
            route: target.map(|target| target.route),
            input_ready: false,
            snapshot_mode: false,
        };
        let task = runtime.spawn(async move {
            if let Err(error) = actor.refresh().await {
                actor.error(error).await;
            }
            while let Some(command) = receiver.recv().await {
                if !actor.live.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = actor.command(command).await {
                    actor.input_ready = false;
                    actor.error(error).await;
                }
            }
        });
        (
            Self {
                commands,
                live,
                task,
            },
            event_rx,
        )
    }
}

impl BrowserActor {
    async fn error(&self, error: String) {
        let _ = self.events.send(BrowserEvent::Error(error)).await;
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let live = self.live.clone();
        let mut params = json!({"method":method,"path":path});
        if let Some(route) = &self.route {
            match route {
                BrowserRoute::Host { profile } => {
                    params["target"] = json!("host");
                    params["query"] = json!({"profile":profile});
                }
                BrowserRoute::Node { profile, node } => {
                    params["target"] = json!("node");
                    params["node"] = json!(node);
                    params["query"] = json!({"profile":profile});
                }
            }
        }
        if let Some(body) = body {
            params["body"] = body;
        }
        self.gateway
            .request_with_deadline(
                "browser.request",
                params,
                Instant::now() + Duration::from_secs(30),
                move || {
                    if live.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(DispatchRejection::new("Browser panel closed"))
                    }
                },
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn refresh(&mut self) -> Result<(), String> {
        self.stream = None;
        self.revision += 1;
        let snapshot: Tabs = serde_json::from_value(self.request("GET", "/tabs", None).await?)
            .map_err(|_| "Gateway returned invalid browser tabs".to_owned())?;
        let active = snapshot
            .tabs
            .iter()
            .find(|tab| {
                Some(tab.id()) == self.active.as_deref()
                    || Some(tab.target_id.as_str()) == self.active.as_deref()
            })
            .or_else(|| {
                snapshot
                    .tabs
                    .iter()
                    .find(|tab| tab.url_unavailable_reason.is_none())
            });
        self.active = active
            .filter(|_| snapshot.running)
            .map(|tab| tab.id().to_owned());
        let _ = self
            .events
            .send(BrowserEvent::Tabs {
                running: snapshot.running,
                tabs: snapshot.tabs,
                active: self.active.clone(),
                revision: self.revision,
            })
            .await;
        self.snapshot_mode = false;
        if self.start_stream().await.is_err() {
            self.snapshot_mode = true;
            self.capture_snapshot().await?;
        }
        self.input_ready = self.active.is_some();
        Ok(())
    }

    async fn start_stream(&mut self) -> Result<(), String> {
        self.stream = None;
        let Some(target) = &self.active else {
            return Ok(());
        };
        let response: Screencast = serde_json::from_value(
            self.request(
                "POST",
                "/screencast",
                Some(json!({
                    "targetId":target,"maxWidth":1600,"maxHeight":1600
                })),
            )
            .await?,
        )
        .map_err(|_| "Gateway returned an invalid screencast grant".to_owned())?;
        let url = stream_url(&self.gateway_url, &response.ws_path)?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "Invalid screencast URL".to_owned())?;
        if let Some(token) = &self.access_token {
            request.headers_mut().insert(
                "Cf-Access-Token",
                token
                    .parse()
                    .map_err(|_| "Invalid Access session".to_owned())?,
            );
        }
        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| "Browser screencast connection timed out".to_owned())?
        .map_err(|_| "Could not connect to the browser screencast".to_owned())?;
        let events = self.events.clone();
        let revision = self.revision;
        self.stream = Some(AbortTask(tokio::spawn(async move {
            while let Some(message) = socket.next().await {
                let event = match message {
                    Ok(Message::Binary(data)) => {
                        decode_frame(&data).map(|(metadata, jpeg)| BrowserEvent::Frame {
                            metadata,
                            jpeg,
                            revision,
                        })
                    }
                    Ok(Message::Text(text)) => decode_metadata(&text, revision),
                    Ok(Message::Ping(data)) => {
                        let _ = socket.send(Message::Pong(data)).await;
                        continue;
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        let _ = events
                            .send(BrowserEvent::StreamError {
                                message: "Browser stream disconnected; refresh to reconnect".into(),
                                revision,
                            })
                            .await;
                        break;
                    }
                    _ => continue,
                };
                match event {
                    Ok(event) => {
                        let _ = events.try_send(event);
                    }
                    Err(message) => {
                        let _ = events
                            .send(BrowserEvent::StreamError { message, revision })
                            .await;
                        break;
                    }
                }
            }
        })));
        Ok(())
    }

    async fn capture_snapshot(&self) -> Result<(), String> {
        let Some(target) = &self.active else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Capture {
            path: String,
            #[serde(default)]
            url: String,
        }
        let result: Capture = serde_json::from_value(
            self.request(
                "POST",
                "/screenshot",
                Some(json!({"targetId":target,"type":"png"})),
            )
            .await?,
        )
        .map_err(|_| "Gateway returned an invalid browser screenshot".to_owned())?;
        let mut media =
            Url::parse(&self.gateway_url).map_err(|_| "Invalid Gateway URL".to_owned())?;
        let scheme = if matches!(media.scheme(), "wss" | "https") {
            "https"
        } else {
            "http"
        };
        media
            .set_scheme(scheme)
            .map_err(|_| "Invalid Gateway URL".to_owned())?;
        let base = media.path().trim_end_matches('/');
        media.set_path(&format!("{base}/__openclaw__/assistant-media"));
        media.set_query(None);
        media.query_pairs_mut().append_pair("source", &result.path);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not initialize screenshot download".to_owned())?;
        let mut request = http.get(media).header("Accept", "image/png");
        if let Some(token) = self
            .gateway
            .hello()
            .pointer("/auth/deviceToken")
            .and_then(Value::as_str)
        {
            request = request.bearer_auth(token);
        }
        if let Some(token) = &self.access_token {
            request = request.header("Cf-Access-Token", token);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Could not download browser screenshot".to_owned())?
            .error_for_status()
            .map_err(|_| "Gateway refused browser screenshot download".to_owned())?;
        let mut png = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Browser screenshot download failed".to_owned())?
        {
            if png.len() + chunk.len() > 32 * 1024 * 1024 {
                return Err("Browser screenshot exceeds 32 MB".into());
            }
            png.extend(chunk);
        }
        let natural = png_dimensions(&png)
            .ok_or_else(|| "Gateway returned an invalid PNG screenshot".to_owned())?;
        let metrics = self.request("POST", "/act", Some(json!({"kind":"evaluate","targetId":target,"fn":"() => ({ cssWidth: window.innerWidth, cssHeight: window.innerHeight, url: location.href })"}))).await
            .ok().and_then(|value| serde_json::from_value::<FrameMetadata>(value.get("result")?.clone()).ok())
            .filter(|metrics| metrics.css_width.is_finite() && metrics.css_height.is_finite() && metrics.css_width > 0. && metrics.css_height > 0.);
        let metadata = metrics.unwrap_or(FrameMetadata {
            url: result.url,
            css_width: natural.0,
            css_height: natural.1,
        });
        let _ = self
            .events
            .send(BrowserEvent::Snapshot {
                metadata,
                png,
                revision: self.revision,
            })
            .await;
        Ok(())
    }

    async fn command(&mut self, command: BrowserCommand) -> Result<(), String> {
        if matches!(
            &command,
            BrowserCommand::Key(_) | BrowserCommand::Insert(_) | BrowserCommand::Scroll { .. }
        ) && !self.input_ready
        {
            return Err(
                "Browser input paused after an operation failed; refresh before continuing".into(),
            );
        }
        let target = self.active.clone();
        let mut refresh = false;
        let body = match command {
            BrowserCommand::Refresh => return self.refresh().await,
            BrowserCommand::Start => {
                self.request("POST", "/start", Some(json!({}))).await?;
                return self.refresh().await;
            }
            BrowserCommand::Select(id) => {
                self.request("POST", "/tabs/focus", Some(json!({"targetId":id})))
                    .await?;
                self.active = Some(id);
                return self.refresh().await;
            }
            BrowserCommand::NewTab(url) => {
                let tab: BrowserTab = serde_json::from_value(
                    self.request("POST", "/tabs/open", Some(json!({"url":url})))
                        .await?,
                )
                .map_err(|_| "Gateway returned invalid browser tab".to_owned())?;
                self.active = Some(tab.id().to_owned());
                return self.refresh().await;
            }
            BrowserCommand::Close(id) => {
                let id =
                    percent_encoding::utf8_percent_encode(&id, percent_encoding::NON_ALPHANUMERIC);
                self.request("DELETE", &format!("/tabs/{id}"), None).await?;
                return self.refresh().await;
            }
            BrowserCommand::Navigate(url) => {
                self.request(
                    "POST",
                    "/navigate",
                    Some(json!({"targetId":target,"url":url})),
                )
                .await?;
                return self.refresh().await;
            }
            BrowserCommand::Click { x, y } => {
                json!({"kind":"clickCoords","x":x.max(0.).round(),"y":y.max(0.).round()})
            }
            BrowserCommand::Key(key) => json!({"kind":"press","key":key}),
            BrowserCommand::Insert(text) => json!({"kind":"insertText","text":text}),
            BrowserCommand::Scroll { x, y } => {
                json!({"kind":"evaluate","fn":format!("() => {{ window.scrollBy({}, {}); return true; }}", x.round(), y.round())})
            }
            BrowserCommand::History(delta) => {
                refresh = true;
                json!({"kind":"evaluate","fn":format!("() => {{ history.go({}); return true; }}", delta.clamp(-1,1))})
            }
        };
        let Some(target) = target else {
            return Ok(());
        };
        let mut body = body;
        body["targetId"] = json!(target);
        self.request("POST", "/act", Some(body))
            .await
            .map_err(|_| "Browser input failed; refresh before continuing".to_owned())?;
        if refresh {
            self.refresh().await?;
        } else if self.snapshot_mode {
            self.capture_snapshot().await?;
        }
        Ok(())
    }
}

fn png_dimensions(bytes: &[u8]) -> Option<(f32, f32)> {
    if bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?) as f32;
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?) as f32;
    (width > 0. && height > 0.).then_some((width, height))
}

fn stream_url(gateway: &str, path: &str) -> Result<Url, String> {
    let base = Url::parse(gateway).map_err(|_| "Invalid Gateway URL".to_owned())?;
    let mut url = base
        .join(path)
        .map_err(|_| "Invalid screencast URL".to_owned())?;
    if url.origin() != base.origin() {
        return Err("Screencast must use the connected Gateway origin".into());
    }
    match url.scheme() {
        "http" => {
            let _ = url.set_scheme("ws");
        }
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "ws" | "wss" => {}
        _ => return Err("Screencast requires WebSocket transport".into()),
    }
    Ok(url)
}

fn decode_metadata(text: &str, revision: u64) -> Result<BrowserEvent, String> {
    #[derive(Deserialize)]
    struct Metadata {
        r#type: String,
        url: String,
        title: String,
    }
    let metadata: Metadata =
        serde_json::from_str(text).map_err(|_| "Invalid screencast metadata".to_owned())?;
    if metadata.r#type != "ready" && metadata.r#type != "meta" {
        return Err("Browser screencast ended".into());
    }
    Ok(BrowserEvent::Metadata {
        url: metadata.url,
        title: metadata.title,
        revision,
    })
}

fn decode_frame(bytes: &[u8]) -> Result<(FrameMetadata, Vec<u8>), String> {
    let invalid = || "Invalid browser screencast frame".to_owned();
    let prefix: [u8; 4] = bytes
        .get(..4)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length >= bytes.len() - 4 {
        return Err(invalid());
    }
    let metadata: FrameMetadata =
        serde_json::from_slice(&bytes[4..4 + length]).map_err(|_| invalid())?;
    if !metadata.css_width.is_finite()
        || !metadata.css_height.is_finite()
        || metadata.css_width <= 0.
        || metadata.css_height <= 0.
    {
        return Err(invalid());
    }
    Ok((metadata, bytes[4 + length..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screencast_wire_header_preserves_jpeg_bytes_and_rejects_invalid_dimensions() {
        let header = br#"{"url":"https://example.com/","cssWidth":1280,"cssHeight":720}"#;
        let mut wire = (header.len() as u32).to_be_bytes().to_vec();
        wire.extend(header);
        wire.extend([255, 216, 255, 217]);
        let (meta, image) = decode_frame(&wire).unwrap();
        assert_eq!((meta.css_width, meta.css_height), (1280., 720.));
        assert_eq!(image, [255, 216, 255, 217]);
        assert!(decode_frame(&wire[..4]).is_err());
        assert!(decode_frame(&[0, 0, 0, 0, 1]).is_err());
        let bad = br#"{"url":"https://example.com/","cssWidth":0,"cssHeight":720}"#;
        let mut wire = (bad.len() as u32).to_be_bytes().to_vec();
        wire.extend(bad);
        wire.push(1);
        assert!(decode_frame(&wire).is_err());
    }

    #[test]
    fn screencast_auth_cannot_follow_a_grant_to_another_origin() {
        assert_eq!(
            stream_url(
                "wss://gateway.example/base/",
                "/browser/screencast?token=synthetic"
            )
            .unwrap()
            .as_str(),
            "wss://gateway.example/browser/screencast?token=synthetic"
        );
        assert!(
            stream_url(
                "wss://gateway.example/",
                "wss://other.example/browser/screencast"
            )
            .is_err()
        );
    }
}
