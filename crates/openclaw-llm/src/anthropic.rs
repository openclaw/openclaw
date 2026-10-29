//! Anthropic (Claude) provider implementation.

use async_trait::async_trait;
use futures_util::StreamExt;
use openclaw_core::error::Result;
use openclaw_core::message::ReplyPayload;
use openclaw_core::traits::{CompletionMessage, CompletionRequest, CompletionRole, ModelProvider};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const ANTHROPIC_API: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic Claude provider.
#[derive(Debug)]
pub struct AnthropicProvider {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<ApiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ApiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct StreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    delta: Option<StreamDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    text: Option<String>,
}

impl AnthropicProvider {
    /// Create a new Anthropic provider.
    #[must_use]
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            client: reqwest::Client::new(),
        }
    }

    fn build_request(&self, request: &CompletionRequest, stream: bool) -> MessagesRequest {
        let system = request
            .messages
            .iter()
            .find(|message| message.role == CompletionRole::System)
            .map(|message| message.content.clone());

        let messages: Vec<ApiMessage> = request
            .messages
            .iter()
            .filter(|message| message.role != CompletionRole::System)
            .map(|message| ApiMessage {
                role: match message.role {
                    CompletionRole::User => "user".to_owned(),
                    CompletionRole::Assistant => "assistant".to_owned(),
                    CompletionRole::System => unreachable!(),
                },
                content: message.content.clone(),
            })
            .collect();

        MessagesRequest {
            model: self.model.clone(),
            max_tokens: request.max_tokens.unwrap_or(4096),
            system,
            messages,
            temperature: request.temperature,
            stream: stream.then_some(true),
        }
    }
}

#[async_trait]
impl ModelProvider for AnthropicProvider {
    fn id(&self) -> &str {
        "anthropic"
    }

    async fn health_check(&self) -> Result<()> {
        // A minimal request to verify the API key works.
        let request = CompletionRequest {
            session: openclaw_core::id::SessionId::new(),
            system_prompt: String::new(),
            messages: vec![CompletionMessage {
                role: CompletionRole::User,
                content: "ping".to_owned(),
            }],
            max_tokens: Some(1),
            temperature: None,
        };
        self.complete(request).await.map(|_| ())
    }

    async fn complete(&self, request: CompletionRequest) -> Result<ReplyPayload> {
        let body = self.build_request(&request, false);
        let response = self
            .client
            .post(format!("{ANTHROPIC_API}/v1/messages"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("anthropic", error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(openclaw_core::Error::provider(
                "anthropic",
                format!("HTTP {status}: {text}"),
            ));
        }

        let parsed: MessagesResponse = response
            .json()
            .await
            .map_err(|error| openclaw_core::Error::provider("anthropic", error.to_string()))?;

        let text = parsed
            .content
            .iter()
            .filter(|block| block.block_type == "text")
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("");

        Ok(ReplyPayload {
            text: Some(text),
            ..Default::default()
        })
    }

    async fn complete_stream(
        &self,
        request: CompletionRequest,
        on_chunk: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<ReplyPayload> {
        let body = self.build_request(&request, true);
        let response = self
            .client
            .post(format!("{ANTHROPIC_API}/v1/messages"))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("anthropic", error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(openclaw_core::Error::provider(
                "anthropic",
                format!("HTTP {status}: {text}"),
            ));
        }

        let mut full = String::new();
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                openclaw_core::Error::provider("anthropic", error.to_string())
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Parse SSE lines: "data: {...}\n\n"
            while let Some(pos) = buffer.find("\n\n") {
                let line = buffer[..pos].to_owned();
                buffer = buffer[pos + 2..].to_owned();
                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(event) = serde_json::from_str::<StreamEvent>(data) {
                        if event.event_type == "content_block_delta" {
                            if let Some(delta) = event.delta {
                                if let Some(text) = delta.text {
                                    full.push_str(&text);
                                    on_chunk(text);
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(ReplyPayload {
            text: Some(full),
            ..Default::default()
        })
    }
}

/// Convenience constructor for an `Arc`-wrapped provider.
#[must_use]
pub fn anthropic_provider(api_key: impl Into<String>, model: impl Into<String>) -> Arc<dyn ModelProvider> {
    Arc::new(AnthropicProvider::new(api_key, model))
}
