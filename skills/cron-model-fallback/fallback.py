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
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:
    print("ERROR: 'requests' library not found. Install with: pip3 install requests", file=sys.stderr)
    sys.exit(2)

# --- Constants ---
DEFAULT_TIMEOUT_SEC = 120
DEFAULT_MAX_TOKENS = 4096
DEFAULT_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "http://127.0.0.1:18789")
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
    token = os.environ.get(TOKEN_ENV_VAR)
    if token:
        return token.strip()

    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as fh:
                config = json.load(fh)
            token = str(
                config
                .get("gateway", {})
                .get("auth", {})
                .get("token", "")
            )
            if token:
                return token.strip()
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARNING: Could not read config file {CONFIG_PATH}: {exc}", file=sys.stderr)

    return None


# ---------------------------------------------------------------------------
# OpenClaw API helpers
# ---------------------------------------------------------------------------

def _check_ollama_model(model: str, timeout_sec: int) -> bool:
    """
    Check if an Ollama model is reachable.
    Parses 'custom-HOST-PORT/model-name' format.

    Examples:
        custom-192-168-7-194-11434/gemma3:12b  → http://192.168.7.194:11434
        custom-localhost-11434/gemma3:12b       → http://localhost:11434
    """
    try:
        if "/" not in model:
            return False
        host_part, model_name = model.split("/", 1)
        host_part = host_part.replace("custom-", "")
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
        return any(model_name == a or a.startswith(model_name) for a in available)
    except Exception:
        return False


def check_model_reachable(model: str, base_url: str, timeout_sec: int) -> bool:
    """
    Quick reachability check for a model.
    - For Ollama models (custom-HOST/model): checks /api/tags directly.
    - For cloud models: checks OpenClaw gateway /health endpoint.
    """
    if model.startswith("custom-") or (":" in model.split("/")[0] if "/" in model else False):
        return _check_ollama_model(model, timeout_sec)

    try:
        resp = requests.get(f"{base_url}/health", timeout=5)
        return resp.status_code == 200
    except Exception:
        return False


def try_model(
    model: str,
    prompt: str,
    token: str,
    agent: str,
    base_url: str,
    timeout_sec: int,
    max_tokens: int,
    quiet: bool,
) -> Optional[str]:
    """
    Attempt to run a prompt against a single model via OpenClaw CLI.

    The model is passed explicitly via --model flag so the fallback chain
    actually switches between providers.

    Returns the response text on success, or None on any failure.
    """
    if not quiet:
        print(f"  → Trying model: {model}", file=sys.stderr)

    start = time.monotonic()

    try:
        cmd = [
            "openclaw", "agent",
            "--message", prompt,
            "--model", model,
            "--max-tokens", str(max_tokens),
            "--json",
        ]
        if agent:
            cmd.extend(["--agent", agent])

        env = {**os.environ, TOKEN_ENV_VAR: token} if token else dict(os.environ)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
        )
        elapsed = time.monotonic() - start

        if result.returncode != 0:
            if not quiet:
                stderr_preview = result.stderr[:200].strip()
                print(f"  ✗ {model}: CLI error after {elapsed:.1f}s — {stderr_preview}", file=sys.stderr)
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


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def run_with_fallback(
    models: list[str],
    prompt: str,
    token: str,
    agent: str,
    base_url: str,
    timeout_sec: int,
    max_tokens: int,
    quiet: bool,
    skip_reachability: bool = False,
) -> tuple[Optional[str], str, int]:
    """
    Try each model in order. Return (result_text, winning_model, attempts).
    result_text is None if all models failed.

    By default, checks reachability before attempting each model to save time.
    """
    if not quiet:
        print(f"\n[cron-model-fallback] Starting with {len(models)} model(s)", file=sys.stderr)

    for attempt, model in enumerate(models, start=1):
        # Pre-check reachability to skip known-unreachable models fast
        if not skip_reachability:
            reachable = check_model_reachable(model, base_url, min(timeout_sec, 10))
            if not reachable:
                if not quiet:
                    print(f"  ⊘ {model}: unreachable, skipping", file=sys.stderr)
                continue

        result = try_model(
            model=model,
            prompt=prompt,
            token=token,
            agent=agent,
            base_url=base_url,
            timeout_sec=timeout_sec,
            max_tokens=max_tokens,
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


def run_test_mode(models: list[str], base_url: str, timeout_sec: int) -> int:
    """Test mode: check which models are reachable. Return exit code."""
    print(f"[cron-model-fallback] TEST MODE — checking {len(models)} model(s)\n")
    reachable = []
    unreachable = []

    for model in models:
        print(f"  Checking: {model} ...", end=" ", flush=True)
        ok = check_model_reachable(model, base_url, timeout_sec)
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
        epilog="""\
Examples:
  # Run a task with fallback chain
  python3 fallback.py \\
    --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5" \\
    --prompt "Summarize today's news"

  # Use a specific agent
  python3 fallback.py \\
    --models "ollama/gemma3:27b,google/gemini-2.5-flash" \\
    --agent my-agent --prompt "Your task"

  # Test which models are available
  python3 fallback.py --test \\
    --models "ollama/gemma3:27b,anthropic/claude-haiku-4-5,google/gemini-flash-1.5"

Authentication:
  Set OPENCLAW_TOKEN env var, or let the script read ~/.openclaw/openclaw.json
        """,
    )

    parser.add_argument(
        "--models", type=str, required=True,
        help="Comma-separated list of models in priority order (first = most preferred)",
    )
    parser.add_argument(
        "--prompt", type=str, default=None,
        help="Task prompt string",
    )
    parser.add_argument(
        "--prompt-file", type=str, default=None, metavar="FILE",
        help="Path to file containing the task prompt",
    )
    parser.add_argument(
        "--agent", type=str, default=None,
        help="OpenClaw agent name (optional — uses default agent if omitted)",
    )
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT_SEC,
        help=f"Seconds to wait per model attempt (default: {DEFAULT_TIMEOUT_SEC})",
    )
    parser.add_argument(
        "--max-tokens", type=int, default=DEFAULT_MAX_TOKENS,
        help=f"Maximum tokens in the response (default: {DEFAULT_MAX_TOKENS})",
    )
    parser.add_argument(
        "--test", action="store_true",
        help="Test mode: check model reachability without running a task",
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Suppress progress output; only print the final result",
    )
    parser.add_argument(
        "--skip-reachability", action="store_true",
        help="Skip pre-check reachability (just try each model directly)",
    )
    parser.add_argument(
        "--base-url", type=str, default=DEFAULT_BASE_URL,
        help=f"OpenClaw gateway base URL (default: from OPENCLAW_BASE_URL env or localhost:18789)",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # Parse model list
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

    # --- TEST MODE ---
    if args.test:
        return run_test_mode(models, args.base_url, args.timeout)

    # --- NORMAL MODE ---
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
        print("ERROR: Provide a task via --prompt or --prompt-file.", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    result, winning_model, attempts = run_with_fallback(
        models=models,
        prompt=prompt,
        token=token,
        agent=args.agent or "",
        base_url=args.base_url,
        timeout_sec=args.timeout,
        max_tokens=args.max_tokens,
        quiet=args.quiet,
        skip_reachability=args.skip_reachability,
    )

    if result is None:
        print(
            f"ERROR: All models failed after {attempts} attempt(s). "
            f"Models tried: {', '.join(models)}",
            file=sys.stderr,
        )
        return EXIT_ALL_FAILED

    print(result)
    return EXIT_SUCCESS


if __name__ == "__main__":
    sys.exit(main())
