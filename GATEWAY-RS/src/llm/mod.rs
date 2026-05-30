use async_trait::async_trait;
use anyhow::Result;
use serde_json::Value;

#[async_trait]
pub trait LLMClient: Send + Sync {
    async fn chat_completion(&self, messages: Vec<Value>, model: &str) -> Result<String>;
}

pub struct OpenAIClient {
    pub api_key: String,
    pub base_url: String,
    pub client: reqwest::Client,
}

#[async_trait]
impl LLMClient for OpenAIClient {
    async fn chat_completion(&self, messages: Vec<Value>, model: &str) -> Result<String> {
        let url = format!("{}/chat/completions", self.base_url);
        let payload = serde_json::json!({
            "model": model,
            "messages": messages,
        });

        let response = self.client.post(url)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await?;

        let data: Value = response.json().await?;
        let content = data["choices"][0]["message"]["content"].as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid response from OpenAI"))?;

        Ok(content.to_string())
    }
}
