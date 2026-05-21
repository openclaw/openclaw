"""Smoke test for ``render_settings_json()`` in ``overlay/multitenant/entrypoint.sh``.

We do NOT spin up the runtime container — that's the whole image build
plus Fly + secrets, far too heavyweight for a unit-level smoke. Instead
we:

  1. Read the live ``entrypoint.sh`` source.
  2. Extract the ``render_settings_json`` function body via regex
     (``render_settings_json() { ... }``).
  3. Run that function body inside a bash subprocess against a
     controlled env + a tmp dir holding a copy of
     ``overlay/multitenant/settings.json.j2``, with the in-function
     ``/home/runtime/.claude`` paths rewritten to point at the tmp dir.
  4. Assert the rendered JSON parses and the substituted env values
     match what we set on the subprocess.
  5. Assert the missing-LAB_ID path emits a WARN line on stderr but
     does NOT cause the subprocess to exit nonzero (EARS req #2 in
     ``specs/runtime-platform-lab-id-env-2026-05-21.md``).

Run from the repo root with:

    uv run --with pytest pytest overlay/multitenant/tests/test_entrypoint_render_settings.py -v
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
OVERLAY = REPO_ROOT / "overlay" / "multitenant"
ENTRYPOINT = OVERLAY / "entrypoint.sh"
TEMPLATE = OVERLAY / "settings.json.j2"


def _extract_render_fn() -> str:
    """Return the body of ``render_settings_json`` from entrypoint.sh.

    We match from ``render_settings_json() {`` through the matching
    closing brace at column 0 — the function is defined at the top
    level so a bare ``^}$`` is the correct terminator.
    """
    src = ENTRYPOINT.read_text(encoding="utf-8")
    pattern = re.compile(
        r"^render_settings_json\(\)\s*\{\n(?P<body>.*?)^\}\n",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(src)
    assert m is not None, "render_settings_json() not found in entrypoint.sh"
    return m.group("body")


def _run_render(
    tmp_path: Path,
    env_overrides: dict[str, str],
    *,
    rewrite_paths: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Spawn ``bash`` running just ``render_settings_json``, with
    ``/home/runtime/.claude`` rewritten to ``tmp_path/.claude`` so we
    can exercise it without root."""
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(TEMPLATE, claude_dir / "settings.json.j2")

    body = _extract_render_fn()
    if rewrite_paths:
        body = body.replace("/home/runtime/.claude", str(claude_dir))

    script = (
        "set -euo pipefail\n"
        "log() { printf '[entrypoint] %s\\n' \"$*\" >&2; }\n"
        "render_settings_json() {\n"
        f"{body}"
        "}\n"
        "render_settings_json\n"
    )

    # Start from an empty env so unset variables on the test driver's
    # shell can't leak into the subprocess (e.g. a stray PLATFORM_LAB_ID).
    env: dict[str, str] = {"PATH": "/usr/bin:/bin:/usr/local/bin"}
    env.update(env_overrides)

    return subprocess.run(
        ["bash", "-c", script],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture()
def claude_dir(tmp_path: Path) -> Path:
    return tmp_path / ".claude"


# ---------------------------------------------------------------------------
# EARS req #1: rendered settings.json substitutes LAB_ID / TENANT_ID / TARGET_DIR
# ---------------------------------------------------------------------------


def test_render_substitutes_all_three_placeholders(tmp_path: Path, claude_dir: Path) -> None:
    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-test-123",
            "ROCKIELAB_TENANT_ID": "t-test-456",
            "PLATFORM_TARGET_DIR": "/tmp/work",
        },
    )
    assert result.returncode == 0, result.stderr
    output = claude_dir / "settings.json"
    assert output.exists()
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_LAB_ID"] == "l-test-123"
    assert data["env"]["PLATFORM_TENANT_ID"] == "t-test-456"
    assert data["env"]["PLATFORM_TARGET_DIR"] == "/tmp/work"
    # Tenant block also pulls from the same placeholders.
    assert data["tenant"]["id"] == "t-test-456"
    assert data["tenant"]["lab"] == "l-test-123"
    # additionalDirectories rides on TARGET_DIR.
    assert data["permissions"]["additionalDirectories"] == ["/tmp/work"]


# ---------------------------------------------------------------------------
# EARS req #2: missing LAB_ID logs WARN + continues (does NOT exit nonzero)
# ---------------------------------------------------------------------------


def test_missing_lab_id_warns_and_continues(tmp_path: Path, claude_dir: Path) -> None:
    result = _run_render(
        tmp_path,
        {
            # PLATFORM_LAB_ID intentionally unset
            "ROCKIELAB_TENANT_ID": "t-test-456",
            "PLATFORM_TARGET_DIR": "/tmp/work",
        },
    )
    assert result.returncode == 0, (
        f"render_settings_json must not exit nonzero when LAB_ID is unset.\n"
        f"stderr:\n{result.stderr}"
    )
    assert "lab_id unset" in result.stderr, result.stderr
    output = claude_dir / "settings.json"
    assert output.exists()
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_LAB_ID"] == ""
    # Other placeholders still substitute correctly.
    assert data["env"]["PLATFORM_TENANT_ID"] == "t-test-456"
    assert data["env"]["PLATFORM_TARGET_DIR"] == "/tmp/work"


# ---------------------------------------------------------------------------
# TARGET_DIR falls back to /home/runtime when both PLATFORM_TARGET_DIR and
# TARGET_DIR are unset (matches the spec-pinned default path).
# ---------------------------------------------------------------------------


def test_target_dir_defaults_to_home_runtime(tmp_path: Path, claude_dir: Path) -> None:
    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-abc",
            "ROCKIELAB_TENANT_ID": "t-abc",
            # PLATFORM_TARGET_DIR + TARGET_DIR both unset
        },
    )
    assert result.returncode == 0, result.stderr
    data = json.loads((claude_dir / "settings.json").read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_TARGET_DIR"] == "/home/runtime"
    assert data["permissions"]["additionalDirectories"] == ["/home/runtime"]


# ---------------------------------------------------------------------------
# Idempotency — re-running on an already-rendered settings.json produces
# the same content, byte for byte.
# ---------------------------------------------------------------------------


def test_sed_metachars_in_values_do_not_corrupt_output(
    tmp_path: Path, claude_dir: Path
) -> None:
    """A future provisioner could pass a TARGET_DIR with `&` or `|` or
    `\\` — sed would otherwise treat these as metachars and corrupt the
    rendered JSON. Verifies the escape pass."""
    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-a&b",
            "ROCKIELAB_TENANT_ID": "t-c|d",
            "PLATFORM_TARGET_DIR": "/srv/work&prod",
        },
    )
    assert result.returncode == 0, result.stderr
    data = json.loads((claude_dir / "settings.json").read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_LAB_ID"] == "l-a&b"
    assert data["env"]["PLATFORM_TENANT_ID"] == "t-c|d"
    assert data["env"]["PLATFORM_TARGET_DIR"] == "/srv/work&prod"


def test_render_is_idempotent(tmp_path: Path, claude_dir: Path) -> None:
    env = {
        "PLATFORM_LAB_ID": "l-idem",
        "ROCKIELAB_TENANT_ID": "t-idem",
        "PLATFORM_TARGET_DIR": "/tmp/work",
    }
    r1 = _run_render(tmp_path, env)
    assert r1.returncode == 0, r1.stderr
    first = (claude_dir / "settings.json").read_bytes()
    r2 = _run_render(tmp_path, env)
    assert r2.returncode == 0, r2.stderr
    second = (claude_dir / "settings.json").read_bytes()
    assert first == second
