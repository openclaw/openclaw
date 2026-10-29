//! OpenAI-compatible provider: covers every provider extension that speaks the
//! `/v1/chat/completions` wire format.
//!
//! This single implementation replaces the 20+ separate upstream extensions
//! (`openrouter`, `groq`, `mistral`, `deepseek`, `xai`, `together`, `fireworks`,
//! `cerebras`, `deepinfra`, `novita`, `chutes`, `baseten`, `featherless`,
//! `gmi`, `liquid-ai`, `longcat`, `moonshot`, `qwen`, `stepfun`, `venice`,
//! `vercel-ai-gateway`, `cloudflare-ai-gateway`, `vllm`, `sglang`, `lmstudio`,
//! `llama-cpp`, `litellm`, `requesty`, `openrouter`, `copilot-proxy`, …) because
//! they differ only in base URL, API key, and model id.

use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::message::ReplyPayload;
use openclaw_core::traits::{CompletionMessage, CompletionRequest, CompletionRole, ModelProvider};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// A provider that speaks the OpenAI Chat Completions wire format.
#[derive(Debug)]
pub struct OpenAICompatibleProvider {
    id: String,
    base_url: String,
    api_key: String,
    model: String,
    client: reqwest::Client,
    extra_headers: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ApiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Serialize)]
struct ApiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    message: Option<ResponseMessage>,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
}

impl OpenAICompatibleProvider {
    /// Create a provider for any OpenAI-compatible endpoint.
    ///
    /// `base_url` must include the API version segment, for example
    /// `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`.
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            api_key: api_key.into(),
            model: model.into(),
            client: reqwest::Client::new(),
            extra_headers: Vec::new(),
        }
    }

    /// Add a static header required by the provider (for example OpenRouter's
    /// `HTTP-Referer` and `X-Title`).
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_headers.push((name.into(), value.into()));
        self
    }

    /// Override the model id after construction.
    #[must_use]
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    fn build_request(&self, request: &CompletionRequest) -> ChatRequest {
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
        }
    }
}

#[async_trait]
impl ModelProvider for OpenAICompatibleProvider {
    fn id(&self) -> &str {
        &self.id
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
        let body = self.build_request(&request);
        let mut builder = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .json(&body);

        if !self.api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", self.api_key));
        }
        for (name, value) in &self.extra_headers {
            builder = builder.header(name, value);
        }

        let response = builder
            .send()
            .await
            .map_err(|error| openclaw_core::Error::provider(&self.id, error.to_string()))?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let truncated: String = text.chars().take(600).collect();
            return Err(openclaw_core::Error::provider(
                &self.id,
                format!("HTTP {status}: {truncated}"),
            ));
        }

        let parsed: ChatResponse = serde_json::from_str(&text)
            .map_err(|error| openclaw_core::Error::provider(&self.id, error.to_string()))?;

        let content = parsed
            .choices
            .first()
            .and_then(|choice| choice.message.as_ref())
            .and_then(|message| message.content.clone())
            .unwrap_or_default();

        Ok(ReplyPayload {
            text: Some(content),
            ..Default::default()
        })
    }

    async fn complete_stream(
        &self,
        request: CompletionRequest,
        on_chunk: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<ReplyPayload> {
        // Non-streaming fallback: every compatible endpoint supports it, and the
        // caller still receives the full reply as one chunk.
        let reply = self.complete(request).await?;
        if let Some(text) = &reply.text {
            on_chunk(text.clone());
        }
        Ok(reply)
    }
}

/// Convenience constructor for an `Arc`-wrapped compatible provider.
#[must_use]
pub fn compatible_provider(
    id: impl Into<String>,
    base_url: impl Into<String>,
    api_key: impl Into<String>,
    model: impl Into<String>,
) -> Arc<dyn ModelProvider> {
    Arc::new(OpenAICompatibleProvider::new(id, base_url, api_key, model))
}

/// Known OpenAI-compatible provider endpoints.
///
/// `(id, base_url, default_model)`. Providers whose base URL is user-supplied
/// (self-hosted vLLM, SGLang, LM Studio, llama.cpp) are absent by design and are
/// configured through `providers.<id>.baseUrl` in the config file.
pub const KNOWN_COMPATIBLE: &[(&str, &str, &str)] = &[
    ("openrouter", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4"),
    ("groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
    ("mistral", "https://api.mistral.ai/v1", "mistral-large-latest"),
    ("deepseek", "https://api.deepseek.com/v1", "deepseek-chat"),
    ("xai", "https://api.x.ai/v1", "grok-2-latest"),
    ("together", "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"),
    ("fireworks", "https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/llama-v3p3-70b-instruct"),
    ("cerebras", "https://api.cerebras.ai/v1", "llama-3.3-70b"),
    ("deepinfra", "https://api.deepinfra.com/v1/openai", "meta-llama/Llama-3.3-70B-Instruct"),
    ("novita", "https://api.novita.ai/v3/openai", "meta-llama/llama-3.3-70b-instruct"),
    ("moonshot", "https://api.moonshot.ai/v1", "moonshot-v1-128k"),
    ("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-max"),
    ("stepfun", "https://api.stepfun.com/v1", "step-2-16k"),
    ("venice", "https://api.venice.ai/api/v1", "llama-3.3-70b"),
    ("perplexity", "https://api.perplexity.ai", "sonar-pro"),
    ("litellm", "http://localhost:4000/v1", "gpt-4o-mini"),
    ("vllm", "http://localhost:8000/v1", "meta-llama/Llama-3.1-8B-Instruct"),
    ("sglang", "http://localhost:30000/v1", "meta-llama/Llama-3.1-8B-Instruct"),
    ("lmstudio", "http://localhost:1234/v1", "local-model"),
    ("llama-cpp", "http://localhost:8080/v1", "local-model"),
];

/// Look up a known compatible provider's default base URL and model.
#[must_use]
pub fn known_compatible(id: &str) -> Option<(&'static str, &'static str)> {
    KNOWN_COMPATIBLE
        .iter()
        .find(|(name, _, _)| *name == id)
        .map(|(_, base_url, model)| (*base_url, *model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_compatible_covers_major_third_party_endpoints() {
        for id in ["openrouter", "groq", "mistral", "deepseek", "xai", "vllm"] {
            assert!(known_compatible(id).is_some(), "missing {id}");
        }
        assert!(known_compatible("no-such-provider").is_none());
    }

    #[test]
    fn base_url_trailing_slash_is_normalized() {
        let provider = OpenAICompatibleProvider::new("x", "https://example.com/v1/", "k", "m");
        assert_eq!(provider.base_url, "https://example.com/v1");
    }
}
