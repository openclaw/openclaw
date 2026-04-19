"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """B-FIA backend settings."""

    bfia_port: int = 8321

    # Market data (uses yfinance directly — no API key needed)

    # Sentiment LLM provider: "ollama" (default), "openai", or "claude"
    sentiment_provider: str = "ollama"

    # Ollama (local fallback — no API key needed)
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.1:8b"

    # OpenAI public API (requires separate API key + credits)
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"

    # Claude (requires ANTHROPIC_API_KEY)
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"

    # QuantAgent (local — no external API needed)

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
