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


def test_git_credential_helper_sends_auth_token_and_tenant_id_headers():
    src = (OVERLAY / "runtime" / "git-credential-rockie.sh").read_text(
        encoding="utf-8"
    )

    assert (
        'tenant_token="${ROCKIELAB_TENANT_TOKEN:-${ROCKIELAB_TENANT_DEV_TOKEN:-}}"'
        in src
    )
    assert '-H "X-Tenant-Token: ${tenant_token}"' in src
    assert '-H "X-Tenant-Id: ${ROCKIELAB_TENANT_ID}"' in src
