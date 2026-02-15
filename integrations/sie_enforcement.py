from __future__ import annotations

import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

REASON_SIE_DISABLED = "sie_disabled"
REASON_SKILL_NOT_FOUND = "skill_not_found"
REASON_UNSIGNED_STRICT = "unsigned_strict"
REASON_UNSIGNED_WARN = "unsigned_warn"
REASON_VERIFY_FAILED = "verify_failed"
REASON_VERIFIED = "verified"


@dataclass(frozen=True)
class EnforcementDecision:
    allowed: bool
    reason: str
    detail: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _run_verify(verify_script: Path, envelope: Path, trusted_issuers: Path, skill_file: Path) -> tuple[bool, str]:
    if not sys.executable:
        return False, "verifier runtime unavailable: sys.executable is empty"
    if not verify_script.exists():
        return False, f"verifier script not found: {verify_script}"
    if not verify_script.is_file():
        return False, f"verifier script is not a file: {verify_script}"

    cmd = [
        sys.executable,
        str(verify_script),
        "--file",
        str(envelope),
        "--trusted-issuers",
        str(trusted_issuers),
        "--check-file",
        str(skill_file),
    ]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        return False, "verifier execution timed out"
    except OSError as e:
        return False, f"verifier execution failed: {e}"

    out = ((r.stdout or "") + (r.stderr or "")).strip()
    return r.returncode == 0, out


def evaluate_skill(
    skill_file: Path,
    *,
    mode: str,
    verify_script: Path,
    trusted_issuers: Path,
    envelope_suffix: str = ".sie.json",
) -> EnforcementDecision:
    if mode not in {"warn", "strict"}:
        raise ValueError("mode must be 'warn' or 'strict'")

    if not skill_file.exists():
        return EnforcementDecision(False, REASON_SKILL_NOT_FOUND, f"skill file not found: {skill_file}")

    envelope = Path(f"{skill_file}{envelope_suffix}")
    if not envelope.exists():
        if mode == "strict":
            return EnforcementDecision(False, REASON_UNSIGNED_STRICT, "unsigned skill rejected (strict mode)")
        return EnforcementDecision(True, REASON_UNSIGNED_WARN, "unsigned skill allowed (warn mode)")

    ok, detail = _run_verify(verify_script, envelope, trusted_issuers, skill_file)
    if not ok:
        return EnforcementDecision(False, REASON_VERIFY_FAILED, detail)

    return EnforcementDecision(True, REASON_VERIFIED, "signed skill verified")
