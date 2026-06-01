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


def _extract_function(name: str) -> str:
    """Return the body of a top-level shell function from entrypoint.sh.

    We match from ``name() {`` through the matching closing brace at
    column 0 — these functions are defined at the top level so a bare
    ``^}$`` is the correct terminator.
    """
    src = ENTRYPOINT.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^{re.escape(name)}\(\)\s*\{{\n(?P<body>.*?)^\}}\n",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(src)
    assert m is not None, f"{name}() not found in entrypoint.sh"
    return m.group("body")


def _extract_render_fn() -> str:
    return _extract_function("render_settings_json")


def _run_render(
    tmp_path: Path,
    env_overrides: dict[str, str],
    *,
    rewrite_paths: bool = True,
    copy_home_template: bool = True,
    bundle_template_root: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    """Spawn ``bash`` running just ``render_settings_json``, with
    ``/home/runtime/.claude`` rewritten to ``tmp_path/.claude`` so we
    can exercise it without root."""
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    if copy_home_template:
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
    if bundle_template_root is not None:
        env["ROCKIE_HOME_BUNDLE"] = str(bundle_template_root)
    env.update(env_overrides)

    return subprocess.run(
        ["bash", "-c", script],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _run_hydrate(tmp_path: Path) -> subprocess.CompletedProcess[str]:
    home = tmp_path / "home"
    bundle = tmp_path / "bundle"
    script_parts = [
        "set -euo pipefail",
        "log() { printf '[entrypoint] %s\\n' \"$*\" >&2; }",
    ]
    for name in (
        "sync_named_children",
        "sync_platform_tree",
        "hydrate_platform_home_bundle",
    ):
        script_parts.append(f"{name}() {{\n{_extract_function(name)}}}")
    script_parts.append("hydrate_platform_home_bundle")
    return subprocess.run(
        ["bash", "-c", "\n".join(script_parts)],
        env={
            "HOME": str(home),
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "ROCKIE_HOME_BUNDLE": str(bundle),
        },
        capture_output=True,
        text=True,
        check=False,
    )


def _write(path: Path, text: str = "x\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


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
    assert data["env"]["OPENCLAW_WORKSPACE_DIR"] == "/tmp/work"
    assert data["env"]["OPENCLAW_SKILLS_DIR"] == "/home/runtime/.claude/skills"
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
    assert data["env"]["OPENCLAW_WORKSPACE_DIR"] == "/tmp/work"


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
    assert data["env"]["OPENCLAW_WORKSPACE_DIR"] == "/home/runtime"
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


def test_existing_settings_json_is_preserved(tmp_path: Path, claude_dir: Path) -> None:
    claude_dir.mkdir(parents=True, exist_ok=True)
    existing = '{"tenant":"custom"}\n'
    (claude_dir / "settings.json").write_text(existing, encoding="utf-8")

    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-new",
            "ROCKIELAB_TENANT_ID": "t-new",
            "PLATFORM_TARGET_DIR": "/tmp/new",
        },
    )

    assert result.returncode == 0, result.stderr
    assert "preserving tenant-managed file" in result.stderr
    assert (claude_dir / "settings.json").read_text(encoding="utf-8") == existing


def test_baseline_empty_settings_json_is_rendered(tmp_path: Path, claude_dir: Path) -> None:
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "settings.json").write_text("{}\n", encoding="utf-8")

    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-replace",
            "ROCKIELAB_TENANT_ID": "t-replace",
            "PLATFORM_TARGET_DIR": "/tmp/replace",
        },
    )

    assert result.returncode == 0, result.stderr
    data = json.loads((claude_dir / "settings.json").read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_LAB_ID"] == "l-replace"
    assert data["env"]["PLATFORM_TENANT_ID"] == "t-replace"


def test_render_uses_image_bundle_template_when_home_template_is_hidden(
    tmp_path: Path, claude_dir: Path
) -> None:
    bundle = tmp_path / "bundle"
    bundle_template = bundle / ".claude" / "settings.json.j2"
    bundle_template.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(TEMPLATE, bundle_template)

    result = _run_render(
        tmp_path,
        {
            "PLATFORM_LAB_ID": "l-bundle",
            "ROCKIELAB_TENANT_ID": "t-bundle",
            "PLATFORM_TARGET_DIR": "/tmp/bundle-work",
        },
        copy_home_template=False,
        bundle_template_root=bundle,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads((claude_dir / "settings.json").read_text(encoding="utf-8"))
    assert data["env"]["PLATFORM_LAB_ID"] == "l-bundle"
    assert data["env"]["PLATFORM_TENANT_ID"] == "t-bundle"
    assert data["env"]["PLATFORM_TARGET_DIR"] == "/tmp/bundle-work"
    assert data["env"]["OPENCLAW_WORKSPACE_DIR"] == "/tmp/bundle-work"


def test_hydrate_syncs_platform_paths_without_overwriting_tenant_data(tmp_path: Path) -> None:
    home = tmp_path / "home"
    bundle = tmp_path / "bundle"

    _write(
        bundle / ".claude" / "skills" / "inference-engineer" / "SKILL.md",
        "platform\n",
    )
    _write(bundle / ".claude" / "skills" / "experiment" / "SKILL.md", "platform\n")
    _write(bundle / ".claude" / "commands" / "inference-engineer.md", "command\n")
    _write(bundle / ".claude" / "hooks" / "role-pre-bash-guard.sh", "hook\n")
    _write(bundle / ".claude" / "platform-memory" / "schema.sql", "memory\n")
    _write(bundle / ".claude" / "platform-templates" / "lab.md", "template\n")
    _write(bundle / ".claude" / "platform-scripts" / "init.sh", "script\n")
    _write(bundle / ".claude" / "platform-docs" / "guide.md", "docs\n")
    _write(
        bundle / ".codex" / "skills" / "inference-engineer" / "SKILL.md",
        "codex\n",
    )
    _write(bundle / ".codex" / "commands" / "inference-engineer.md", "codex command\n")

    _write(home / ".claude" / "settings.json", '{"tenant":"custom"}\n')
    _write(home / ".claude" / "mcp.json", '{"custom":true}\n')
    _write(home / ".claude" / "backups" / "keep.txt", "backup\n")
    _write(home / ".claude" / "unknown" / "keep.txt", "unknown\n")
    _write(home / ".claude" / "skills" / "custom-skill" / "SKILL.md", "tenant\n")
    _write(
        home / ".claude" / "skills" / "inference-engineer" / "stale.txt",
        "stale\n",
    )
    _write(home / ".claude" / "hooks" / "stale-hook.sh", "stale\n")
    _write(home / ".codex" / "skills" / "custom-codex" / "SKILL.md", "tenant\n")

    result = _run_hydrate(tmp_path)

    assert result.returncode == 0, result.stderr
    assert (
        "hydrate_platform_home_bundle: synced claude_skills=3 codex_skills=2"
        in result.stderr
    )
    assert str(bundle) in result.stderr

    assert (home / ".claude" / "skills" / "inference-engineer" / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "platform\n"
    assert not (home / ".claude" / "skills" / "inference-engineer" / "stale.txt").exists()
    assert (home / ".claude" / "skills" / "custom-skill" / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "tenant\n"
    assert (home / ".codex" / "skills" / "custom-codex" / "SKILL.md").exists()
    assert (home / ".claude" / "hooks" / "role-pre-bash-guard.sh").exists()
    assert not (home / ".claude" / "hooks" / "stale-hook.sh").exists()

    assert (
        (home / ".claude" / "settings.json").read_text(encoding="utf-8")
        == '{"tenant":"custom"}\n'
    )
    assert (home / ".claude" / "mcp.json").read_text(encoding="utf-8") == '{"custom":true}\n'
    assert (home / ".claude" / "backups" / "keep.txt").read_text(encoding="utf-8") == "backup\n"
    assert (home / ".claude" / "unknown" / "keep.txt").read_text(encoding="utf-8") == "unknown\n"


def test_hydrate_missing_bundle_is_non_fatal(tmp_path: Path) -> None:
    result = _run_hydrate(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "not present; skipping" in result.stderr
