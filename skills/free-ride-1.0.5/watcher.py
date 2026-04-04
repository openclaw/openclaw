#!/usr/bin/env python3
"""
FreeRide Watcher
Monitors for rate limits and automatically rotates models.
Can run as a daemon or be called periodically via cron.
"""

import json
import os
import sys
import time
import signal
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

try:
    import requests
except ImportError:
    print("Error: requests library required")
    sys.exit(1)


# Import from main module
from main import (
    get_api_key,
    get_free_models,
    load_openclaw_config,
    save_openclaw_config,
    ensure_config_structure,
    format_model_for_openclaw,
    OPENCLAW_CONFIG_PATH
)


# Constants
STATE_FILE = Path.home() / ".openclaw" / ".freeride-watcher-state.json"
RATE_LIMIT_COOLDOWN_MINUTES = 30
CHECK_INTERVAL_SECONDS = 60
OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


def load_state() -> dict:
    """Load watcher state."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    return {"rate_limited_models": {}, "rotation_count": 0}


def save_state(state: dict):
    """Save watcher state."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def is_model_rate_limited(state: dict, model_id: str) -> bool:
    """Check if a model is currently in rate-limit cooldown."""
    rate_limited = state.get("rate_limited_models", {})
    if model_id not in rate_limited:
        return False

    limited_at = datetime.fromisoformat(rate_limited[model_id])
    cooldown_end = limited_at + timedelta(minutes=RATE_LIMIT_COOLDOWN_MINUTES)
    return datetime.now() < cooldown_end


def mark_rate_limited(state: dict, model_id: str):
    """Mark a model as rate limited."""
    if "rate_limited_models" not in state:
        state["rate_limited_models"] = {}
    state["rate_limited_models"][model_id] = datetime.now().isoformat()
    save_state(state)


def test_model(api_key: str, model_id: str) -> tuple[bool, Optional[str]]:
    """
    Test if a model is available by making a minimal API call.
    Returns (success, error_type).
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Shaivpidadi/FreeRide",
        "X-Title": "FreeRide Health Check"
    }

    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 5,
        "stream": False
    }

    try:
        response = requests.post(
            OPENROUTER_CHAT_URL,
            headers=headers,
            json=payload,
            timeout=30
        )

        if response.status_code == 200:
            return True, None
        elif response.status_code == 429:
            return False, "rate_limit"
        elif response.status_code == 503:
            return False, "unavailable"
        else:
            return False, f"error_{response.status_code}"

    except requests.Timeout:
        return False, "timeout"
    except requests.RequestException as e:
        return False, "request_error"


def get_next_available_model(api_key: str, state: dict, exclude_model: str = None) -> Optional[str]:
    """Get the next best model that isn't rate limited."""
    models = get_free_models(api_key)

    for model in models:
        model_id = model["id"]

        # Skip the openrouter/free router - we want specific models
        if "openrouter/free" in model_id:
            continue

        # Skip if same as excluded model
        if exclude_model and model_id == exclude_model:
            continue

        # Skip if in cooldown
        if is_model_rate_limited(state, model_id):
            continue

        # Test if actually available
        success, error = test_model(api_key, model_id)
        if success:
            return model_id

        # Mark as rate limited if that's the error
        if error == "rate_limit":
            mark_rate_limited(state, model_id)

    return None


def rotate_to_next_model(api_key: str, state: dict, reason: str = "manual"):
    """Rotate to the next available model."""
    config = load_openclaw_config()
    config = ensure_config_structure(config)
    current = config.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")

    # Extract base model ID from OpenClaw format
    current_base = None
    if current:
        # openrouter/provider/model:free -> provider/model:free
        if current.startswith("openrouter/"):
            current_base = current[len("openrouter/"):]
        else:
            current_base = current

    print(f"[{datetime.now().isoformat()}] Rotating from: {current_base or 'none'}")
    print(f"  Reason: {reason}")

    next_model = get_next_available_model(api_key, state, current_base)

    if not next_model:
        print("  Error: No available models found!")
        return False

    print(f"  New model: {next_model}")

    # Update config - primary uses provider prefix, fallbacks don't
    formatted_primary = format_model_for_openclaw(next_model, with_provider_prefix=True)
    config["agents"]["defaults"]["model"]["primary"] = formatted_primary

    # Add to models allowlist
    formatted_for_list = format_model_for_openclaw(next_model, with_provider_prefix=False)
    config["agents"]["defaults"]["models"][formatted_for_list] = {}

    # Rebuild fallbacks from remaining models (using correct format: no provider prefix)
    models = get_free_models(api_key)
    fallbacks = []

    # Always add openrouter/free as first fallback
    free_router = "openrouter/free"
    fallbacks.append(free_router)
    config["agents"]["defaults"]["models"][free_router] = {}

    for m in models:
        if m["id"] == next_model or "openrouter/free" in m["id"]:
            continue
        if is_model_rate_limited(state, m["id"]):
            continue

        fb_formatted = format_model_for_openclaw(m["id"], with_provider_prefix=False)
        fallbacks.append(fb_formatted)
        config["agents"]["defaults"]["models"][fb_formatted] = {}

        if len(fallbacks) >= 5:
            break

    config["agents"]["defaults"]["model"]["fallbacks"] = fallbacks

    save_openclaw_config(config)

    # Update state
    state["rotation_count"] = state.get("rotation_count", 0) + 1
    state["last_rotation"] = datetime.now().isoformat()
    state["last_rotation_reason"] = reason
    save_state(state)

    print(f"  Success! Rotated to {next_model}")
    print(f"  Total rotations this session: {state['rotation_count']}")

    return True


def check_and_rotate(api_key: str, state: dict) -> bool:
    """Check current model and rotate if needed."""
    config = load_openclaw_config()
    current = config.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")

    if not current:
        print("No primary model configured. Running initial setup...")
        return rotate_to_next_model(api_key, state, "initial_setup")

    # Extract base model ID
    if current.startswith("openrouter/"):
        current_base = current[len("openrouter/"):]
    else:
        current_base = current

    # Check if current model is rate limited
    if is_model_rate_limited(state, current_base):
        return rotate_to_next_model(api_key, state, "cooldown_active")

    # Test current model
    print(f"[{datetime.now().isoformat()}] Testing: {current_base}")
    success, error = test_model(api_key, current_base)

    if success:
        print(f"  Status: OK")
        return False  # No rotation needed
    else:
        print(f"  Status: {error}")
        if error == "rate_limit":
            mark_rate_limited(state, current_base)
        return rotate_to_next_model(api_key, state, error)


def cleanup_old_rate_limits(state: dict):
    """Remove rate limit entries that have expired."""
    rate_limited = state.get("rate_limited_models", {})
    current_time = datetime.now()
    expired = []

    for model_id, limited_at_str in rate_limited.items():
        try:
            limited_at = datetime.fromisoformat(limited_at_str)
            if current_time - limited_at > timedelta(minutes=RATE_LIMIT_COOLDOWN_MINUTES):
                expired.append(model_id)
        except (ValueError, TypeError):
            expired.append(model_id)

    for model_id in expired:
        del rate_limited[model_id]
        print(f"  Cleared cooldown: {model_id}")

    if expired:
        save_state(state)


def run_once():
    """Run a single check and rotate cycle."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    state = load_state()
    cleanup_old_rate_limits(state)
    check_and_rotate(api_key, state)


def run_daemon():
    """Run as a continuous daemon."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    print(f"FreeRide Watcher started")
    print(f"Check interval: {CHECK_INTERVAL_SECONDS}s")
    print(f"Rate limit cooldown: {RATE_LIMIT_COOLDOWN_MINUTES}m")
    print("-" * 50)

    # Handle graceful shutdown
    running = True
    def signal_handler(signum, frame):
        nonlocal running
        print("\nShutting down watcher...")
        running = False

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    state = load_state()

    while running:
        try:
            cleanup_old_rate_limits(state)
            check_and_rotate(api_key, state)
        except Exception as e:
            print(f"Error during check: {e}")

        # Sleep in small increments to allow graceful shutdown
        for _ in range(CHECK_INTERVAL_SECONDS):
            if not running:
                break
            time.sleep(1)

    print("Watcher stopped.")


def main():
    import argparse

    parser = argparse.ArgumentParser(
        prog="freeride-watcher",
        description="FreeRide Watcher - Monitor and auto-rotate free AI models"
    )
    parser.add_argument("--daemon", "-d", action="store_true",
                       help="Run as continuous daemon")
    parser.add_argument("--rotate", "-r", action="store_true",
                       help="Force rotate to next model")
    parser.add_argument("--status", "-s", action="store_true",
                       help="Show watcher status")
    parser.add_argument("--clear-cooldowns", action="store_true",
                       help="Clear all rate limit cooldowns")

    args = parser.parse_args()

    if args.status:
        state = load_state()
        print("FreeRide Watcher Status")
        print("=" * 40)
        print(f"Total rotations: {state.get('rotation_count', 0)}")
        print(f"Last rotation: {state.get('last_rotation', 'Never')}")
        print(f"Last reason: {state.get('last_rotation_reason', 'N/A')}")
        print(f"\nModels in cooldown:")
        for model, limited_at in state.get("rate_limited_models", {}).items():
            print(f"  - {model} (since {limited_at})")
        if not state.get("rate_limited_models"):
            print("  None")

    elif args.clear_cooldowns:
        state = load_state()
        state["rate_limited_models"] = {}
        save_state(state)
        print("Cleared all rate limit cooldowns.")

    elif args.rotate:
        api_key = get_api_key()
        if not api_key:
            print("Error: OPENROUTER_API_KEY not set")
            sys.exit(1)
        state = load_state()
        rotate_to_next_model(api_key, state, "manual_rotation")

    elif args.daemon:
        run_daemon()

    else:
        run_once()


if __name__ == "__main__":
    main()