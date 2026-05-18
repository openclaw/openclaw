"""Tests for the rockie-gpu CLI token/api-base resolution + `list` alias.

The CLI file lives at ``overlay/multitenant/rockie-gpu`` (no ``.py``
extension, hyphen in name), so we load it via ``SourceFileLoader``
rather than a normal import.

Run from the repo root with:

    uv run --with pytest pytest overlay/multitenant/tests/ -v
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest


CLI_PATH = Path(__file__).resolve().parents[1] / "rockie-gpu"


@pytest.fixture()
def cli():
    """Fresh import of the CLI module for each test so module-level
    state (none today, but defensive) doesn't leak between cases."""
    loader = importlib.machinery.SourceFileLoader("rockie_gpu_cli", str(CLI_PATH))
    spec = importlib.util.spec_from_loader("rockie_gpu_cli", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch, tmp_path):
    """Every test starts with no token env vars and HOME pointed at a
    tmp dir, so we never touch the real ``~/.rockie/config.json``."""
    monkeypatch.delenv("ROCKIELAB_TENANT_TOKEN", raising=False)
    monkeypatch.delenv("BROKER_TENANT_TOKEN", raising=False)
    monkeypatch.delenv("ROCKIELAB_API_BASE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    # macOS expanduser also consults USERPROFILE on some shells; clear it.
    monkeypatch.delenv("USERPROFILE", raising=False)
    yield


def _write_config(home: Path, payload) -> Path:
    cfg_dir = home / ".rockie"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = cfg_dir / "config.json"
    if isinstance(payload, str):
        cfg_path.write_text(payload, encoding="utf-8")
    else:
        cfg_path.write_text(json.dumps(payload), encoding="utf-8")
    return cfg_path


# ---------------------------------------------------------------------------
# Token resolution
# ---------------------------------------------------------------------------


def test_canonical_env_var_wins_over_legacy(cli, monkeypatch):
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "t-aaa")
    monkeypatch.setenv("BROKER_TENANT_TOKEN", "t-bbb")
    assert cli._get_token() == "t-aaa"


def test_legacy_env_var_used_when_canonical_unset(cli, monkeypatch):
    monkeypatch.setenv("BROKER_TENANT_TOKEN", "t-bbb")
    assert cli._get_token() == "t-bbb"


def test_config_file_used_when_both_env_vars_unset(cli, tmp_path):
    _write_config(tmp_path, {"tenant_token": "t-ccc"})
    assert cli._get_token() == "t-ccc"


def test_get_token_raises_when_nothing_set(cli):
    # No env vars (isolate_env cleared them), no config file written.
    with pytest.raises(cli.CLIError) as excinfo:
        cli._get_token()
    # Exit code 2 — same class as argparse usage errors. The CLI cannot
    # do anything useful without a tenant token, so we surface it as a
    # configuration/usage problem rather than a network error (1).
    assert excinfo.value.exit_code == 2
    assert "tenant token" in str(excinfo.value).lower()


# ---------------------------------------------------------------------------
# api_base resolution (bonus — ladder parallels token resolution)
# ---------------------------------------------------------------------------


def test_api_base_env_var_wins(cli, monkeypatch, tmp_path):
    _write_config(tmp_path, {"api_base": "https://config.example"})
    monkeypatch.setenv("ROCKIELAB_API_BASE", "https://env.example")
    assert cli._get_api_base() == "https://env.example"


def test_api_base_falls_back_to_config(cli, tmp_path):
    _write_config(tmp_path, {"api_base": "https://config.example"})
    assert cli._get_api_base() == "https://config.example"


def test_api_base_falls_back_to_default(cli):
    assert cli._get_api_base() == cli.API_BASE_DEFAULT


# ---------------------------------------------------------------------------
# Malformed config tolerance
# ---------------------------------------------------------------------------


def test_malformed_config_returns_empty_dict(cli, tmp_path, capsys):
    _write_config(tmp_path, "{not valid json")
    result = cli._load_local_config()
    assert result == {}
    captured = capsys.readouterr()
    assert "warning" in captured.err.lower()


def test_missing_config_returns_empty_dict(cli):
    assert cli._load_local_config() == {}


# ---------------------------------------------------------------------------
# argparse `list` alias dispatches to the same handler as `list-prices`
# ---------------------------------------------------------------------------


def test_list_alias_dispatches_to_list_prices_handler(cli):
    parser = cli.build_parser()
    canonical = parser.parse_args(["list-prices"])
    alias = parser.parse_args(["list"])
    # `is` equality — not a string match — per Phase-3.5 audit fix:
    # argparse aliases display the canonical name in --help, so a
    # textual comparison would be misleading.
    assert alias.func is canonical.func


