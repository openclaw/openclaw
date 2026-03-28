#!/usr/bin/env python3
"""Pre-push quality gate — runs pytest and blocks push on any failure.

Install:  cp git-hooks/pre-push .git/hooks/pre-push
Or run:   python scripts/pre_push_check.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT / ".venv" / ("Scripts" if sys.platform == "win32" else "bin") / "python"
PYTHON = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

IGNORE_DIRS = [
    "tests/test_deep_research.py",
    "tests/test_tools.py",
]


def run_tests() -> int:
    """Run pytest and return exit code (0 = all green)."""
    cmd = [
        PYTHON, "-m", "pytest", "tests/", "-q", "--tb=short",
    ]
    for ignore in IGNORE_DIRS:
        cmd.extend(["--ignore", ignore])

    print(f"🔍 Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(ROOT))
    return result.returncode


def main() -> int:
    print("=" * 60)
    print("  🛡️  OpenClaw Pre-Push Quality Gate")
    print("=" * 60)

    rc = run_tests()
    if rc != 0:
        print("\n❌ PUSH BLOCKED — tests failed. Fix failures before pushing.")
        return 1

    print("\n✅ All tests passed — push allowed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
