"""Auth profile repair utilities."""

from openclaw_py.config import OpenClawConfig
from openclaw_py.logging import log_info

from .types import AuthProfileStore


def repair_profile_id(
    config: OpenClawConfig,
    from_profile_id: str,
    to_profile_id: str,
) -> dict:
    """Repair profile ID in configuration.

    Args:
        config: OpenClaw configuration
        from_profile_id: Old profile ID
        to_profile_id: New profile ID

    Returns:
        Dict with repair result
    """
    changes: list[str] = []
    migrated = False

    # Check if auth config exists
    if not hasattr(config, "auth") or not config.auth:
        return {
            "config": config,
            "changes": changes,
            "migrated": migrated,
            "from_profile_id": from_profile_id,
            "to_profile_id": to_profile_id,
        }

    auth_config = config.auth

    # Update order if present
    if hasattr(auth_config, "order") and auth_config.order:
        for provider, order_list in auth_config.order.items():
            if from_profile_id in order_list:
                idx = order_list.index(from_profile_id)
                order_list[idx] = to_profile_id
                changes.append(f"Updated order for provider {provider}")
                migrated = True

    log_info(
        f"Profile ID repair: {from_profile_id} -> {to_profile_id}, "
        f"changes={len(changes)}"
    )

    return {
        "config": config,
        "changes": changes,
        "migrated": migrated,
        "from_profile_id": from_profile_id,
        "to_profile_id": to_profile_id,
    }


def migrate_profile_store(
    store: AuthProfileStore,
    from_profile_id: str,
    to_profile_id: str,
) -> bool:
    """Migrate profile ID in store.

    Args:
        store: AuthProfileStore
        from_profile_id: Old profile ID
        to_profile_id: New profile ID

    Returns:
        True if migration occurred
    """
    migrated = False

    # Migrate profile
    if from_profile_id in store.profiles:
        store.profiles[to_profile_id] = store.profiles[from_profile_id]
        del store.profiles[from_profile_id]
        migrated = True

    # Migrate order
    if store.order:
        for provider, order_list in store.order.items():
            if from_profile_id in order_list:
                idx = order_list.index(from_profile_id)
                order_list[idx] = to_profile_id
                migrated = True

    # Migrate lastGood
    if store.last_good:
        for provider, profile_id in list(store.last_good.items()):
            if profile_id == from_profile_id:
                store.last_good[provider] = to_profile_id
                migrated = True

    # Migrate usageStats
    if store.usage_stats and from_profile_id in store.usage_stats:
        store.usage_stats[to_profile_id] = store.usage_stats[from_profile_id]
        del store.usage_stats[from_profile_id]
        migrated = True

    return migrated
