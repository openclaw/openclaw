from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path

import pytest


LOOP_PATH = Path(__file__).resolve().parents[1] / "rockie-loop" / "rockie_loop.py"


def _load_loop(name: str = "rockie_loop"):
    loader = importlib.machinery.SourceFileLoader(name, str(LOOP_PATH))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture()
def loop():
    return _load_loop()


def test_gpu_smoke_queue_row_uses_broker_provision_and_teardown(loop, monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method: str, path: str, body=None, **_kwargs):
        calls.append((method, path, body))
        if method == "POST" and path == "/api/gpu/provision":
            return {
                "pod_id": "pod/403",
                "provider": "runpod",
                "gpu_type": "A40_48GB",
            }
        if method == "GET" and path == "/api/gpu/pods/pod%2F403/status?provider=runpod":
            return {
                "pod_id": "pod/403",
                "provider": "runpod",
                "state": "RUNNING",
            }
        return {}

    monkeypatch.setattr(loop, "_http", fake_http)
    monkeypatch.setattr(loop, "_submit_experiment", lambda _spec: pytest.fail())

    handle, summary = loop._launch_queued_row(
        "lab-1",
        {
            "id": "queue-1",
            "title": "Dogfood small GPU smoke run",
            "rationale": "bounded dogfood smoke staging",
            "spec": {
                "kind": "gpu_smoke",
                "gpu_type": "A40_48GB",
                "gpu_count": 1,
                "spot": True,
                "hours": 0.25,
                "route_quote_available": True,
                "route_quote_provider": "runpod",
                "route_quote_gpu_type": "A40_48GB",
                "route_quote_region": "ord",
                "route_quote_spot": True,
                "dry_run_preflight": True,
                "dry_run_preflight_pod_id": "dryrun-403",
            },
        },
    )

    assert handle == "gpu:runpod:pod/403"
    assert summary == "gpu smoke provisioned and torn down: 'Dogfood small GPU smoke run'"
    assert calls[0] == (
        "POST",
        "/api/gpu/provision",
        {
            "gpu_type": "A40_48GB",
            "gpu_count": 1,
            "spot": True,
            "hours": 0.25,
            "name": "rockie-dogfood-gpu-smoke",
            "region": "ord",
        },
    )
    assert calls[1] == ("GET", "/api/gpu/pods/pod%2F403/status?provider=runpod", None)
    assert calls[2] == ("DELETE", "/api/gpu/pods/pod%2F403?provider=runpod", None)
    assert calls[3] == (
        "POST",
        "/api/labs/lab-1/loop-queue/queue-1/state",
        {"state": "done", "experiment_id": "gpu:runpod:pod/403"},
    )
    assert calls[4][0:2] == ("POST", "/api/agent-tools/emit_artifact")


def test_build_request_sends_auth_token_and_tenant_id(loop, monkeypatch):
    monkeypatch.setattr(loop, "TENANT_TOKEN", "service-token")
    monkeypatch.setattr(loop, "TENANT_ID", "t-loop")

    req = loop._build_request("GET", "/api/labs/lab-1/loop-state")
    headers = dict(req.header_items())

    assert headers["X-tenant-token"] == "service-token"
    assert headers["X-tenant-id"] == "t-loop"


def test_build_request_uses_tenant_dev_token_alias(monkeypatch):
    monkeypatch.delenv("ROCKIELAB_TENANT_TOKEN", raising=False)
    monkeypatch.setenv("ROCKIELAB_TENANT_DEV_TOKEN", "dev-service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-loop")
    loop = _load_loop("rockie_loop_dev_token_alias")

    req = loop._build_request("GET", "/api/labs/lab-1/loop-state")
    headers = dict(req.header_items())

    assert headers["X-tenant-token"] == "dev-service-token"
    assert headers["X-tenant-id"] == "t-loop"


def test_gpu_smoke_queue_row_fails_when_broker_status_rejects_ownership(
    loop, monkeypatch
):
    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method: str, path: str, body=None, **_kwargs):
        calls.append((method, path, body))
        if method == "POST" and path == "/api/gpu/provision":
            return {
                "pod_id": "cfom41v9yy9ze7",
                "provider": "runpod",
                "gpu_type": "A40_48GB",
            }
        if method == "GET" and path == (
            "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod"
        ):
            raise loop.CLIError(
                'HTTP 403: {"detail":{"error":{"code":"pod_not_owned"}}}'
            )
        return {}

    monkeypatch.setattr(loop, "_http", fake_http)

    handle, summary = loop._launch_queued_row(
        "lab-1",
        {
            "id": "queue-1",
            "title": "demo repro",
            "spec": {
                "kind": "gpu_smoke",
                "gpu_type": "A40_48GB",
                "gpu_count": 1,
                "spot": True,
                "hours": 0.25,
                "route_quote_available": True,
                "route_quote_provider": "runpod",
                "route_quote_gpu_type": "A40_48GB",
                "route_quote_region": "ord",
                "route_quote_spot": True,
                "dry_run_preflight": True,
                "dry_run_preflight_pod_id": "dryrun-403",
            },
        },
    )

    assert handle == "gpu:runpod:cfom41v9yy9ze7"
    assert summary == "gpu smoke provision unverified: 'demo repro'"
    assert calls[0][0:2] == ("POST", "/api/gpu/provision")
    assert calls[1][0:2] == (
        "GET",
        "/api/gpu/pods/cfom41v9yy9ze7/status?provider=runpod",
    )
    assert calls[2][0:2] == (
        "DELETE",
        "/api/gpu/pods/cfom41v9yy9ze7?provider=runpod",
    )
    assert calls[3] == (
        "POST",
        "/api/labs/lab-1/loop-queue/queue-1/state",
        {
            "state": "failed",
            "experiment_id": "gpu:runpod:cfom41v9yy9ze7",
            "error": "gpu smoke provision unverified",
        },
    )


def test_gpu_smoke_queue_row_rejects_unbounded_or_credential_fields(loop, monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method: str, path: str, body=None, **_kwargs):
        calls.append((method, path, body))
        return {}

    monkeypatch.setattr(loop, "_http", fake_http)
    handle, summary = loop._launch_queued_row(
        "lab-1",
        {
            "id": "queue-1",
            "title": "bad smoke",
            "spec": {
                "kind": "gpu_smoke",
                "gpu_type": "A40_48GB",
                "gpu_count": 1,
                "spot": True,
                "hours": 0.25,
                "route_quote_available": True,
                "route_quote_provider": "runpod",
                "route_quote_gpu_type": "A40_48GB",
                "route_quote_spot": True,
                "dry_run_preflight": True,
                "dry_run_preflight_pod_id": "dryrun-403",
                "env": {"TOKEN": "nope"},
            },
        },
    )

    assert handle is None
    assert summary == "failed gpu smoke provision: 'bad smoke'"
    assert calls == [
        (
            "POST",
            "/api/labs/lab-1/loop-queue/queue-1/state",
            {"state": "failed", "error": "gpu smoke provision returned no pod"},
        )
    ]


def test_gpu_smoke_queue_row_requires_route_and_dry_run_evidence(loop, monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    def fake_http(method: str, path: str, body=None, **_kwargs):
        calls.append((method, path, body))
        return {}

    monkeypatch.setattr(loop, "_http", fake_http)
    handle, summary = loop._launch_queued_row(
        "lab-1",
        {
            "id": "queue-1",
            "title": "forged smoke",
            "spec": {
                "kind": "gpu_smoke",
                "gpu_type": "A40_48GB",
                "gpu_count": 1,
                "spot": True,
                "hours": 0.25,
            },
        },
    )

    assert handle is None
    assert summary == "failed gpu smoke provision: 'forged smoke'"
    assert calls == [
        (
            "POST",
            "/api/labs/lab-1/loop-queue/queue-1/state",
            {"state": "failed", "error": "gpu smoke provision returned no pod"},
        )
    ]


def test_idle_plan_prompt_contains_rockie_voice_directive_and_planning_contract(loop):
    prompt = loop._IDLE_PLAN_PROMPT

    for expected in (
        "Keep a gentle, dry Rockie voice.",
        "Occasional subtle rock puns or 🗿 are allowed only when they feel natural.",
        "Do not use rock puns or 🗿 in debugging, code, error analysis",
        "numerical/data analysis, citations, structured output",
        "serious/sensitive answers",
        "propose 1-3 next experiments",
        "active hypothesis or fill a calibration gap",
        "hypothesis_list + dead_end_search + calibration_brier_score",
        "experiment_submit only if the proposal passes adversarial review",
        "against the dead-end registry",
    ):
        assert expected in prompt
