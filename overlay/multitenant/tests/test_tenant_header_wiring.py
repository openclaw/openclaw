from __future__ import annotations

from pathlib import Path


OVERLAY = Path(__file__).resolve().parents[1]


def test_entrypoint_does_not_alias_tenant_token_to_tenant_id():
    src = (OVERLAY / "entrypoint.sh").read_text(encoding="utf-8")

    assert 'export ROCKIELAB_TENANT_TOKEN="$ROCKIELAB_TENANT_ID"' not in src
    assert 'ROCKIELAB_TENANT_TOKEN="${ROCKIELAB_TENANT_DEV_TOKEN}"' in src
    assert 'ROCKIELAB_TENANT_DEV_TOKEN="${ROCKIELAB_TENANT_TOKEN}"' in src
    assert 'export ROCKIELAB_API_URL="${ROCKIELAB_API_URL:-${ROCKIELAB_API_BASE}}"' in src
    assert "ROCKIELAB_API_URL: $api_url" in src
    assert "ROCKIELAB_TENANT_DEV_TOKEN: $tenant_token" in src
    assert "ROCKIELAB_TENANT_ID: $tenant_id" in src


def test_mcp_rockie_sends_auth_token_and_tenant_id_headers():
    src = (OVERLAY / "mcp-rockie" / "server.js").read_text(encoding="utf-8")

    assert (
        "process.env.ROCKIELAB_TENANT_TOKEN || process.env.ROCKIELAB_TENANT_DEV_TOKEN"
        in src
    )
    assert 'h["X-Tenant-Token"] = TENANT_TOKEN' in src
    assert 'h["X-Tenant-Id"] = TENANT_ID' in src
    assert '"User-Agent": ROCKIE_RUNTIME_USER_AGENT' in src


def test_git_credential_helper_sends_auth_token_and_tenant_id_headers():
    src = (OVERLAY / "runtime" / "git-credential-rockie.sh").read_text(
        encoding="utf-8"
    )

    assert (
        'tenant_token="${ROCKIELAB_TENANT_TOKEN:-${ROCKIELAB_TENANT_DEV_TOKEN:-}}"'
        in src
    )
    assert '-H "User-Agent: ${runtime_user_agent}"' in src
    assert '-H "X-Tenant-Token: ${tenant_token}"' in src
    assert '-H "X-Tenant-Id: ${ROCKIELAB_TENANT_ID}"' in src


def test_user_skill_sync_identifies_rockie_runtime():
    src = (OVERLAY / "sync-user-skills.sh").read_text(encoding="utf-8")

    assert 'RUNTIME_USER_AGENT="rockie-runtime/1.0 (+https://api.rockielab.com)"' in src
    assert '-H "User-Agent: ${RUNTIME_USER_AGENT}"' in src


# #1218 — operator attestation (X-Operator-Tenant-Id) plumbing


def test_mcp_rockie_sends_operator_tenant_id_header_when_set():
    """The MCP server reads ROCKIELAB_OPERATOR_TENANT_ID and forwards
    it as X-Operator-Tenant-Id on every API call (#1218). Empty env =
    no header (legacy path)."""
    src = (OVERLAY / "mcp-rockie" / "server.js").read_text(encoding="utf-8")

    assert "process.env.ROCKIELAB_OPERATOR_TENANT_ID" in src
    assert 'h["X-Operator-Tenant-Id"] = OPERATOR_TENANT_ID' in src
    # Conditional on truthy env var — empty string = no header sent.
    assert "if (OPERATOR_TENANT_ID) h" in src


def test_rockie_compute_sends_operator_tenant_id_header_when_set():
    """rockie-compute CLI reads ROCKIELAB_OPERATOR_TENANT_ID and
    injects it into request headers (#1218)."""
    src = (OVERLAY / "rockie-compute").read_text(encoding="utf-8")

    assert 'OPERATOR_TENANT_ID = os.environ.get("ROCKIELAB_OPERATOR_TENANT_ID"' in src
    assert 'headers["X-Operator-Tenant-Id"] = OPERATOR_TENANT_ID' in src
    assert '"User-Agent": ROCKIE_RUNTIME_USER_AGENT' in src


def test_rockie_gpu_sends_operator_tenant_id_header_when_set():
    """rockie-gpu CLI reads ROCKIELAB_OPERATOR_TENANT_ID and injects
    it into request headers (#1218)."""
    src = (OVERLAY / "rockie-gpu").read_text(encoding="utf-8")

    assert 'os.environ.get("ROCKIELAB_OPERATOR_TENANT_ID"' in src
    assert 'headers["X-Operator-Tenant-Id"] = op_tid' in src
