"""Vercel deployment health check.

Verifies project exists, lists recent deployments, and checks that the
expected production domain is attached.
"""
from __future__ import annotations

from typing import Any

from packages.webops.providers.vercel import VercelClient


def run_vercel_project_check(
    vc: VercelClient,
    *,
    project_name: str,
    expected_prod_domain: str | None = None,
) -> dict[str, Any]:
    """Check a single Vercel project: existence, deployments, domain config."""
    proj = vc.get_project(project_name)
    if not proj:
        return {"ok": False, "error": "project_not_found", "project_name": project_name}

    pid = proj.get("id", "")
    deps = vc.list_deployments(project_id=pid, limit=5)
    domains = vc.list_domains(project_name)

    domain_ok = True
    if expected_prod_domain:
        domain_ok = any(d.get("name") == expected_prod_domain for d in domains)

    return {
        "ok": True,
        "project_id": pid,
        "project_name": project_name,
        "deployments": [
            {
                "id": d.get("uid") or d.get("id"),
                "state": d.get("state"),
                "created": d.get("created"),
            }
            for d in deps
        ],
        "domains_ok": domain_ok,
    }
