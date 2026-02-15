from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from integrations.openclaw_sie_config import parse_sie_runtime_config
from integrations.sie_enforcement import (
    REASON_SIE_DISABLED,
    EnforcementDecision,
    evaluate_skill,
)


def enforce_skill_from_openclaw_config(
    skill_path: str | Path,
    config: Dict[str, Any],
    *,
    base_dir: str | Path = ".",
) -> EnforcementDecision:
    """
    Thin integration hook for OpenClaw-like loader call sites.

    Behavior:
    - If SIE is disabled in config -> allow (backward compatible).
    - If SIE is enabled -> evaluate strict/warn logic using configured verifier paths.
    """
    base = Path(base_dir)
    skill = Path(skill_path)

    if not skill.is_absolute():
        skill = base / skill

    cfg = parse_sie_runtime_config(config, base_dir=base)
    
    if not cfg.enabled:
        return EnforcementDecision(
            True,
            REASON_SIE_DISABLED,
            "SIE disabled; allowing skill "
            f"(mode={cfg.mode}, verify_script={cfg.verify_script}, "
            f"trusted_issuers={cfg.trusted_issuers}, envelope_suffix={cfg.envelope_suffix})"
        )

    return evaluate_skill(
        skill,
        mode=cfg.mode,
        verify_script=cfg.verify_script,
        trusted_issuers=cfg.trusted_issuers,
        envelope_suffix=cfg.envelope_suffix,
    )
