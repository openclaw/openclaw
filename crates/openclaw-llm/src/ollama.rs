//! Ollama local model provider implementation.

use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::message::ReplyPayload;
use openclaw_core::traits::{CompletionRequest, CompletionRole, ModelProvider};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Ollama local model provider.
#[derive(Debug)]
pub struct OllamaProvider {
    base_url: String,
    model: String,
    client: reqwest::Client,
}

#[derive(Debug, Serialize)]
struct GenerateRequest {
    model: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct GenerateResponse {
    response: String,
}

impl OllamaProvider {
    /// Create a new Ollama provider.
    #[must_use]
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            client: reqwest::Client::new(),
        }
    }

    fn build_prompt(&self, request: &CompletionRequest) -> (String, Option<String>) {
        let system = request
            .messages
            .iter()
            .find(|message| message.role == CompletionRole::System)
            .map(|message| message.content.clone())
            .or_else(|| {
                if request.system_prompt.is_empty() {
                    None
                } else {
                    Some(request.system_prompt.clone())
                }
            });

        let prompt = request
            .messages
            .iter()
            .filter(|message| message.role != CompletionRole::System)
            .map(|message| {
                let role = match message.role {
                    CompletionRole::User => "User",
                    CompletionRole::Assistant => "Assistant",
                    CompletionRole::System => unreachable!(),
                };
                format!("{role}: {}", message.content)
            })
            .collect::<Vec<_>>()
            .join("\n");

        (prompt, system)
    }
}

#[async_trait]
impl ModelProvider for OllamaProvider {
    fn id(&self) -> &str {
        "ollama"
    }

    async fn health_check(&self) -> Result<()> {
        self.client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("ollama", error.to_string()))?;
        Ok(())
    }

    async fn complete(&self, request: CompletionRequest) -> Result<ReplyPayload> {
        let (prompt, system) = self.build_prompt(&request);
        let body = GenerateRequest {
            model: self.model.clone(),
            prompt,
            system,
            stream: false,
        };

        let response = self
            .client
            .post(format!("{}/api/generate", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider("ollama", error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(openclaw_core::Error::provider(
                "ollama",
                format!("HTTP {status}: {text}"),
            ));
        }

        let parsed: GenerateResponse = response
            .json()
            .await
            .map_err(|error| openclaw_core::Error::provider("ollama", error.to_string()))?;

        Ok(ReplyPayload {
            text: Some(parsed.response),
            ..Default::default()
        })
    }

    async fn complete_stream(
        &self,
        request: CompletionRequest,
        on_chunk: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<ReplyPayload> {
        // Ollama streaming uses newline-delimited JSON; fall back to
        // non-streaming and emit the whole reply as one chunk.
        let reply = self.complete(request).await?;
        if let Some(text) = &reply.text {
            on_chunk(text.clone());
        }
        Ok(reply)
    }
}

/// Convenience constructor for an `Arc`-wrapped provider.
#[must_use]
pub fn ollama_provider(
    base_url: impl Into<String>,
    model: impl Into<String>,
) -> Arc<dyn ModelProvider> {
    Arc::new(OllamaProvider::new(base_url, model))
}
