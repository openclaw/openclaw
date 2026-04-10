#!/usr/bin/env python3
"""Validate cloud/local control-plane files for OpenClaw stack."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

REQUIRED_FILES = [
    ".github/workflows/agent-cloud-control.yml",
    "scripts/ci/validate_openclaw_stack.py",
    "tools/openclaw-local-guard.ps1",
    "tools/openclaw-cdp-proxy.js",
    "docs/openclaw-cloud-local-stability.md",
]

REQUIRED_MARKERS = {
    ".github/workflows/agent-cloud-control.yml": [
        "cloud-validate",
        "local-smoke",
        "runs-on:",
    ],
    "tools/openclaw-local-guard.ps1": [
        "param(",
        "ValidateSet('status', 'repair', 'smoke')",
        "Invoke-Wsl",
    ],
    "tools/openclaw-cdp-proxy.js": [
        "net.createServer",
        "targetPort",
        "listenPort",
    ],
}


def main() -> int:
    missing = []
    marker_failures = []

    for rel_path in REQUIRED_FILES:
        file_path = ROOT / rel_path
        if not file_path.exists():
            missing.append(rel_path)

    if missing:
        print(json.dumps({"ok": False, "missing": missing}, ensure_ascii=True, indent=2))
        return 1

    for rel_path, markers in REQUIRED_MARKERS.items():
        text = (ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
        for marker in markers:
            if marker not in text:
                marker_failures.append({"file": rel_path, "marker": marker})

    result = {
        "ok": len(marker_failures) == 0,
        "missing": missing,
        "marker_failures": marker_failures,
    }
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
