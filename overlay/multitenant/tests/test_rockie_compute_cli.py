from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path


COMPUTE_PATH = Path(__file__).resolve().parents[1] / "rockie-compute"


def _load_compute(name: str = "rockie_compute"):
    loader = importlib.machinery.SourceFileLoader(name, str(COMPUTE_PATH))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_build_request_sends_auth_token_and_tenant_id(monkeypatch):
    monkeypatch.setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-compute")
    compute = _load_compute()

    req = compute._build_request("GET", "/api/compute/target", None)
    headers = dict(req.header_items())

    assert headers["X-tenant-token"] == "service-token"
    assert headers["X-tenant-id"] == "t-compute"


def test_build_request_uses_tenant_dev_token_alias(monkeypatch):
    monkeypatch.delenv("ROCKIELAB_TENANT_TOKEN", raising=False)
    monkeypatch.setenv("ROCKIELAB_TENANT_DEV_TOKEN", "dev-service-token")
    monkeypatch.setenv("ROCKIELAB_TENANT_ID", "t-compute")
    compute = _load_compute("rockie_compute_dev_token_alias")

    req = compute._build_request("GET", "/api/compute/target", None)
    headers = dict(req.header_items())

    assert headers["X-tenant-token"] == "dev-service-token"
    assert headers["X-tenant-id"] == "t-compute"
