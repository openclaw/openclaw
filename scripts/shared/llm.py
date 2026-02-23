"""shared/llm.py — Centralized Gateway LLM client.

Single point for all LLM calls through the OpenClaw Gateway.
Consolidates the duplicated urllib+model-chain pattern from 4 scripts.
"""
import json
import os
import urllib.error
import urllib.request

GATEWAY_URL = "http://127.0.0.1:18789/v1/chat/completions"
DEFAULT_TIMEOUT = 60
DEFAULT_TEMPERATURE = 0.3
DEFAULT_MAX_TOKENS = 2000

# Token loading (same pattern used in all callers)
_token = os.environ.get("OPENCLAW_TOKEN", "")
if not _token:
    _env_file = os.path.join(os.path.expanduser("~"), ".openclaw/.env")
    if os.path.exists(_env_file):
        with open(_env_file) as _ef:
            for _line in _ef:
                if _line.startswith("OPENCLAW_TOKEN="):
                    _token = _line.strip().split("=", 1)[1].strip('"')
                    break
GATEWAY_TOKEN = _token


def llm_chat(messages: list, model: str = None, temperature: float = DEFAULT_TEMPERATURE,
             max_tokens: int = DEFAULT_MAX_TOKENS, timeout: int = DEFAULT_TIMEOUT) -> str:
    """Send a single chat completion request to Gateway.

    Returns the assistant's response text, or empty string on failure.
    """
    payload = {
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if model:
        payload["model"] = model

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    req = urllib.request.Request(
        GATEWAY_URL, data=data, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            choices = result.get("choices", [])
            if choices:
                return choices[0].get("message", {}).get("content", "")
            return ""
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            TimeoutError, OSError):
        return ""


def llm_chat_with_fallback(messages: list, model_chain: list,
                           temperature: float = DEFAULT_TEMPERATURE,
                           max_tokens: int = DEFAULT_MAX_TOKENS,
                           timeout: int = DEFAULT_TIMEOUT) -> tuple:
    """Send chat completion with model-chain fallback.

    Tries each model in model_chain sequentially until one succeeds.

    Returns (content: str, used_model: str, error: str).
    - On success: (response_text, model_id, "")
    - On failure: ("", "", last_error)
    """
    last_error = ""
    for model_id in model_chain:
        payload = {
            "model": model_id,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if GATEWAY_TOKEN:
            headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

        req = urllib.request.Request(
            GATEWAY_URL, data=data, headers=headers, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            choices = result.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                if content:
                    return content, model_id, ""
            last_error = f"{model_id}: empty_response"
        except Exception as e:
            last_error = f"{model_id}: {str(e)[:120]}"
            continue
    return "", "", last_error


def check_gateway(timeout: int = 5) -> bool:
    """Check if Gateway is available via /health endpoint."""
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:18789/health", method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False
