"""Tests for the rockie-gpu CLI tenant/api-base resolution + `list` alias.

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
    """Every test starts with no tenant env vars and HOME pointed at a
    tmp dir, so we never touch the real ``~/.rockie/config.json``."""
    monkeypatch.delenv("ROCKIELAB_TENANT_ID", raising=False)
    monkeypatch.delenv("ROCKIELAB_TENANT_TOKEN", raising=False)
    monkeypatch.delenv("ROCKIELAB_TENANT_DEV_TOKEN", raising=False)
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
# Tenant identity resolution
# ---------------------------------------------------------------------------


def test_tenant_id_env_var_is_used(cli, monkeypatch):
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-aaa")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("BROKER_TENANT_TOKEN", "broker-token")
    assert cli._get_token() == "service-token"
    assert cli._get_tenant_id() == "t-aaa"


def test_tenant_dev_token_alias_is_used_for_auth(cli, monkeypatch):
    monkeypatch.setenv("ROCKIELAB_TENANT_DEV_TOKEN", "dev-service-token")

    assert cli._get_token() == "dev-service-token"


def test_config_file_tenant_token_is_not_identity(cli, tmp_path):
    _write_config(tmp_path, {"tenant_token": "t-ccc"})
    with pytest.raises(cli.CLIError) as excinfo:
        cli._get_tenant_id()
    assert excinfo.value.exit_code == 2
    assert "rockielab_tenant_id" in str(excinfo.value).lower()


def test_get_token_raises_when_nothing_set(cli):
    # No env vars (isolate_env cleared them), no config file written.
    with pytest.raises(cli.CLIError) as excinfo:
        cli._get_token()
    # Exit code 2 — same class as argparse usage errors. The CLI cannot
    # do anything useful without a tenant id, so we surface it as a
    # configuration/usage problem rather than a network error (1).
    assert excinfo.value.exit_code == 2
    assert "rockielab_tenant_token" in str(excinfo.value).lower()


def test_build_request_sends_auth_token_and_tenant_id(cli, monkeypatch):
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-aaa")
    headers = cli._build_headers()
    assert headers["X-Tenant-Token"] == "service-token"
    assert headers["X-Tenant-Id"] == "t-aaa"


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


def test_provision_verifies_broker_status_before_success(
    cli, monkeypatch, capsys
):
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-demo")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method: str, path: str, body=None):
        calls.append((method, path, body))
        if method == "POST" and path == "/api/gpu/provision":
            return {
                "pod_id": "cfom41v9yy9ze7",
                "provider": "runpod",
                "gpu_type": "A40_48GB",
                "status": "RUNNING",
                "estimated_cost_cents": 14,
                "dry_run": False,
            }
        if method == "GET" and path == (
            "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod"
        ):
            return {"pod_id": "cfom41v9yy9ze7", "provider": "runpod", "state": "RUNNING"}
        raise AssertionError((method, path, body))

    monkeypatch.setattr(cli, "_http", fake_http)

    rc = cli.main(["provision", "--gpu", "A40_48GB", "--hours", "0.25"])

    assert rc == 0
    assert calls[0][0:2] == ("POST", "/api/gpu/provision")
    assert calls[1][0:2] == (
        "GET",
        "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod",
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["pod_id"] == "cfom41v9yy9ze7"
    assert payload["tenant_id"] == "t-demo"
    assert payload["ownership_check_status"] == "VERIFIED"


def test_provision_reports_unverified_when_status_says_pod_not_owned(
    cli, monkeypatch, capsys
):
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-99562d476fef")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")

    def fake_http(method: str, path: str, body=None):
        if method == "POST" and path == "/api/gpu/provision":
            return {
                "pod_id": "cfom41v9yy9ze7",
                "provider": "runpod",
                "gpu_type": "A40_48GB",
                "status": "RUNNING",
                "estimated_cost_cents": 14,
                "dry_run": False,
            }
        if method == "GET" and path == (
            "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod"
        ):
            raise cli.CLIError(
                'HTTP 403: {"detail":{"error":{"code":"pod_not_owned"}}}',
                exit_code=3,
                http_status=403,
                payload={"detail": {"error": {"code": "pod_not_owned"}}},
            )
        raise AssertionError((method, path, body))

    monkeypatch.setattr(cli, "_http", fake_http)

    rc = cli.main(["provision", "--gpu", "A40_48GB", "--hours", "0.25"])

    assert rc == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "PROVISION_UNVERIFIED"
    assert payload["pod_id"] == "cfom41v9yy9ze7"
    assert payload["provider"] == "runpod"
    assert payload["gpu_type"] == "A40_48GB"
    assert payload["estimated_cost_cents"] == 14
    assert payload["tenant_id"] == "t-99562d476fef"
    assert payload["ownership_check_status"] == "FAILED"
    assert payload["ownership_check_error"]["code"] == "pod_not_owned"
