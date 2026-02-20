"""
AI Provider Integration — multi-provider LLM access for agent reasoning.

Supports OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, xAI, and Ollama.
Tries providers in preference order; falls back automatically on failure.
Can optionally route through the OpenClaw gateway.
"""
import json
from typing import Any, Dict, List, Optional
import httpx
import structlog

from core.config import settings


logger = structlog.get_logger()


# Provider endpoint and auth configuration
PROVIDER_CONFIG: Dict[str, Dict[str, Any]] = {
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "key_attr": "openai_api_key",
        "model_attr": "openai_model",
        "format": "openai",
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "auth_header": "x-api-key",
        "auth_prefix": "",
        "key_attr": "anthropic_api_key",
        "model_attr": "anthropic_model",
        "format": "anthropic",
    },
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "key_attr": "groq_api_key",
        "model_attr": "groq_model",
        "format": "openai",
    },
    "deepseek": {
        "url": "https://api.deepseek.com/v1/chat/completions",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "key_attr": "deepseek_api_key",
        "model_attr": "deepseek_model",
        "format": "openai",
    },
    "mistral": {
        "url": "https://api.mistral.ai/v1/chat/completions",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "key_attr": "mistral_api_key",
        "model_attr": "mistral_model",
        "format": "openai",
    },
    "xai": {
        "url": "https://api.x.ai/v1/chat/completions",
        "auth_header": "Authorization",
        "auth_prefix": "Bearer ",
        "key_attr": "xai_api_key",
        "model_attr": "xai_model",
        "format": "openai",
    },
    "ollama": {
        "url_template": "{base_url}/v1/chat/completions",
        "auth_header": None,
        "key_attr": None,
        "model_attr": "ollama_model",
        "format": "openai",
    },
}


class AIProvider:
    """
    Multi-provider AI integration with automatic fallback.

    Usage:
        ai = AIProvider()
        result = await ai.chat("Analyze this financial data: ...")
        # result = {"content": "...", "provider": "openai", "model": "gpt-4o"}
    """

    def __init__(self, preferred_provider: Optional[str] = None):
        self.logger = logger.bind(component="ai_provider")
        self._client: Optional[httpx.AsyncClient] = None

        # Build provider order from settings
        pref_str = preferred_provider or settings.ai_provider_preference
        self._provider_order = [p.strip() for p in pref_str.split(",") if p.strip()]

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    def _get_available_providers(self) -> List[str]:
        """Return providers that have API keys configured (or need none)."""
        available = []
        for name in self._provider_order:
            config = PROVIDER_CONFIG.get(name)
            if not config:
                continue
            key_attr = config.get("key_attr")
            if key_attr is None:
                # Provider like Ollama that doesn't need a key
                available.append(name)
            elif getattr(settings, key_attr, None):
                available.append(name)
        return available

    async def chat(
        self,
        message: str,
        *,
        system_prompt: Optional[str] = None,
        messages: Optional[List[Dict[str, str]]] = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send a chat completion request. Tries providers in preference order.

        Args:
            message: The user message (ignored if messages is provided).
            system_prompt: Optional system prompt.
            messages: Full message list (overrides message/system_prompt).
            temperature: Sampling temperature.
            max_tokens: Maximum response tokens.
            provider: Force a specific provider.
            model: Force a specific model.

        Returns:
            {"content": str, "provider": str, "model": str, "usage": dict}
        """
        if messages is None:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": message})

        providers_to_try = [provider] if provider else self._get_available_providers()

        if not providers_to_try:
            raise RuntimeError(
                "No AI providers configured. Set at least one API key "
                "(OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) in your .env file."
            )

        errors: List[Dict[str, str]] = []

        for prov_name in providers_to_try:
            try:
                result = await self._call_provider(
                    prov_name, messages, temperature, max_tokens, model
                )
                return result
            except Exception as e:
                error_msg = str(e)
                self.logger.warning(
                    "Provider failed, trying next",
                    provider=prov_name,
                    error=error_msg,
                )
                errors.append({"provider": prov_name, "error": error_msg})

        summary = "; ".join(f"{e['provider']}: {e['error']}" for e in errors)
        raise RuntimeError(f"All AI providers failed. {summary}")

    async def _call_provider(
        self,
        provider_name: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: int,
        model_override: Optional[str],
    ) -> Dict[str, Any]:
        """Make a chat completion request to a specific provider."""
        config = PROVIDER_CONFIG.get(provider_name)
        if not config:
            raise ValueError(f"Unknown provider: {provider_name}")

        # Resolve URL
        if "url_template" in config:
            base_url = getattr(settings, "ollama_base_url", "http://localhost:11434")
            url = config["url_template"].format(base_url=base_url)
        else:
            url = config["url"]

        # Resolve model
        model = model_override or getattr(settings, config["model_attr"], "")

        # Build headers
        headers = {"Content-Type": "application/json"}
        auth_header = config.get("auth_header")
        if auth_header:
            key_attr = config["key_attr"]
            api_key = getattr(settings, key_attr, "") if key_attr else ""
            prefix = config.get("auth_prefix", "")
            headers[auth_header] = f"{prefix}{api_key}"

        if provider_name == "anthropic":
            headers["anthropic-version"] = "2023-06-01"

        # Build body
        fmt = config.get("format", "openai")
        if fmt == "anthropic":
            body = self._build_anthropic_body(messages, model, temperature, max_tokens)
        else:
            body = self._build_openai_body(messages, model, temperature, max_tokens)

        # Make request
        response = await self.client.post(url, headers=headers, json=body)
        response.raise_for_status()
        data = response.json()

        # Parse response
        if fmt == "anthropic":
            content = self._parse_anthropic_response(data)
        else:
            content = self._parse_openai_response(data)

        return {
            "content": content,
            "provider": provider_name,
            "model": model,
            "usage": data.get("usage", {}),
        }

    def _build_openai_body(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> Dict[str, Any]:
        return {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

    def _build_anthropic_body(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> Dict[str, Any]:
        system_msg = next((m for m in messages if m["role"] == "system"), None)
        non_system = [m for m in messages if m["role"] != "system"]

        body: Dict[str, Any] = {
            "model": model,
            "messages": non_system,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system_msg:
            body["system"] = system_msg["content"]
        return body

    def _parse_openai_response(self, data: Dict[str, Any]) -> str:
        choices = data.get("choices", [])
        if not choices:
            raise ValueError("No choices in response")
        return choices[0].get("message", {}).get("content", "")

    def _parse_anthropic_response(self, data: Dict[str, Any]) -> str:
        content_blocks = data.get("content", [])
        if not content_blocks:
            raise ValueError("No content in response")
        return "".join(
            block.get("text", "") for block in content_blocks if block.get("type") == "text"
        )

    async def analyze(
        self,
        data: Any,
        prompt: str,
        *,
        system_prompt: str = "You are a business analyst AI agent. Provide concise, actionable analysis.",
        **kwargs,
    ) -> str:
        """
        Convenience method: analyze data with a prompt and return the text response.
        Serializes non-string data to JSON automatically.
        """
        if not isinstance(data, str):
            data_str = json.dumps(data, indent=2, default=str)
        else:
            data_str = data

        message = f"{prompt}\n\nData:\n{data_str}"
        result = await self.chat(message, system_prompt=system_prompt, **kwargs)
        return result["content"]

    async def health_check(self) -> Dict[str, Any]:
        """Check which AI providers are available and responding."""
        available = self._get_available_providers()
        results: Dict[str, Any] = {
            "configured_providers": available,
            "provider_details": {},
        }

        for prov_name in available:
            try:
                result = await self.chat(
                    "Reply with exactly: OK",
                    max_tokens=5,
                    temperature=0,
                    provider=prov_name,
                )
                results["provider_details"][prov_name] = {
                    "status": "connected",
                    "model": result.get("model"),
                }
            except Exception as e:
                results["provider_details"][prov_name] = {
                    "status": "error",
                    "error": str(e)[:200],
                }

        connected = sum(
            1
            for d in results["provider_details"].values()
            if d["status"] == "connected"
        )
        results["status"] = "healthy" if connected > 0 else "degraded"
        results["connected_count"] = connected

        return results

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
