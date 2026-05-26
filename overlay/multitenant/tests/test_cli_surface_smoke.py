from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER = REPO_ROOT / "scripts" / "check-cli-surface.sh"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "runtime-cli-surface.yml"
MULTITENANT_TESTS_WORKFLOW = (
    REPO_ROOT / ".github" / "workflows" / "runtime-multitenant-tests.yml"
)


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _fake_cli_bin(tmp_path: Path, *, claudeai_flag: bool = True) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    claude_help = (
        "Usage: claude auth login [--claudeai]\n"
        if claudeai_flag
        else "Usage: claude auth login\n"
    )
    _write_executable(
        bindir / "claude",
        f"""#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version")
    printf 'Claude Code 2.1.147\\n'
    ;;
  "auth login --help")
    printf '{claude_help}'
    ;;
  "setup-token --help")
    printf 'Usage: claude setup-token\\n'
    ;;
  *)
    printf 'unexpected claude command: %s\\n' "$*" >&2
    exit 64
    ;;
esac
""",
    )
    _write_executable(
        bindir / "codex",
        """#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version")
    printf 'codex 0.132.0\\n'
    ;;
  "login --device-auth --help")
    printf 'Usage: codex login --device-auth\\n'
    ;;
  *)
    printf 'unexpected codex command: %s\\n' "$*" >&2
    exit 64
    ;;
esac
""",
    )
    return bindir


def _run_checker(tmp_path: Path, bindir: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    return subprocess.run(
        [
            "bash",
            str(CHECKER),
            "--host",
            "--output-dir",
            str(tmp_path / "out"),
            *extra_args,
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_checker_accepts_expected_cli_surface(tmp_path: Path) -> None:
    result = _run_checker(tmp_path, _fake_cli_bin(tmp_path))
    assert result.returncode == 0, result.stderr

    current = json.loads((tmp_path / "out" / "current.json").read_text(encoding="utf-8"))
    assert current["ok"] is True
    assert current["failureCount"] == 0
    assert [entry["command"] for entry in current["commands"]] == [
        "claude --version",
        "claude auth login --help",
        "claude setup-token --help",
        "codex --version",
        "codex login --device-auth --help",
    ]
    summary = (tmp_path / "out" / "summary.md").read_text(encoding="utf-8")
    assert "All 5 CLI surface assertions hold" in summary


def test_checker_fails_when_claudeai_flag_disappears(tmp_path: Path) -> None:
    result = _run_checker(tmp_path, _fake_cli_bin(tmp_path, claudeai_flag=False))
    assert result.returncode == 1

    failures = (tmp_path / "out" / "failures.txt").read_text(encoding="utf-8")
    assert "claude auth login --help" in failures
    assert "--claudeai" in failures


def test_checker_fails_when_claude_version_has_no_version_token(tmp_path: Path) -> None:
    bindir = _fake_cli_bin(tmp_path)
    (bindir / "claude").write_text(
        """#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version")
    printf 'Claude Code\\n'
    ;;
  "auth login --help")
    printf 'Usage: claude auth login [--claudeai]\\n'
    ;;
  "setup-token --help")
    printf 'Usage: claude setup-token\\n'
    ;;
  *)
    exit 64
    ;;
esac
""",
        encoding="utf-8",
    )
    (bindir / "claude").chmod(0o755)

    result = _run_checker(tmp_path, bindir)
    assert result.returncode == 1
    failures = (tmp_path / "out" / "failures.txt").read_text(encoding="utf-8")
    assert "claude --version" in failures
    assert "version token" in failures


def test_checker_ignores_whitespace_only_drift(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline.json"
    baseline.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "commands": [
                    {
                        "id": "claude-auth-login-help",
                        "output": " Usage:   claude   auth   login   [--claudeai] \n\n",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    result = _run_checker(
        tmp_path,
        _fake_cli_bin(tmp_path),
        "--baseline",
        str(baseline),
    )
    assert result.returncode == 0, result.stderr
    current = json.loads((tmp_path / "out" / "current.json").read_text(encoding="utf-8"))
    assert current["driftCount"] == 0
    assert (tmp_path / "out" / "diff.txt").read_text(encoding="utf-8") == ""


def test_checker_fails_on_meaningful_normalized_drift(tmp_path: Path) -> None:
    baseline = tmp_path / "baseline.json"
    baseline.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "commands": [
                    {
                        "id": "claude-auth-login-help",
                        "output": "Usage: claude auth login [--claudeai]",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    bindir = _fake_cli_bin(tmp_path)
    (bindir / "claude").write_text(
        """#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--version")
    printf 'Claude Code 2.1.147\\n'
    ;;
  "auth login --help")
    printf 'Usage: claude auth login [--claudeai] [--new-flag]\\n'
    ;;
  "setup-token --help")
    printf 'Usage: claude setup-token\\n'
    ;;
  *)
    exit 64
    ;;
esac
""",
        encoding="utf-8",
    )
    (bindir / "claude").chmod(0o755)

    result = _run_checker(tmp_path, bindir, "--baseline", str(baseline))
    assert result.returncode == 1
    current = json.loads((tmp_path / "out" / "current.json").read_text(encoding="utf-8"))
    assert current["ok"] is False
    assert current["driftCount"] == 1
    assert "new-flag" in (tmp_path / "out" / "diff.txt").read_text(encoding="utf-8")
    summary = (tmp_path / "out" / "summary.md").read_text(encoding="utf-8")
    assert "CLI surface command(s) drifted" in summary


def test_runtime_cli_surface_workflow_has_required_triggers_and_side_effects() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert "runtime-cli-surface" in workflow
    assert "- \"Dockerfile.multitenant\"" in workflow
    assert "schedule:" in workflow
    assert "scripts/check-cli-surface.sh" in workflow
    assert "SHOULD_BUILD_PR_IMAGE" in workflow
    assert "CAN_MUTATE_GITHUB" in workflow
    assert "CHECKED_SHA" in workflow
    assert "persist-credentials: false" in workflow
    assert "rm -rf vendor/platform-skills/.git" in workflow
    assert "actions/cache/restore" in workflow
    assert "actions/cache/save" in workflow
    assert "createCommitComment" in workflow
    assert "issues.create({" in workflow
    assert "cli-drift" in workflow
    assert "refusing to smoke stale latest" in workflow
    assert "event.commits" in workflow


def test_multitenant_tests_workflow_runs_for_cli_surface_changes() -> None:
    workflow = MULTITENANT_TESTS_WORKFLOW.read_text(encoding="utf-8")
    assert "scripts/check-cli-surface.sh" in workflow
    assert ".github/workflows/runtime-cli-surface.yml" in workflow
