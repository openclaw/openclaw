"""Tests for the rockie-gpu CLI tenant/api-base resolution.

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


def test_broker_tenant_token_alias_is_used_for_auth(cli, monkeypatch):
    # Post-#1123 the token ladder is ROCKIELAB_TENANT_TOKEN ->
    # BROKER_TENANT_TOKEN -> config `tenant_token` (see the module
    # docstring "Resolution order for the tenant auth token"). The old
    # ROCKIELAB_TENANT_DEV_TOKEN alias was dropped in the S7 rewrite, so
    # the legacy alias honored today is BROKER_TENANT_TOKEN.
    monkeypatch.setenv("BROKER_TENANT_TOKEN", "broker-service-token")

    assert cli._get_token() == "broker-service-token"


def test_canonical_tenant_token_wins_over_broker_alias(cli, monkeypatch):
    # The canonical env var takes precedence over the legacy alias —
    # falsifies a "last writer wins" / reversed-ladder regression.
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "canonical-token")
    monkeypatch.setenv("BROKER_TENANT_TOKEN", "broker-service-token")

    assert cli._get_token() == "canonical-token"


def test_config_file_tenant_token_is_legacy_identity_fallback(cli, tmp_path):
    # Post-#1123 _get_tenant_id() falls back to the config `tenant_token`
    # as a legacy identity source (older installs used the token as the
    # tenant id before X-Tenant-Id existed — see the module docstring
    # "tenant_token legacy fallback"). With nothing else configured the
    # token value is returned as the tenant id rather than raising.
    _write_config(tmp_path, {"tenant_token": "t-ccc"})
    assert cli._get_tenant_id() == "t-ccc"


def test_config_file_tenant_id_wins_over_legacy_token(cli, tmp_path):
    # When both keys are present the explicit `tenant_id` wins over the
    # legacy `tenant_token` fallback — falsifies a ladder that consults
    # the legacy key first.
    _write_config(tmp_path, {"tenant_id": "t-real", "tenant_token": "t-legacy"})
    assert cli._get_tenant_id() == "t-real"


def test_no_tenant_id_anywhere_raises_usage_error(cli):
    # Neither env nor config provides any identity source -> exit 2 with
    # the ROCKIELAB_TENANT_ID guidance. Keeps the "fail closed on missing
    # identity" contract falsifiable now that the happy path no longer
    # raises for a config tenant_token.
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
    # Post-#1123 the header-building logic lives inside _build_request,
    # which returns a urllib.request.Request — there is no standalone
    # _build_headers() helper. Assert the auth + identity headers land
    # on the request object.
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-aaa")
    req = cli._build_request("GET", "/api/gpu/market", None)
    # urllib title-cases header keys internally; get_header() re-titles
    # the lookup key so this comparison is case-stable.
    assert req.get_header("X-tenant-token") == "service-token"
    assert req.get_header("X-tenant-id") == "t-aaa"


def test_build_request_threads_extra_headers(cli, monkeypatch):
    # The extra_headers keyword (admin-debug X-Admin-Token path) must be
    # merged onto the request without clobbering the tenant headers.
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-aaa")
    req = cli._build_request(
        "POST", "/api/gpu/provision", {"gpu_type": "A40_48GB"},
        extra_headers={"X-Admin-Token": "admin-secret"},
    )
    assert req.get_header("X-admin-token") == "admin-secret"
    assert req.get_header("X-tenant-token") == "service-token"
    assert req.get_header("X-tenant-id") == "t-aaa"


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
# argparse rejects the removed list-prices/list command surface
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("verb", ["list-prices", "list"])
def test_removed_price_list_verbs_are_rejected(cli, verb, capsys):
    parser = cli.build_parser()
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args([verb])
    assert excinfo.value.code == 2
    assert "market" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# provision: post-#1123 the client-side ownership re-verification (the
# second provider-keyed status GET, plus tenant_id / ownership_check_status
# injection) only runs on the ADMIN-DEBUG + --provider path. cmd_provision
# gates it on ``admin is not None and args.provider`` (S7 #1123) because the
# deidentified tenant response carries no provider and its own server-side
# ownership_check_status, so a second provider-keyed hop would both fail and
# leak. The default tenant path emits the budgeted broker response verbatim.
# ---------------------------------------------------------------------------


def test_admin_debug_provision_verifies_broker_status_before_success(
    cli, monkeypatch, capsys
):
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-demo")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_ADMIN_TOKEN", "admin-secret")
    calls: list[tuple[str, str, dict | None, dict | None]] = []

    def fake_http(method: str, path: str, body=None, extra_headers=None):
        # Post-#1123 _http() accepts an extra_headers kwarg (admin-debug
        # threads X-Admin-Token through it); the provision call passes it
        # explicitly, so the stub must accept it.
        calls.append((method, path, body, extra_headers))
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

    rc = cli.main(
        [
            "provision", "--gpu", "A40_48GB", "--hours", "0.25",
            "--admin-debug", "--provider", "runpod",
        ]
    )

    assert rc == 0
    assert calls[0][0:2] == ("POST", "/api/gpu/provision")
    assert calls[1][0:2] == (
        "GET",
        "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod",
    )
    # Both hops thread the admin header (X-Admin-Token) on the admin-debug
    # path — falsifies a regression that dropped admin auth on the re-verify.
    assert calls[0][3] == {"X-Admin-Token": "admin-secret"}
    assert calls[1][3] == {"X-Admin-Token": "admin-secret"}
    payload = json.loads(capsys.readouterr().out)
    assert payload["pod_id"] == "cfom41v9yy9ze7"
    assert payload["tenant_id"] == "t-demo"
    assert payload["ownership_check_status"] == "VERIFIED"
    assert payload["broker_status"]["state"] == "RUNNING"


def test_admin_debug_provision_reports_unverified_when_pod_not_owned(
    cli, monkeypatch, capsys
):
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-99562d476fef")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_ADMIN_TOKEN", "admin-secret")

    def fake_http(method: str, path: str, body=None, extra_headers=None):
        # Accept the post-#1123 extra_headers kwarg (see the sibling
        # provision test for the rationale).
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

    rc = cli.main(
        [
            "provision", "--gpu", "A40_48GB", "--hours", "0.25",
            "--admin-debug", "--provider", "runpod",
        ]
    )

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


def test_tenant_provision_emits_broker_response_without_status_hop(
    cli, monkeypatch, capsys
):
    # The deidentified default path (no --admin-debug, no --provider) must
    # NOT make the second provider-keyed status GET and must NOT inject the
    # client-side tenant_id / ownership_check_status fields — the broker's
    # budgeted S3 response is emitted verbatim and the call returns 0.
    # This is the load-bearing S7 #1123 behavior: a second hop here would
    # both fail (no provider on the deidentified response) and leak.
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-demo")
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    calls: list[tuple[str, str, dict | None, dict | None]] = []

    def fake_http(method: str, path: str, body=None, extra_headers=None):
        calls.append((method, path, body, extra_headers))
        if method == "POST" and path == "/api/gpu/provision":
            return {
                "pod_id": "cfom41v9yy9ze7",
                "gpu_type": "A40_48GB",
                "status": "RUNNING",
                "estimated_cost_cents": 14,
                "ownership_check_status": "VERIFIED",
                "dry_run": False,
            }
        # A status GET here is a regression — the tenant path must not hop.
        raise AssertionError(("unexpected call", method, path))

    monkeypatch.setattr(cli, "_http", fake_http)

    rc = cli.main(["provision", "--gpu", "A40_48GB", "--hours", "0.25"])

    assert rc == 0
    # Exactly one HTTP call: the provision POST, with no admin header.
    assert len(calls) == 1
    assert calls[0][0:2] == ("POST", "/api/gpu/provision")
    assert calls[0][3] is None
    payload = json.loads(capsys.readouterr().out)
    # The broker response is passed through verbatim — no client-injected
    # tenant_id / broker_status keys, and provider is never present.
    assert payload["pod_id"] == "cfom41v9yy9ze7"
    assert payload["ownership_check_status"] == "VERIFIED"
    assert "tenant_id" not in payload
    assert "broker_status" not in payload
    assert "provider" not in payload
