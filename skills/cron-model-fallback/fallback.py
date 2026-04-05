#!/usr/bin/env python3
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
# Licensed under MIT
"""
fallback.py — Cron model fallback chain for OpenClaw.

Tries models in priority order until one succeeds. Designed to wrap cron jobs
that would otherwise fail silently when a model is unavailable.

Usage:
    python3 fallback.py --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5" \
                        --prompt "Your task here"
    python3 fallback.py --test --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5"

Authentication (in priority order):
    1. OPENCLAW_TOKEN environment variable
    2. ~/.openclaw/openclaw.json → gateway.auth.token
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

# Conditionally import requests — fail early with a helpful message
try:
    import requests
except ImportError:
    print("ERROR: 'requests' library not found. Install with: pip3 install requests", file=sys.stderr)
    sys.exit(2)

# --- Constants ---
DEFAULT_TIMEOUT_SEC = 30
DEFAULT_MAX_TOKENS = 4096
OPENCLAW_BASE_URL = "http://127.0.0.1:18789"
TOKEN_ENV_VAR = "OPENCLAW_TOKEN"
CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"

# Exit codes
EXIT_SUCCESS = 0
EXIT_ALL_FAILED = 1
EXIT_CONFIG_ERROR = 2
EXIT_TEST_NO_MODELS = 3


# ---------------------------------------------------------------------------
# Token loading
# ---------------------------------------------------------------------------

def load_token() -> Optional[str]:
    """Load the OpenClaw auth token from env var or config file."""
    # 1. Environment variable (highest priority)
    token = os.environ.get(TOKEN_ENV_VAR)
    if token:
        return token.strip()

    # 2. Config file
    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as fh:
                config = json.load(fh)
            token = (
                config
                .get("gateway", {})
                .get("auth", {})
                .get("token")
            )
            if token:
                return str(token).strip()
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARNING: Could not read config file {CONFIG_PATH}: {exc}", file=sys.stderr)

    return None


# ---------------------------------------------------------------------------
# OpenClaw API helpers
# ---------------------------------------------------------------------------


def _check_ollama_model(model: str, timeout_sec: int) -> bool:
    """
    Check if an Ollama model is reachable.
    Parses 'custom-HOST:PORT/model-name' or 'HOST:PORT/model-name' format.
    """
    # Extract host from model string like 'custom-YOUR-OLLAMA-HOST-PORT/gemma3:12b'
    try:
        if "/" not in model:
            return False
        host_part, model_name = model.split("/", 1)
        # 'custom-YOUR-OLLAMA-HOST-PORT' → 'YOUR-OLLAMA-HOST:11434'
        host_part = host_part.replace("custom-", "")
        # Replace dashes-as-dots pattern: last segment after final dash is port
        parts = host_part.rsplit("-", 1)
        if len(parts) == 2 and parts[1].isdigit():
            ip_dashes, port = parts
            ip = ip_dashes.replace("-", ".")
            ollama_url = f"http://{ip}:{port}"
        else:
            ollama_url = f"http://{host_part.replace('-', '.')}"

        resp = requests.get(f"{ollama_url}/api/tags", timeout=timeout_sec)
        if resp.status_code != 200:
            return False
        tags = resp.json().get("models", [])
        available = [m.get("name", "") for m in tags]
        # Check if model_name matches any available (exact or prefix)
        return any(model_name == a or a.startswith(model_name) for a in available)
    except Exception:
        return False


def try_model(
    model: str,
    prompt: str,
    token: str,
    timeout_sec: int,
    quiet: bool,
) -> Optional[str]:
    """
    Attempt to run a prompt against a single model via OpenClaw CLI.

    Uses: openclaw agent --message <prompt> --agent klin --json
    The model is checked for reachability before running.

    Returns the response text on success, or None on any failure.
    """
    import subprocess

    if not quiet:
        print(f"  → Trying model: {model}", file=sys.stderr)

    start = time.monotonic()

    try:
        result = subprocess.run(
            ["openclaw", "agent", "--message", prompt, "--agent", "klin", "--json"],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env={**os.environ, "OPENCLAW_TOKEN": token} if token else os.environ,
        )
        elapsed = time.monotonic() - start

        if result.returncode != 0:
            if not quiet:
                print(f"  ✗ {model}: CLI error after {elapsed:.1f}s — {result.stderr[:200]}", file=sys.stderr)
            return None

        output = result.stdout.strip()
        if not output:
            if not quiet:
                print(f"  ✗ {model}: empty response after {elapsed:.1f}s", file=sys.stderr)
            return None

        if not quiet:
            print(f"  ✓ {model}: OK ({elapsed:.1f}s)", file=sys.stderr)
        return output

    except subprocess.TimeoutExpired:
        elapsed = time.monotonic() - start
        if not quiet:
            print(f"  ✗ {model}: timeout after {elapsed:.1f}s", file=sys.stderr)
        return None
    except FileNotFoundError:
        if not quiet:
            print(f"  ✗ {model}: 'openclaw' CLI not found in PATH", file=sys.stderr)
        return None
    except Exception as exc:
        elapsed = time.monotonic() - start
        if not quiet:
            print(f"  ✗ {model}: error after {elapsed:.1f}s — {exc}", file=sys.stderr)
        return None


def check_model_reachable(model: str, token: str, timeout_sec: int) -> bool:
    """
    Quick reachability check for a model.
    - For Ollama models (custom-HOST/model): checks /api/tags directly.
    - For cloud models: checks OpenClaw gateway /health endpoint.
    Returns True if reachable, False otherwise.
    """
    # Ollama models
    if model.startswith("custom-") or (":" in model.split("/")[0] if "/" in model else False):
        return _check_ollama_model(model, timeout_sec)

    # Cloud models — check via OpenClaw gateway health
    try:
        resp = requests.get(f"{OPENCLAW_BASE_URL}/health", timeout=5)
        return resp.status_code == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def run_with_fallback(
    models: list[str],
    prompt: str,
    token: str,
    timeout_sec: int,
    max_tokens: int,
    quiet: bool,
) -> tuple[Optional[str], str, int]:
    """
    Try each model in order. Return (result_text, winning_model, attempts).
    result_text is None if all models failed.
    """
    if not quiet:
        print(f"\n[cron-model-fallback] Starting with {len(models)} model(s)", file=sys.stderr)

    for attempt, model in enumerate(models, start=1):
        result = try_model(
            model=model,
            prompt=prompt,
            token=token,
            timeout_sec=timeout_sec,
            quiet=quiet,
        )
        if result is not None:
            if not quiet:
                print(
                    f"\n[cron-model-fallback] ✓ Succeeded with: {model} "
                    f"(attempt {attempt}/{len(models)})",
                    file=sys.stderr,
                )
            return result, model, attempt

    if not quiet:
        print(
            f"\n[cron-model-fallback] ✗ All {len(models)} model(s) failed.",
            file=sys.stderr,
        )
    return None, "", len(models)


def run_test_mode(models: list[str], token: str, timeout_sec: int) -> int:
    """
    Test mode: check which models are reachable. Return exit code.
    """
    print(f"[cron-model-fallback] TEST MODE — checking {len(models)} model(s)\n")
    reachable = []
    unreachable = []

    for model in models:
        print(f"  Checking: {model} ...", end=" ", flush=True)
        ok = check_model_reachable(model, token, timeout_sec)
        if ok:
            print("✓ REACHABLE")
            reachable.append(model)
        else:
            print("✗ UNREACHABLE")
            unreachable.append(model)

    print(f"\nResults: {len(reachable)}/{len(models)} reachable")

    if reachable:
        print(f"First available model: {reachable[0]}")
        return EXIT_SUCCESS
    else:
        print("ERROR: No models reachable. Check OpenClaw gateway and model availability.")
        return EXIT_TEST_NO_MODELS


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Cron model fallback chain for OpenClaw.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run a task with fallback chain
  python3 fallback.py \\
    --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5" \\
    --prompt "Summarize today's news"

  # Use a prompt file
  python3 fallback.py \\
    --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5" \\
    --prompt-file /path/to/task.txt

  # Test which models are available
  python3 fallback.py --test \\
    --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5,google/gemini-flash-1.5"

Authentication:
  Set OPENCLAW_TOKEN env var, or let the script read ~/.openclaw/openclaw.json
        """,
    )

    parser.add_argument(
        "--models",
        type=str,
        required=True,
        help="Comma-separated list of models in priority order (first = most preferred)",
    )
    parser.add_argument(
        "--prompt",
        type=str,
        default=None,
        help="Task prompt string",
    )
    parser.add_argument(
        "--prompt-file",
        type=str,
        default=None,
        metavar="FILE",
        help="Path to file containing the task prompt",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SEC,
        help=f"Seconds to wait per model attempt (default: {DEFAULT_TIMEOUT_SEC})",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help=f"Maximum tokens in the response (default: {DEFAULT_MAX_TOKENS})",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Test mode: check model reachability without running a task",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress progress output; only print the final result",
    )
    parser.add_argument(
        "--base-url",
        type=str,
        default=OPENCLAW_BASE_URL,
        help=f"OpenClaw gateway base URL (default: {OPENCLAW_BASE_URL})",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # Parse model list (strip whitespace, skip empty entries)
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not models:
        print("ERROR: --models must contain at least one model name.", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    # Load auth token
    token = load_token()
    if not token:
        print(
            f"ERROR: No auth token found.\n"
            f"  Set {TOKEN_ENV_VAR} environment variable, or ensure\n"
            f"  {CONFIG_PATH} contains gateway.auth.token",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    # Override base URL if provided
    if args.base_url != OPENCLAW_BASE_URL:
        # Update module-level constant used by check_model_reachable for /health checks
        import sys as _sys
        _sys.modules[__name__].__dict__['OPENCLAW_BASE_URL'] = args.base_url

    # --- TEST MODE ---
    if args.test:
        return run_test_mode(models, token, args.timeout)

    # --- NORMAL MODE ---
    # Resolve prompt
    prompt: Optional[str] = None

    if args.prompt_file:
        prompt_path = Path(args.prompt_file)
        if not prompt_path.exists():
            print(f"ERROR: Prompt file not found: {prompt_path}", file=sys.stderr)
            return EXIT_CONFIG_ERROR
        try:
            prompt = prompt_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            print(f"ERROR: Could not read prompt file: {exc}", file=sys.stderr)
            return EXIT_CONFIG_ERROR

    elif args.prompt:
        prompt = args.prompt.strip()

    if not prompt:
        print(
            "ERROR: Provide a task via --prompt or --prompt-file.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    # Run with fallback chain
    result, winning_model, attempts = run_with_fallback(
        models=models,
        prompt=prompt,
        token=token,
        timeout_sec=args.timeout,
        quiet=args.quiet,
    )

    if result is None:
        print(
            f"ERROR: All models failed after {attempts} attempt(s). "
            f"Models tried: {', '.join(models)}",
            file=sys.stderr,
        )
        return EXIT_ALL_FAILED

    # Print result to stdout (clean, for piping / log capture)
    print(result)
    return EXIT_SUCCESS


if __name__ == "__main__":
    sys.exit(main())
