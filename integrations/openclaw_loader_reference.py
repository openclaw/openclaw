from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from integrations.openclaw_hook import enforce_skill_from_openclaw_config


class SkillLoadRejected(RuntimeError):
    pass


def load_skill_text_with_sie(
    skill_path: str | Path,
    config: Dict[str, Any],
    *,
    base_dir: str | Path = ".",
) -> str:
    """
    Reference runtime flow:
    1) Evaluate SIE policy via hook.
    2) Reject load on failed enforcement.
    3) Return skill text if allowed.

    This mirrors how a loader can wire SIE gating before trusting instructions.
    """
    decision = enforce_skill_from_openclaw_config(skill_path, config, base_dir=base_dir)
    if not decision.allowed:
        raise SkillLoadRejected(f"skill rejected ({decision.reason}): {decision.detail}")

    base = Path(base_dir)
    skill = Path(skill_path)
    if not skill.is_absolute():
        skill = base / skill

    return skill.read_text(encoding="utf-8")


def load_openclaw_config(path: str | Path) -> Dict[str, Any]:
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8"))
