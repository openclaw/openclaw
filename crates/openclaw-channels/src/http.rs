//! Generic webhook/HTTP channel used by providers that expose an HTTP send API
//! but whose inbound transport is a webhook rather than a polling loop.
//!
//! This covers the long tail of upstream channel extensions that share the same
//! shape: an outbound authenticated POST plus inbound webhook delivery.

use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::id::ChannelId;
use openclaw_core::message::{MessageContent, OutboundMessage};
use openclaw_core::traits::Channel;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// An HTTP channel: outbound via authenticated POST, inbound via webhook.
#[derive(Debug)]
pub struct HttpChannel {
    id: ChannelId,
    /// Human-readable channel name (`slack`, `mattermost`, …).
    name: String,
    /// Full outbound endpoint URL.
    send_url: String,
    /// Auth header name/value pair, if the provider needs one.
    auth_header: Option<(String, String)>,
    /// JSON template; `{{text}}` is replaced with the outbound body.
    body_template: String,
    client: reqwest::Client,
    running: Arc<AtomicBool>,
}

impl HttpChannel {
    /// Build a generic HTTP channel.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        send_url: impl Into<String>,
        auth_header: Option<(String, String)>,
        body_template: impl Into<String>,
    ) -> Self {
        let name = name.into();
        Self {
            id: ChannelId::from_raw(name.clone()),
            name,
            send_url: send_url.into(),
            auth_header,
            body_template: body_template.into(),
            client: reqwest::Client::new(),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Slack incoming-webhook channel.
    #[must_use]
    pub fn slack(webhook_url: impl Into<String>) -> Self {
        Self::new("slack", webhook_url, None, r#"{"text":"{{text}}"}"#)
    }

    /// Mattermost incoming-webhook channel.
    #[must_use]
    pub fn mattermost(webhook_url: impl Into<String>) -> Self {
        Self::new("mattermost", webhook_url, None, r#"{"text":"{{text}}"}"#)
    }

    /// Google Chat incoming-webhook channel.
    #[must_use]
    pub fn google_chat(webhook_url: impl Into<String>) -> Self {
        Self::new("googlechat", webhook_url, None, r#"{"text":"{{text}}"}"#)
    }

    /// Microsoft Teams incoming-webhook channel.
    #[must_use]
    pub fn msteams(webhook_url: impl Into<String>) -> Self {
        Self::new("msteams", webhook_url, None, r#"{"text":"{{text}}"}"#)
    }

    /// Feishu/Lark bot webhook channel.
    #[must_use]
    pub fn feishu(webhook_url: impl Into<String>) -> Self {
        Self::new(
            "feishu",
            webhook_url,
            None,
            r#"{"msg_type":"text","content":{"text":"{{text}}"}}"#,
        )
    }

    /// Discord webhook channel (no bot token, no Gateway WebSocket needed).
    #[must_use]
    pub fn discord_webhook(webhook_url: impl Into<String>) -> Self {
        Self::new(
            "discord",
            webhook_url,
            None,
            r#"{"content":"{{text}}"}"#,
        )
    }

    /// Render the outbound body from the template.
    fn render_body(&self, text: &str) -> String {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "");
        self.body_template.replace("{{text}}", &escaped)
    }
}

#[async_trait]
impl Channel for HttpChannel {
    fn id(&self) -> &ChannelId {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    async fn start(&self) -> Result<()> {
        self.running.store(true, Ordering::Release);
        // Inbound arrives through the Gateway HTTP webhook surface, not a loop.
        while self.running.load(Ordering::Acquire) {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.running.store(false, Ordering::Release);
        Ok(())
    }

    async fn send(&self, message: OutboundMessage) -> Result<()> {
        let text = match &message.content {
            MessageContent::Text { text } | MessageContent::Markdown { text } => text.clone(),
            _ => {
                return Err(openclaw_core::Error::channel(
                    &self.name,
                    "unsupported content type for HTTP channel",
                ))
            }
        };

        let body = self.render_body(&text);
        let parsed: Value = serde_json::from_str(&body).map_err(|error| {
            openclaw_core::Error::channel(&self.name, format!("invalid body template: {error}"))
        })?;

        let mut builder = self.client.post(&self.send_url).json(&parsed);
        if let Some((name, value)) = &self.auth_header {
            builder = builder.header(name, value);
        }

        let response = builder
            .send()
            .await
            .map_err(|error| openclaw_core::Error::channel(&self.name, error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let truncated: String = text.chars().take(300).collect();
            return Err(openclaw_core::Error::channel(
                &self.name,
                format!("HTTP {status}: {truncated}"),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_template_escapes_json_specials() {
        let channel = HttpChannel::slack("https://example.invalid/hook");
        let body = channel.render_body("line \"one\"\nline two");
        assert!(body.contains(r#"line \"one\"\nline two"#));
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["text"], "line \"one\"\nline two");
    }

    #[test]
    fn webhook_constructors_use_matching_names() {
        assert_eq!(HttpChannel::slack("u").name(), "slack");
        assert_eq!(HttpChannel::mattermost("u").name(), "mattermost");
        assert_eq!(HttpChannel::google_chat("u").name(), "googlechat");
        assert_eq!(HttpChannel::msteams("u").name(), "msteams");
        assert_eq!(HttpChannel::feishu("u").name(), "feishu");
        assert_eq!(HttpChannel::discord_webhook("u").name(), "discord");
    }
}
