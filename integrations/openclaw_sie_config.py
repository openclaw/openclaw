from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict


@dataclass(frozen=True)
class SieRuntimeConfig:
    enabled: bool
    mode: str # warn|strict
    verify_script: Path
    trusted_issuers: Path
    envelope_suffix: str


def _deep_get(d: Dict[str, Any], *keys: str) -> Any:
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def parse_sie_runtime_config(config: Dict[str, Any], *, base_dir: Path = Path(".")) -> SieRuntimeConfig:
    sie = _deep_get(config, "agents", "security", "sie") or {}

    enabled = bool(sie.get("enabled", False))
    strict = bool(sie.get("strict", False))
    mode = "strict" if (enabled and strict) else "warn"
    
    envelope_suffix = str(sie.get("envelopeSuffix", ".sie.json"))
    
    verify_script = Path(sie.get("verifyScript") or "sie_verify.py")
    trusted_issuers = Path(sie.get("trustedIssuers") or "trusted_issuers.json")
    
    if not verify_script.is_absolute():
        verify_script = base_dir / verify_script

    if not trusted_issuers.is_absolute():
        trusted_issuers = base_dir / trusted_issuers

    return SieRuntimeConfig(    
        enabled=enabled,
        mode=mode,
        verify_script=verify_script,
        trusted_issuers=trusted_issuers,
        envelope_suffix=envelope_suffix,
    )


def load_sie_runtime_config(config_path: Path) -> SieRuntimeConfig:
    data = json.loads(config_path.read_text(encoding="utf-8"))
    return parse_sie_runtime_config(data, base_dir=config_path.parent)
