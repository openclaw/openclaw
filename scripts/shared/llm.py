"""shared/llm.py — Centralized Gateway LLM client.

Single point for all LLM calls through the OpenClaw Gateway.
Consolidates the duplicated urllib+model-chain pattern from 4 scripts.
"""
import json
import os
import time
import urllib.error
import urllib.request

GATEWAY_URL = "http://127.0.0.1:18789/v1/chat/completions"
OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_TIMEOUT = 60
DEFAULT_TEMPERATURE = 0.3
DEFAULT_MAX_TOKENS = 2000
# Per-model timeout to prevent long queue stalls when a provider is degraded.
PER_MODEL_TIMEOUT = int(os.environ.get("OPENCLAW_PER_MODEL_TIMEOUT_SEC", "90"))
# Cooldown degraded models briefly so fallback can respond faster.
MODEL_COOLDOWN_SEC = int(os.environ.get("OPENCLAW_MODEL_COOLDOWN_SEC", "180"))
_MODEL_COOLDOWN_UNTIL = {}

# ── 파이프라인 공용 모델 체인 (변경 시 여기만 수정) ──────────
# Standard: 추출·분류·번역 등 단순 작업
DEFAULT_MODEL_CHAIN = [
    "github-copilot/gpt-5-mini",        # Tier 1: Copilot (무료, 범용)
    "openrouter/minimax/minimax-m2.5",   # Tier 2: OpenRouter (안정적)
    "ollama/qwen3:8b",                   # Tier 3: Ollama 로컬 (항상 가용)
]
# Premium: PEST분석·가설생성·인사이트·원자화 등 고품질 필요 작업
PREMIUM_MODEL_CHAIN = [
    "openrouter/google/gemini-2.5-flash-preview:free",  # Tier 0: Gemini (무료, 분석 우수)
    "github-copilot/gpt-5-mini",                         # Tier 1: Copilot
    "openrouter/minimax/minimax-m2.5",                    # Tier 2
    "ollama/qwen3:8b",                                    # Tier 3
]

# ── 직접 호출 체인 (Copilot=게이트웨이, 폴백=직접 호출) ──────────
DIRECT_DEFAULT_CHAIN = [
    "github-copilot/gpt-5-mini",          # 1순위: Copilot (게이트웨이, 고성능)
    "openrouter/minimax/minimax-m2.5",     # 2순위: OpenRouter 직접
    "ollama/qwen3:8b",                     # 3순위: Ollama 직접
]
DIRECT_PREMIUM_CHAIN = [
    "github-copilot/gpt-5-mini",                         # 1순위: Copilot (게이트웨이, 고성능)
    "openrouter/google/gemini-2.5-flash-preview:free",   # 2순위: Gemini 직접
    "openrouter/minimax/minimax-m2.5",                    # 3순위: minimax 직접
    "ollama/qwen3:8b",                                    # 4순위: Ollama 직접
]

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

# OpenRouter API key (from openclaw.json)
_openrouter_key = ""
_config_path = os.path.join(os.path.expanduser("~"), ".openclaw/openclaw.json")
if os.path.exists(_config_path):
    try:
        with open(_config_path) as _cf:
            _openrouter_key = json.load(_cf).get(
                "models", {}
            ).get("providers", {}).get("openrouter", {}).get("apiKey", "")
    except Exception:
        pass


def _should_cooldown(error_text: str) -> bool:
    text = (error_text or "").lower()
    cooldown_signals = [
        "timed out",
        "connection refused",
        "remote end closed",
        "http error 401",
        "http error 403",
        "http error 404",
        "http error 429",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
    ]
    return any(sig in text for sig in cooldown_signals)


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
    now = time.time()
    ready_models = [
        model_id
        for model_id in model_chain
        if float(_MODEL_COOLDOWN_UNTIL.get(model_id, 0.0)) <= now
    ]
    # If all models are cooling down, force one pass rather than hard-fail.
    try_models = ready_models if ready_models else list(model_chain)

    for model_id in try_models:
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
            model_timeout = max(5, min(int(timeout), int(PER_MODEL_TIMEOUT)))
            with urllib.request.urlopen(req, timeout=model_timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            choices = result.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                if content:
                    return content, model_id, ""
            last_error = f"{model_id}: empty_response"
        except Exception as e:
            err_text = str(e)[:120]
            last_error = f"{model_id}: {err_text}"
            if _should_cooldown(err_text):
                _MODEL_COOLDOWN_UNTIL[model_id] = time.time() + float(MODEL_COOLDOWN_SEC)
            continue
    return "", "", last_error


def _resolve_provider(model_id: str) -> tuple:
    """Resolve model ID to (url, headers, payload_model).

    - github-copilot/* → Gateway (main, performance priority)
    - openrouter/* → OpenRouter direct
    - Contains ':' (e.g., qwen3:8b) → Ollama direct
    """
    if model_id.startswith("github-copilot/"):
        headers = {"Content-Type": "application/json"}
        if GATEWAY_TOKEN:
            headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"
        return GATEWAY_URL, headers, model_id

    if model_id.startswith("openrouter/"):
        actual_model = model_id[len("openrouter/"):]
        headers = {"Content-Type": "application/json"}
        if _openrouter_key:
            headers["Authorization"] = f"Bearer {_openrouter_key}"
        return OPENROUTER_URL, headers, actual_model

    # Ollama: strip optional "ollama/" prefix for direct calls
    ollama_model = model_id[len("ollama/"):] if model_id.startswith("ollama/") else model_id
    headers = {"Content-Type": "application/json"}
    return OLLAMA_URL, headers, ollama_model


def llm_chat_direct(messages: list, model_chain: list,
                    temperature: float = DEFAULT_TEMPERATURE,
                    max_tokens: int = DEFAULT_MAX_TOKENS,
                    timeout: int = DEFAULT_TIMEOUT) -> tuple:
    """Send chat completion with direct provider routing.

    Copilot models go through Gateway (main, high perf).
    OpenRouter/Ollama models are called directly (no gateway overhead).

    Returns (content: str, used_model: str, error: str).
    """
    last_error = ""
    now = time.time()
    ready_models = [
        model_id
        for model_id in model_chain
        if float(_MODEL_COOLDOWN_UNTIL.get(model_id, 0.0)) <= now
    ]
    try_models = ready_models if ready_models else list(model_chain)

    for model_id in try_models:
        url, headers, payload_model = _resolve_provider(model_id)
        payload = {
            "model": payload_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            model_timeout = max(5, min(int(timeout), int(PER_MODEL_TIMEOUT)))
            with urllib.request.urlopen(req, timeout=model_timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            choices = result.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                if content:
                    return content, model_id, ""
            last_error = f"{model_id}: empty_response"
        except Exception as e:
            err_text = str(e)[:120]
            last_error = f"{model_id}: {err_text}"
            if _should_cooldown(err_text):
                _MODEL_COOLDOWN_UNTIL[model_id] = time.time() + float(MODEL_COOLDOWN_SEC)
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
