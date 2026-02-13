"""Auth profile usage tracking and cooldown management."""

import time

from openclaw_py.agents.model_selection import normalize_provider_id
from openclaw_py.config import OpenClawConfig

from .store import save_auth_profile_store, update_auth_profile_store_with_lock
from .types import AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats


def _resolve_profile_unusable_until(stats: ProfileUsageStats) -> int | None:
    """Resolve profile unusable until timestamp.

    Args:
        stats: ProfileUsageStats

    Returns:
        Timestamp (ms) or None
    """
    values = [stats.cooldown_until, stats.disabled_until]
    valid_values = [v for v in values if isinstance(v, (int, float)) and v > 0]
    return int(max(valid_values)) if valid_values else None


def is_profile_in_cooldown(store: AuthProfileStore, profile_id: str) -> bool:
    """Check if a profile is currently in cooldown.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID

    Returns:
        True if in cooldown

    Examples:
        >>> is_profile_in_cooldown(store, "anthropic:default")
        False
    """
    if not store.usage_stats:
        return False

    stats = store.usage_stats.get(profile_id)
    if not stats:
        return False

    unusable_until = _resolve_profile_unusable_until(stats)
    if not unusable_until:
        return False

    now = int(time.time() * 1000)
    return now < unusable_until


async def mark_auth_profile_used(
    store: AuthProfileStore,
    profile_id: str,
    agent_dir: str | None = None,
) -> None:
    """Mark a profile as successfully used.

    Resets error count and updates lastUsed timestamp.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID
        agent_dir: Optional agent directory
    """

    def updater(fresh_store: AuthProfileStore) -> bool:
        if profile_id not in fresh_store.profiles:
            return False

        fresh_store.usage_stats = fresh_store.usage_stats or {}
        existing = fresh_store.usage_stats.get(profile_id)

        fresh_store.usage_stats[profile_id] = ProfileUsageStats(
            last_used=int(time.time() * 1000),
            error_count=0,
            cooldown_until=None,
            disabled_until=None,
            disabled_reason=None,
            failure_counts=None,
        )
        return True

    updated = await update_auth_profile_store_with_lock(
        {"agent_dir": agent_dir, "updater": updater}
    )

    if updated:
        store.usage_stats = updated.usage_stats
        return

    # Fallback: direct update
    if profile_id not in store.profiles:
        return

    store.usage_stats = store.usage_stats or {}
    store.usage_stats[profile_id] = ProfileUsageStats(
        last_used=int(time.time() * 1000),
        error_count=0,
        cooldown_until=None,
        disabled_until=None,
        disabled_reason=None,
        failure_counts=None,
    )
    save_auth_profile_store(store, agent_dir)


def calculate_auth_profile_cooldown_ms(error_count: int) -> int:
    """Calculate cooldown duration based on error count.

    Uses exponential backoff: 1min, 5min, 25min, max 1 hour.

    Args:
        error_count: Number of consecutive errors

    Returns:
        Cooldown duration in milliseconds

    Examples:
        >>> calculate_auth_profile_cooldown_ms(1)
        60000  # 1 minute
        >>> calculate_auth_profile_cooldown_ms(2)
        300000  # 5 minutes
    """
    normalized = max(1, error_count)
    # 5^0 = 1min, 5^1 = 5min, 5^2 = 25min, 5^3 = 125min (capped at 60min)
    return min(
        60 * 60 * 1000,  # 1 hour max
        60 * 1000 * (5 ** min(normalized - 1, 3)),
    )


def _resolve_auth_cooldown_config(cfg: OpenClawConfig | None, provider_id: str) -> dict:
    """Resolve auth cooldown configuration.

    Args:
        cfg: OpenClaw configuration
        provider_id: Provider ID

    Returns:
        Dict with cooldown config values
    """
    defaults = {
        "billing_backoff_hours": 5,
        "billing_max_hours": 24,
        "failure_window_hours": 24,
    }

    if not cfg or not hasattr(cfg, "auth") or not cfg.auth:
        return {
            "billing_backoff_ms": defaults["billing_backoff_hours"] * 60 * 60 * 1000,
            "billing_max_ms": defaults["billing_max_hours"] * 60 * 60 * 1000,
            "failure_window_ms": defaults["failure_window_hours"] * 60 * 60 * 1000,
        }

    auth_config = cfg.auth
    cooldowns = auth_config.cooldowns if hasattr(auth_config, "cooldowns") else None

    # Get billing backoff hours (with provider-specific override)
    billing_backoff_hours = defaults["billing_backoff_hours"]
    if cooldowns:
        if hasattr(cooldowns, "billing_backoff_hours"):
            billing_backoff_hours = cooldowns.billing_backoff_hours or billing_backoff_hours

        # Check provider-specific override
        if hasattr(cooldowns, "billing_backoff_hours_by_provider"):
            by_provider = cooldowns.billing_backoff_hours_by_provider
            if by_provider:
                for key, value in by_provider.items():
                    if normalize_provider_id(key) == provider_id:
                        billing_backoff_hours = value or billing_backoff_hours
                        break

    billing_max_hours = defaults["billing_max_hours"]
    if cooldowns and hasattr(cooldowns, "billing_max_hours"):
        billing_max_hours = cooldowns.billing_max_hours or billing_max_hours

    failure_window_hours = defaults["failure_window_hours"]
    if cooldowns and hasattr(cooldowns, "failure_window_hours"):
        failure_window_hours = cooldowns.failure_window_hours or failure_window_hours

    return {
        "billing_backoff_ms": int(billing_backoff_hours * 60 * 60 * 1000),
        "billing_max_ms": int(billing_max_hours * 60 * 60 * 1000),
        "failure_window_ms": int(failure_window_hours * 60 * 60 * 1000),
    }


def _calculate_auth_profile_billing_disable_ms(
    error_count: int,
    base_ms: int,
    max_ms: int,
) -> int:
    """Calculate billing error disable duration.

    Uses exponential backoff: 2^0, 2^1, 2^2, ...

    Args:
        error_count: Number of billing errors
        base_ms: Base duration in ms
        max_ms: Maximum duration in ms

    Returns:
        Disable duration in milliseconds
    """
    normalized = max(1, error_count)
    base_ms = max(60_000, base_ms)  # At least 1 minute
    max_ms = max(base_ms, max_ms)
    exponent = min(normalized - 1, 10)
    raw = base_ms * (2**exponent)
    return min(max_ms, raw)


def _compute_next_profile_usage_stats(
    existing: ProfileUsageStats,
    now: int,
    reason: AuthProfileFailureReason,
    cfg_resolved: dict,
) -> ProfileUsageStats:
    """Compute next usage stats after failure.

    Args:
        existing: Existing stats
        now: Current timestamp (ms)
        reason: Failure reason
        cfg_resolved: Resolved config

    Returns:
        Updated ProfileUsageStats
    """
    window_ms = cfg_resolved["failure_window_ms"]

    # Check if failure window expired
    window_expired = (
        existing.last_failure_at
        and existing.last_failure_at > 0
        and now - existing.last_failure_at > window_ms
    )

    # Reset counts if window expired
    base_error_count = 0 if window_expired else (existing.error_count or 0)
    next_error_count = base_error_count + 1

    failure_counts = {} if window_expired else dict(existing.failure_counts or {})
    failure_counts[reason] = failure_counts.get(reason, 0) + 1

    updated_stats = ProfileUsageStats(
        last_used=existing.last_used,
        error_count=next_error_count,
        failure_counts=failure_counts,
        last_failure_at=now,
        cooldown_until=existing.cooldown_until,
        disabled_until=existing.disabled_until,
        disabled_reason=existing.disabled_reason,
    )

    # Handle billing failures specially
    if reason == "billing":
        billing_count = failure_counts.get("billing", 1)
        backoff_ms = _calculate_auth_profile_billing_disable_ms(
            billing_count,
            cfg_resolved["billing_backoff_ms"],
            cfg_resolved["billing_max_ms"],
        )
        updated_stats.disabled_until = now + backoff_ms
        updated_stats.disabled_reason = "billing"
    else:
        # Regular cooldown
        backoff_ms = calculate_auth_profile_cooldown_ms(next_error_count)
        updated_stats.cooldown_until = now + backoff_ms

    return updated_stats


async def mark_auth_profile_failure(
    store: AuthProfileStore,
    profile_id: str,
    reason: AuthProfileFailureReason,
    cfg: OpenClawConfig | None = None,
    agent_dir: str | None = None,
) -> None:
    """Mark a profile as failed for a specific reason.

    Billing failures trigger longer backoff than regular failures.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID
        reason: Failure reason
        cfg: OpenClaw configuration
        agent_dir: Optional agent directory
    """

    def updater(fresh_store: AuthProfileStore) -> bool:
        profile = fresh_store.profiles.get(profile_id)
        if not profile:
            return False

        fresh_store.usage_stats = fresh_store.usage_stats or {}
        existing = fresh_store.usage_stats.get(profile_id) or ProfileUsageStats()

        now = int(time.time() * 1000)
        provider_key = normalize_provider_id(profile.provider)
        cfg_resolved = _resolve_auth_cooldown_config(cfg, provider_key)

        fresh_store.usage_stats[profile_id] = _compute_next_profile_usage_stats(
            existing, now, reason, cfg_resolved
        )
        return True

    updated = await update_auth_profile_store_with_lock(
        {"agent_dir": agent_dir, "updater": updater}
    )

    if updated:
        store.usage_stats = updated.usage_stats
        return

    # Fallback: direct update
    profile = store.profiles.get(profile_id)
    if not profile:
        return

    store.usage_stats = store.usage_stats or {}
    existing = store.usage_stats.get(profile_id) or ProfileUsageStats()

    now = int(time.time() * 1000)
    provider_key = normalize_provider_id(profile.provider)
    cfg_resolved = _resolve_auth_cooldown_config(cfg, provider_key)

    store.usage_stats[profile_id] = _compute_next_profile_usage_stats(
        existing, now, reason, cfg_resolved
    )
    save_auth_profile_store(store, agent_dir)


async def mark_auth_profile_cooldown(
    store: AuthProfileStore,
    profile_id: str,
    agent_dir: str | None = None,
) -> None:
    """Mark a profile as failed/rate-limited.

    Convenience wrapper for mark_auth_profile_failure with "unknown" reason.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID
        agent_dir: Optional agent directory
    """
    await mark_auth_profile_failure(store, profile_id, "unknown", agent_dir=agent_dir)


async def clear_auth_profile_cooldown(
    store: AuthProfileStore,
    profile_id: str,
    agent_dir: str | None = None,
) -> None:
    """Clear cooldown for a profile (manual reset).

    Args:
        store: AuthProfileStore
        profile_id: Profile ID
        agent_dir: Optional agent directory
    """

    def updater(fresh_store: AuthProfileStore) -> bool:
        if not fresh_store.usage_stats or profile_id not in fresh_store.usage_stats:
            return False

        stats = fresh_store.usage_stats[profile_id]
        fresh_store.usage_stats[profile_id] = ProfileUsageStats(
            last_used=stats.last_used,
            error_count=0,
            cooldown_until=None,
            disabled_until=stats.disabled_until,
            disabled_reason=stats.disabled_reason,
            failure_counts=stats.failure_counts,
            last_failure_at=stats.last_failure_at,
        )
        return True

    updated = await update_auth_profile_store_with_lock(
        {"agent_dir": agent_dir, "updater": updater}
    )

    if updated:
        store.usage_stats = updated.usage_stats
        return

    # Fallback: direct update
    if not store.usage_stats or profile_id not in store.usage_stats:
        return

    stats = store.usage_stats[profile_id]
    store.usage_stats[profile_id] = ProfileUsageStats(
        last_used=stats.last_used,
        error_count=0,
        cooldown_until=None,
        disabled_until=stats.disabled_until,
        disabled_reason=stats.disabled_reason,
        failure_counts=stats.failure_counts,
        last_failure_at=stats.last_failure_at,
    )
    save_auth_profile_store(store, agent_dir)


def resolve_profile_unusable_until_for_display(
    store: AuthProfileStore,
    profile_id: str,
) -> int | None:
    """Resolve profile unusable until timestamp for display purposes.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID

    Returns:
        Timestamp (ms) or None
    """
    if not store.usage_stats:
        return None

    stats = store.usage_stats.get(profile_id)
    if not stats:
        return None

    return _resolve_profile_unusable_until(stats)
