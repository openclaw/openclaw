//! OpenAI provider implementation.

use async_trait::async_trait;
use futures_util::StreamExt;
use openclaw_core::error::Result;
use openclaw_core::message::ReplyPayload;
use openclaw_core::traits::{CompletionMessage, CompletionRequest, CompletionRole, ModelProvider};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const OPENAI_API: &str = "https://api.openai.com/v1";

/// OpenAI provider.
#[derive(Debug)]
pub struct OpenAIProvider {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ApiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
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
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

impl OpenAIProvider {
    /// Create a new OpenAI provider.
    #[must_use]
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            client: reqwest::Client::new(),
        }
    }

    fn build_request(&self, request: &CompletionRequest, stream: bool) -> ChatRequest {
        let mut messages: Vec<ApiMessage> = Vec::new();
        if !request.system_prompt.is_empty() {
            messages.push(ApiMessage {
                role: "system".to_owned(),
                content: request.system_prompt.clone(),
            });
        }
        for message in &request.messages {
            let role = match message.role {
                CompletionRole::System => "system",
                CompletionRole::User => "user",
                CompletionRole::Assistant => "assistant",
            };
            messages.push(ApiMessage {
                role: role.to_owned(),
                content: message.content.clone(),
            });
        }

        ChatRequest {
            model: self.model.clone(),
            messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            stream: stream.then_some(true),
        }
    }
}

#[async_trait]
impl ModelProvider for OpenAIProvider {
    fn id(&self) -> &str {
        "openai"
    }

    async fn health_check(&self) -> Result<()> {
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
            .post(format!("{OPENAI_API}/chat/completions"))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("openai", error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(openclaw_core::Error::provider(
                "openai",
                format!("HTTP {status}: {text}"),
            ));
        }

        let parsed: ChatResponse = response
            .json()
            .await
            .map_err(|error| openclaw_core::Error::provider("openai", error.to_string()))?;

        let text = parsed
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_default();

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
            .post(format!("{OPENAI_API}/chat/completions"))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("openai", error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(openclaw_core::Error::provider(
                "openai",
                format!("HTTP {status}: {text}"),
            ));
        }

        let mut full = String::new();
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                openclaw_core::Error::provider("openai", error.to_string())
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find("\n\n") {
                let line = buffer[..pos].to_owned();
                buffer = buffer[pos + 2..].to_owned();
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                        if let Some(choice) = chunk.choices.first() {
                            if let Some(text) = &choice.delta.content {
                                full.push_str(text);
                                on_chunk(text.clone());
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
pub fn openai_provider(api_key: impl Into<String>, model: impl Into<String>) -> Arc<dyn ModelProvider> {
    Arc::new(OpenAIProvider::new(api_key, model))
}
