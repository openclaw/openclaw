#!/usr/bin/env python3
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
# Licensed under MIT
"""
fallback.py — Cron model fallback chain for OpenClaw.

Tries models in priority order until one succeeds. Designed to wrap cron jobs
that would otherwise fail silently when a single model is unavailable.

Calls the OpenClaw gateway HTTP API directly, passing each model as an override.
No provider-specific logic — any model OpenClaw supports works.

Usage:
    python3 fallback.py \\
        --models "anthropic/claude-sonnet-4,google/gemini-2.5-flash,groq/llama-3.3-70b" \\
        --prompt "Your task here"

    # Or use defaults from openclaw.json → cron.fallbackModels
    python3 fallback.py --prompt "Your task"

Authentication:
    OPENCLAW_TOKEN env var, or ~/.openclaw/openclaw.json → gateway.auth.token
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

# --- Constants ---
DEFAULT_TIMEOUT_SEC = 120
CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"
TOKEN_ENV_VAR = "OPENCLAW_TOKEN"
DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789"

# Exit codes
EXIT_SUCCESS = 0
EXIT_ALL_FAILED = 1
EXIT_CONFIG_ERROR = 2


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Load openclaw.json, return empty dict on failure."""
    if not CONFIG_PATH.exists():
        return {}
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def load_token(config: dict) -> Optional[str]:
    """Load auth token from env var or config file."""
    token = os.environ.get(TOKEN_ENV_VAR)
    if token:
        return token.strip()
    token = config.get("gateway", {}).get("auth", {}).get("token")
    if token:
        return str(token).strip()
    return None


def load_default_models(config: dict) -> list[str]:
    """Read default fallback chain from openclaw.json → cron.fallbackModels."""
    models = config.get("cron", {}).get("fallbackModels", [])
    if isinstance(models, list):
        return [str(m).strip() for m in models if str(m).strip()]
    return []


def resolve_gateway_url(config: dict) -> str:
    """Resolve gateway URL from env or config."""
    url = os.environ.get("OPENCLAW_GATEWAY_URL")
    if url:
        return url.rstrip("/")
    port = config.get("gateway", {}).get("port")
    if port:
        return f"http://127.0.0.1:{port}"
    return DEFAULT_GATEWAY_URL


# ---------------------------------------------------------------------------
# Gateway API call
# ---------------------------------------------------------------------------

def try_model(
    model: str,
    prompt: str,
    token: str,
    agent: Optional[str],
    gateway_url: str,
    timeout_sec: int,
    quiet: bool,
) -> Optional[str]:
    """
    Call the OpenClaw gateway API directly with a model override.

    POST {gateway}/api → method: "agent", params: { message, model, agentId }

    Returns the response text on success, or None on failure.
    """
    if not quiet:
        print(f"  → Trying: {model}", file=sys.stderr)

    start = time.monotonic()

    params: dict = {"message": prompt, "model": model}
    if agent:
        params["agentId"] = agent

    payload = json.dumps({
        "method": "agent",
        "params": params,
    }).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    try:
        req = urllib.request.Request(
            f"{gateway_url}/api",
            data=payload,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            data = json.loads(resp.read())

        elapsed = time.monotonic() - start

        # Extract text from response
        result = data.get("result", {})
        payloads = result.get("payloads", [])
        texts = [p.get("text", "") for p in payloads if p.get("text")]
        output = "\n".join(texts).strip()

        if not output:
            if not quiet:
                status = data.get("status", "unknown")
                print(f"  ✗ {model}: empty response ({status}) after {elapsed:.1f}s", file=sys.stderr)
            return None

        if not quiet:
            print(f"  ✓ {model}: OK ({elapsed:.1f}s)", file=sys.stderr)
        return output

    except urllib.error.HTTPError as exc:
        elapsed = time.monotonic() - start
        if not quiet:
            try:
                body = exc.read().decode()[:200]
            except Exception:
                body = str(exc)
            print(f"  ✗ {model}: HTTP {exc.code} after {elapsed:.1f}s — {body}", file=sys.stderr)
        return None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        elapsed = time.monotonic() - start
        if not quiet:
            print(f"  ✗ {model}: {exc} after {elapsed:.1f}s", file=sys.stderr)
        return None
    except Exception as exc:
        elapsed = time.monotonic() - start
        if not quiet:
            print(f"  ✗ {model}: {exc} after {elapsed:.1f}s", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Fallback chain
# ---------------------------------------------------------------------------

def run_with_fallback(
    models: list[str],
    prompt: str,
    token: str,
    agent: Optional[str],
    gateway_url: str,
    timeout_sec: int,
    quiet: bool,
) -> tuple[Optional[str], str, int]:
    """Try each model in order. Return (result_text, winning_model, attempts)."""
    if not quiet:
        print(f"\n[fallback] {len(models)} model(s): {', '.join(models)}", file=sys.stderr)

    for attempt, model in enumerate(models, start=1):
        result = try_model(
            model=model,
            prompt=prompt,
            token=token,
            agent=agent,
            gateway_url=gateway_url,
            timeout_sec=timeout_sec,
            quiet=quiet,
        )
        if result is not None:
            if not quiet:
                print(f"\n[fallback] ✓ {model} (attempt {attempt}/{len(models)})", file=sys.stderr)
            return result, model, attempt

    if not quiet:
        print(f"\n[fallback] ✗ All {len(models)} model(s) failed.", file=sys.stderr)
    return None, "", len(models)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Cron model fallback chain for OpenClaw.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python3 fallback.py \\
    --models "anthropic/claude-sonnet-4,google/gemini-2.5-flash" \\
    --prompt "Summarize today's news"

  # Use defaults from openclaw.json (cron.fallbackModels)
  python3 fallback.py --prompt "Your task"

Configuration (openclaw.json):
  cron.fallbackModels: ["model-a", "model-b", ...]
  gateway.auth.token: "your-token"
        """,
    )
    parser.add_argument("--models", type=str, default=None,
        help="Comma-separated model list. If omitted, reads cron.fallbackModels from config")
    parser.add_argument("--prompt", type=str, default=None, help="Task prompt")
    parser.add_argument("--prompt-file", type=str, default=None, metavar="FILE",
        help="Path to file containing the prompt")
    parser.add_argument("--agent", type=str, default=None,
        help="Agent ID (uses default agent if omitted)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SEC,
        help=f"Seconds per model attempt (default: {DEFAULT_TIMEOUT_SEC})")
    parser.add_argument("--quiet", action="store_true",
        help="Suppress progress output")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config()

    # Resolve models
    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    else:
        models = load_default_models(config)

    if not models:
        print(
            "ERROR: No models specified.\n"
            "  Use --models or set cron.fallbackModels in openclaw.json",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    # Auth
    token = load_token(config)
    if not token:
        print(f"ERROR: No auth token. Set {TOKEN_ENV_VAR} or configure gateway.auth.token", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    # Gateway URL
    gateway_url = resolve_gateway_url(config)

    # Prompt
    prompt: Optional[str] = None
    if args.prompt_file:
        p = Path(args.prompt_file)
        if not p.exists():
            print(f"ERROR: File not found: {p}", file=sys.stderr)
            return EXIT_CONFIG_ERROR
        prompt = p.read_text(encoding="utf-8").strip()
    elif args.prompt:
        prompt = args.prompt.strip()

    if not prompt:
        print("ERROR: Provide --prompt or --prompt-file.", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    # Run
    result, model, attempts = run_with_fallback(
        models=models, prompt=prompt, token=token, agent=args.agent,
        gateway_url=gateway_url, timeout_sec=args.timeout, quiet=args.quiet,
    )

    if result is None:
        print(f"ERROR: All {attempts} model(s) failed: {', '.join(models)}", file=sys.stderr)
        return EXIT_ALL_FAILED

    print(result)
    return EXIT_SUCCESS


if __name__ == "__main__":
    sys.exit(main())
