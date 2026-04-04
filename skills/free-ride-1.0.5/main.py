#!/usr/bin/env python3
"""
FreeRide - Free AI for OpenClaw
Automatically manage and switch between free AI models on OpenRouter
for unlimited free AI access.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

try:
    import requests
except ImportError:
    print("Error: requests library required. Install with: pip install requests")
    sys.exit(1)


# Constants
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models"
OPENCLAW_CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"
CACHE_FILE = Path.home() / ".openclaw" / ".freeride-cache.json"
CACHE_DURATION_HOURS = 6

# Free model ranking criteria (higher is better)
RANKING_WEIGHTS = {
    "context_length": 0.4,      # Prefer longer context
    "capabilities": 0.3,        # Prefer more capabilities
    "recency": 0.2,            # Prefer newer models
    "provider_trust": 0.1       # Prefer trusted providers
}

# Trusted providers (in order of preference)
TRUSTED_PROVIDERS = [
    "google", "meta-llama", "mistralai", "deepseek",
    "nvidia", "qwen", "microsoft", "allenai", "arcee-ai"
]


def get_api_key() -> Optional[str]:
    """Get OpenRouter API key from environment or OpenClaw config."""
    # Try environment first
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if api_key:
        return api_key

    # Try OpenClaw config
    if OPENCLAW_CONFIG_PATH.exists():
        try:
            config = json.loads(OPENCLAW_CONFIG_PATH.read_text())
            # Check env section
            api_key = config.get("env", {}).get("OPENROUTER_API_KEY")
            if api_key:
                return api_key
        except (json.JSONDecodeError, KeyError):
            pass

    return None


def fetch_all_models(api_key: str) -> list:
    """Fetch all models from OpenRouter API."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.get(OPENROUTER_API_URL, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()
        return data.get("data", [])
    except requests.RequestException as e:
        print(f"Error fetching models: {e}")
        return []


def filter_free_models(models: list) -> list:
    """Filter models to only include free ones (pricing.prompt == 0)."""
    free_models = []

    for model in models:
        model_id = model.get("id", "")
        pricing = model.get("pricing", {})

        # Check if model is free (prompt cost is 0 or None)
        prompt_cost = pricing.get("prompt")
        if prompt_cost is not None:
            try:
                if float(prompt_cost) == 0:
                    free_models.append(model)
            except (ValueError, TypeError):
                pass

        # Also include models with :free suffix
        if ":free" in model_id and model not in free_models:
            free_models.append(model)

    return free_models


def calculate_model_score(model: dict) -> float:
    """Calculate a ranking score for a model based on multiple criteria."""
    score = 0.0

    # Context length score (normalized to 0-1, max 1M tokens)
    context_length = model.get("context_length", 0)
    context_score = min(context_length / 1_000_000, 1.0)
    score += context_score * RANKING_WEIGHTS["context_length"]

    # Capabilities score
    capabilities = model.get("supported_parameters", [])
    capability_count = len(capabilities) if capabilities else 0
    capability_score = min(capability_count / 10, 1.0)  # Normalize to max 10 capabilities
    score += capability_score * RANKING_WEIGHTS["capabilities"]

    # Recency score (based on creation date)
    created = model.get("created", 0)
    if created:
        days_old = (time.time() - created) / 86400
        recency_score = max(0, 1 - (days_old / 365))  # Newer models score higher
        score += recency_score * RANKING_WEIGHTS["recency"]

    # Provider trust score
    model_id = model.get("id", "")
    provider = model_id.split("/")[0] if "/" in model_id else ""
    if provider in TRUSTED_PROVIDERS:
        trust_index = TRUSTED_PROVIDERS.index(provider)
        trust_score = 1 - (trust_index / len(TRUSTED_PROVIDERS))
        score += trust_score * RANKING_WEIGHTS["provider_trust"]

    return score


def rank_free_models(models: list) -> list:
    """Rank free models by quality score."""
    scored_models = []
    for model in models:
        score = calculate_model_score(model)
        scored_models.append({**model, "_score": score})

    # Sort by score descending
    scored_models.sort(key=lambda x: x["_score"], reverse=True)
    return scored_models


def get_cached_models() -> Optional[list]:
    """Get cached model list if still valid."""
    if not CACHE_FILE.exists():
        return None

    try:
        cache = json.loads(CACHE_FILE.read_text())
        cached_at = datetime.fromisoformat(cache.get("cached_at", ""))
        if datetime.now() - cached_at < timedelta(hours=CACHE_DURATION_HOURS):
            return cache.get("models", [])
    except (json.JSONDecodeError, ValueError):
        pass

    return None


def save_models_cache(models: list):
    """Save models to cache file."""
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cache = {
        "cached_at": datetime.now().isoformat(),
        "models": models
    }
    CACHE_FILE.write_text(json.dumps(cache, indent=2))


def get_free_models(api_key: str, force_refresh: bool = False) -> list:
    """Get ranked free models (from cache or API)."""
    if not force_refresh:
        cached = get_cached_models()
        if cached:
            return cached

    all_models = fetch_all_models(api_key)
    free_models = filter_free_models(all_models)
    ranked_models = rank_free_models(free_models)

    save_models_cache(ranked_models)
    return ranked_models


def load_openclaw_config() -> dict:
    """Load OpenClaw configuration."""
    if not OPENCLAW_CONFIG_PATH.exists():
        return {}

    try:
        return json.loads(OPENCLAW_CONFIG_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def save_openclaw_config(config: dict):
    """Save OpenClaw configuration."""
    OPENCLAW_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    OPENCLAW_CONFIG_PATH.write_text(json.dumps(config, indent=2))


def format_model_for_openclaw(model_id: str, with_provider_prefix: bool = True, append_free: bool = True) -> str:
    """Format model ID for OpenClaw config.

    OpenClaw uses two formats:
    - Primary model: "openrouter/<author>/<model>:free" (with provider prefix)
    - Fallbacks/models list: "<author>/<model>:free" (without prefix sometimes)
    """
    base_id = model_id

    # Handle openrouter/free special case: "openrouter" is both the routing 
    # prefix OpenClaw adds AND the actual provider name in the API model ID.
    # The API model ID is "openrouter/free" (no :free suffix — it's a router, not a free-tier model).
    #   - with prefix:    "openrouter/openrouter/free" (routing prefix + API ID)
    #   - without prefix: "openrouter/free" (just the API ID)
    if model_id in ("openrouter/free", "openrouter/free:free"):
        if with_provider_prefix:
            return "openrouter/openrouter/free"
        return "openrouter/free"

    # Remove existing openrouter/ routing prefix if present to get the base API ID
    if base_id.startswith("openrouter/"):
        base_id = base_id[len("openrouter/"):]

    # Ensure :free suffix
    if append_free and ":free" not in base_id:
        base_id = f"{base_id}:free"

    if with_provider_prefix:
        return f"openrouter/{base_id}"
    return base_id


def get_current_model(config: dict = None) -> Optional[str]:
    """Get currently configured model in OpenClaw."""
    if config is None:
        config = load_openclaw_config()
    return config.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")


def get_current_fallbacks(config: dict = None) -> list:
    """Get currently configured fallback models."""
    if config is None:
        config = load_openclaw_config()
    return config.get("agents", {}).get("defaults", {}).get("model", {}).get("fallbacks", [])


def ensure_config_structure(config: dict) -> dict:
    """Ensure the config has the required nested structure without overwriting existing values."""
    if "agents" not in config:
        config["agents"] = {}
    if "defaults" not in config["agents"]:
        config["agents"]["defaults"] = {}
    if "model" not in config["agents"]["defaults"]:
        config["agents"]["defaults"]["model"] = {}
    if "models" not in config["agents"]["defaults"]:
        config["agents"]["defaults"]["models"] = {}
    return config


def setup_openrouter_auth(config: dict) -> dict:
    """Set up OpenRouter auth profile if not exists."""
    if "auth" not in config:
        config["auth"] = {}
    if "profiles" not in config["auth"]:
        config["auth"]["profiles"] = {}

    if "openrouter:default" not in config["auth"]["profiles"]:
        config["auth"]["profiles"]["openrouter:default"] = {
            "provider": "openrouter",
            "mode": "api_key"
        }
        print("Added OpenRouter auth profile.")

    return config


def update_model_config(
    model_id: str,
    as_primary: bool = True,
    add_fallbacks: bool = True,
    fallback_count: int = 5,
    setup_auth: bool = False,
    append_free: bool = True
) -> bool:
    """Update OpenClaw config with the specified model.

    Args:
        model_id: The model ID to configure
        as_primary: If True, set as primary model. If False, only add to fallbacks.
        add_fallbacks: If True, also configure fallback models
        fallback_count: Number of fallback models to add
        setup_auth: If True, also set up OpenRouter auth profile
    """
    config = load_openclaw_config()
    config = ensure_config_structure(config)

    if setup_auth:
        config = setup_openrouter_auth(config)

    formatted_primary = format_model_for_openclaw(model_id, with_provider_prefix=True, append_free=append_free)
    formatted_for_list = format_model_for_openclaw(model_id, with_provider_prefix=False, append_free=append_free)

    if as_primary:
        # Set as primary model
        config["agents"]["defaults"]["model"]["primary"] = formatted_primary
        # Add to models allowlist
        config["agents"]["defaults"]["models"][formatted_for_list] = {}

    # Handle fallbacks
    if add_fallbacks:
        api_key = get_api_key()
        if api_key:
            free_models = get_free_models(api_key)

            # Get existing fallbacks
            existing_fallbacks = config["agents"]["defaults"]["model"].get("fallbacks", [])

            # Build new fallbacks list
            new_fallbacks = []

            # Always add openrouter/free as first fallback (smart router)
            # Skip if it's being set as primary
            free_router = "openrouter/free"
            free_router_primary = format_model_for_openclaw("openrouter/free", with_provider_prefix=True)
            if formatted_primary != free_router_primary and formatted_for_list != free_router:
                new_fallbacks.append(free_router)
                config["agents"]["defaults"]["models"][free_router] = {}

            for m in free_models:
                # Reserve one slot for openrouter/free
                if len(new_fallbacks) >= fallback_count:
                    break

                m_formatted = format_model_for_openclaw(m["id"], with_provider_prefix=False)
                m_formatted_primary = format_model_for_openclaw(m["id"], with_provider_prefix=True)

                # Skip openrouter/free (already added as first)
                if "openrouter/free" in m["id"]:
                    continue

                # Skip if it's the new primary
                if as_primary and (m_formatted == formatted_for_list or m_formatted_primary == formatted_primary):
                    continue

                # Skip if it's the current primary (when adding to fallbacks only)
                current_primary = config["agents"]["defaults"]["model"].get("primary", "")
                if not as_primary and m_formatted_primary == current_primary:
                    continue

                new_fallbacks.append(m_formatted)
                config["agents"]["defaults"]["models"][m_formatted] = {}

            # If not setting as primary, prepend new model to fallbacks (after openrouter/free)
            if not as_primary:
                if formatted_for_list not in new_fallbacks:
                    # Insert after openrouter/free if present
                    insert_pos = 1 if free_router in new_fallbacks else 0
                    new_fallbacks.insert(insert_pos, formatted_for_list)
                config["agents"]["defaults"]["models"][formatted_for_list] = {}

            config["agents"]["defaults"]["model"]["fallbacks"] = new_fallbacks

    save_openclaw_config(config)
    return True


# ============== Command Handlers ==============

def cmd_list(args):
    """List available free models ranked by quality."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        print("Set it via: export OPENROUTER_API_KEY='sk-or-...'")
        print("Or get a free key at: https://openrouter.ai/keys")
        sys.exit(1)

    print("Fetching free models from OpenRouter...")
    models = get_free_models(api_key, force_refresh=args.refresh)

    if not models:
        print("No free models available.")
        return

    current = get_current_model()
    fallbacks = get_current_fallbacks()
    limit = args.limit if args.limit else 15

    print(f"\nTop {min(limit, len(models))} Free AI Models (ranked by quality):\n")
    print(f"{'#':<3} {'Model ID':<50} {'Context':<12} {'Score':<8} {'Status'}")
    print("-" * 90)

    for i, model in enumerate(models[:limit], 1):
        model_id = model.get("id", "unknown")
        context = model.get("context_length", 0)
        score = model.get("_score", 0)

        # Format context length
        if context >= 1_000_000:
            context_str = f"{context // 1_000_000}M tokens"
        elif context >= 1_000:
            context_str = f"{context // 1_000}K tokens"
        else:
            context_str = f"{context} tokens"

        # Check status
        formatted = format_model_for_openclaw(model_id, with_provider_prefix=True)
        formatted_fallback = format_model_for_openclaw(model_id, with_provider_prefix=False)

        if current and formatted == current:
            status = "[PRIMARY]"
        elif formatted_fallback in fallbacks or formatted in fallbacks:
            status = "[FALLBACK]"
        else:
            status = ""

        print(f"{i:<3} {model_id:<50} {context_str:<12} {score:.3f}    {status}")

    if len(models) > limit:
        print(f"\n... and {len(models) - limit} more. Use --limit to see more.")

    print(f"\nTotal free models available: {len(models)}")
    print("\nCommands:")
    print("  freeride switch <model>      Set as primary model")
    print("  freeride switch <model> -f   Add to fallbacks only (keep current primary)")
    print("  freeride auto                Auto-select best model")


def cmd_switch(args):
    """Switch to a specific free model."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    model_id = args.model
    as_fallback = args.fallback_only

    # Validate model exists and is free
    models = get_free_models(api_key)
    model_ids = [m["id"] for m in models]

    # Check for exact match or partial match
    matched_model = None
    if model_id in model_ids:
        matched_model = model_id
    else:
        # Try partial match
        for m_id in model_ids:
            if model_id.lower() in m_id.lower():
                matched_model = m_id
                break

    if not matched_model:
        print(f"Error: Model '{model_id}' not found in free models list.")
        print("Use 'freeride list' to see available models.")
        sys.exit(1)

    if as_fallback:
        print(f"Adding to fallbacks: {matched_model}")
    else:
        print(f"Setting as primary: {matched_model}")

    if update_model_config(
        matched_model,
        as_primary=not as_fallback,
        add_fallbacks=not args.no_fallbacks,
        setup_auth=args.setup_auth,
        append_free=False
    ):
        config = load_openclaw_config()

        if as_fallback:
            print("Success! Added to fallbacks.")
            print(f"Primary model (unchanged): {get_current_model(config)}")
        else:
            print("Success! OpenClaw config updated.")
            print(f"Primary model: {get_current_model(config)}")

        fallbacks = get_current_fallbacks(config)
        if fallbacks:
            print(f"Fallback models ({len(fallbacks)}):")
            for fb in fallbacks[:5]:
                print(f"  - {fb}")
            if len(fallbacks) > 5:
                print(f"  ... and {len(fallbacks) - 5} more")

        print("\nRestart OpenClaw for changes to take effect.")
    else:
        print("Error: Failed to update OpenClaw config.")
        sys.exit(1)


def cmd_auto(args):
    """Automatically select the best free model."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    config = load_openclaw_config()
    current_primary = get_current_model(config)

    print("Finding best free model...")
    models = get_free_models(api_key, force_refresh=True)

    if not models:
        print("Error: No free models available.")
        sys.exit(1)

    # Find best SPECIFIC model (skip openrouter/free router)
    # openrouter/free is a router, not a specific model - use it as fallback only
    best_model = None
    for m in models:
        if "openrouter/free" not in m["id"]:
            best_model = m
            break

    if not best_model:
        # Fallback to first model if all are routers (unlikely)
        best_model = models[0]

    model_id = best_model["id"]
    context = best_model.get("context_length", 0)
    score = best_model.get("_score", 0)

    # Determine if we should change primary or just add fallbacks
    as_fallback = args.fallback_only

    if not as_fallback:
        if current_primary:
            print(f"\nReplacing current primary: {current_primary}")
        print(f"\nBest free model: {model_id}")
        print(f"Context length: {context:,} tokens")
        print(f"Quality score: {score:.3f}")
    else:
        print(f"\nKeeping current primary, adding fallbacks only.")
        print(f"Best available: {model_id} ({context:,} tokens, score: {score:.3f})")

    if update_model_config(
        model_id,
        as_primary=not as_fallback,
        add_fallbacks=True,
        fallback_count=args.fallback_count,
        setup_auth=args.setup_auth
    ):
        config = load_openclaw_config()

        if as_fallback:
            print("\nFallbacks configured!")
            print(f"Primary (unchanged): {get_current_model(config)}")
            print("First fallback: openrouter/free (smart router - auto-selects best available)")
        else:
            print("\nOpenClaw config updated!")
            print(f"Primary: {get_current_model(config)}")

        fallbacks = get_current_fallbacks(config)
        if fallbacks:
            print(f"Fallbacks ({len(fallbacks)}):")
            for fb in fallbacks:
                print(f"  - {fb}")

        print("\nRestart OpenClaw for changes to take effect.")
    else:
        print("Error: Failed to update config.")
        sys.exit(1)


def cmd_status(args):
    """Show current configuration status."""
    api_key = get_api_key()
    config = load_openclaw_config()
    current = get_current_model(config)
    fallbacks = get_current_fallbacks(config)

    print("FreeRide Status")
    print("=" * 50)

    # API Key status
    if api_key:
        masked = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else "***"
        print(f"OpenRouter API Key: {masked}")
    else:
        print("OpenRouter API Key: NOT SET")
        print("  Set with: export OPENROUTER_API_KEY='sk-or-...'")

    # Auth profile status
    auth_profiles = config.get("auth", {}).get("profiles", {})
    if "openrouter:default" in auth_profiles:
        print("OpenRouter Auth Profile: Configured")
    else:
        print("OpenRouter Auth Profile: Not set (use --setup-auth to add)")

    # Current model
    print(f"\nPrimary Model: {current or 'Not configured'}")

    # Fallbacks
    if fallbacks:
        print(f"Fallback Models ({len(fallbacks)}):")
        for fb in fallbacks:
            print(f"  - {fb}")
    else:
        print("Fallback Models: None configured")

    # Cache status
    if CACHE_FILE.exists():
        try:
            cache = json.loads(CACHE_FILE.read_text())
            cached_at = datetime.fromisoformat(cache.get("cached_at", ""))
            models_count = len(cache.get("models", []))
            age = datetime.now() - cached_at
            hours = age.seconds // 3600
            mins = (age.seconds % 3600) // 60
            print(f"\nModel Cache: {models_count} models (updated {hours}h {mins}m ago)")
        except:
            print("\nModel Cache: Invalid")
    else:
        print("\nModel Cache: Not created yet")

    # OpenClaw config path
    print(f"\nOpenClaw Config: {OPENCLAW_CONFIG_PATH}")
    print(f"  Exists: {'Yes' if OPENCLAW_CONFIG_PATH.exists() else 'No'}")


def cmd_refresh(args):
    """Force refresh the model cache."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    print("Refreshing free models cache...")
    models = get_free_models(api_key, force_refresh=True)
    print(f"Cached {len(models)} free models.")
    print(f"Cache expires in {CACHE_DURATION_HOURS} hours.")


def cmd_fallbacks(args):
    """Configure fallback models for rate limit handling."""
    api_key = get_api_key()
    if not api_key:
        print("Error: OPENROUTER_API_KEY not set")
        sys.exit(1)

    config = load_openclaw_config()
    current = get_current_model(config)

    if not current:
        print("Warning: No primary model configured.")
        print("Fallbacks will still be added.")

    print(f"Current primary: {current or 'None'}")
    print(f"Setting up {args.count} fallback models...")

    models = get_free_models(api_key)
    config = ensure_config_structure(config)

    # Get fallbacks excluding current model
    fallbacks = []

    # Always add openrouter/free as first fallback (smart router)
    free_router = "openrouter/free"
    free_router_primary = format_model_for_openclaw("openrouter/free", with_provider_prefix=True)
    if not current or current != free_router_primary:
        fallbacks.append(free_router)
        config["agents"]["defaults"]["models"][free_router] = {}

    for m in models:
        formatted = format_model_for_openclaw(m["id"], with_provider_prefix=False)
        formatted_primary = format_model_for_openclaw(m["id"], with_provider_prefix=True)

        if current and (formatted_primary == current):
            continue
        # Skip openrouter/free (already added as first)
        if "openrouter/free" in m["id"]:
            continue
        if len(fallbacks) >= args.count:
            break

        fallbacks.append(formatted)
        config["agents"]["defaults"]["models"][formatted] = {}

    config["agents"]["defaults"]["model"]["fallbacks"] = fallbacks
    save_openclaw_config(config)

    print(f"\nConfigured {len(fallbacks)} fallback models:")
    for i, fb in enumerate(fallbacks, 1):
        print(f"  {i}. {fb}")

    print("\nWhen rate limited, OpenClaw will automatically try these models.")
    print("Restart OpenClaw for changes to take effect.")


def main():
    parser = argparse.ArgumentParser(
        prog="freeride",
        description="FreeRide - Free AI for OpenClaw. Manage free models from OpenRouter."
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # list command
    list_parser = subparsers.add_parser("list", help="List available free models")
    list_parser.add_argument("--limit", "-n", type=int, default=15,
                            help="Number of models to show (default: 15)")
    list_parser.add_argument("--refresh", "-r", action="store_true",
                            help="Force refresh from API (ignore cache)")

    # switch command
    switch_parser = subparsers.add_parser("switch", help="Switch to a specific model")
    switch_parser.add_argument("model", help="Model ID to switch to")
    switch_parser.add_argument("--fallback-only", "-f", action="store_true",
                              help="Add to fallbacks only, don't change primary")
    switch_parser.add_argument("--no-fallbacks", action="store_true",
                              help="Don't configure fallback models")
    switch_parser.add_argument("--setup-auth", action="store_true",
                              help="Also set up OpenRouter auth profile")

    # auto command
    auto_parser = subparsers.add_parser("auto", help="Auto-select best free model")
    auto_parser.add_argument("--fallback-count", "-c", type=int, default=5,
                            help="Number of fallback models (default: 5)")
    auto_parser.add_argument("--fallback-only", "-f", action="store_true",
                            help="Add to fallbacks only, don't change primary")
    auto_parser.add_argument("--setup-auth", action="store_true",
                            help="Also set up OpenRouter auth profile")

    # status command
    subparsers.add_parser("status", help="Show current configuration")

    # refresh command
    subparsers.add_parser("refresh", help="Refresh model cache")

    # fallbacks command
    fallbacks_parser = subparsers.add_parser("fallbacks", help="Configure fallback models")
    fallbacks_parser.add_argument("--count", "-c", type=int, default=5,
                                 help="Number of fallback models (default: 5)")

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "switch":
        cmd_switch(args)
    elif args.command == "auto":
        cmd_auto(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "refresh":
        cmd_refresh(args)
    elif args.command == "fallbacks":
        cmd_fallbacks(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()