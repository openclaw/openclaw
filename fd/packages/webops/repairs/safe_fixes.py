"""WebOps safe fixes — low-risk, reversible repair actions.

Currently supported:
- Cloudflare: purge cache for specific URLs or entire zone
- Vercel: redeploy latest production deployment (no code changes)
"""
from __future__ import annotations

from typing import Any

from packages.webops.providers.cloudflare import CloudflareClient
from packages.webops.providers.vercel import VercelClient


def run_cloudflare_purge(
    cf: CloudflareClient,
    *,
    zone_name: str,
    urls: list[str] | None,
    purge_everything: bool,
) -> dict[str, Any]:
    """Purge cache for a zone — specific URLs or everything."""
    zone_id = cf.get_zone_id(zone_name)
    if not zone_id:
        return {"ok": False, "error": "zone_not_found", "zone_name": zone_name}
    res = cf.purge_cache(zone_id, purge_everything=purge_everything, urls=urls)
    return {"ok": bool(res.get("success")), "response": res}


def run_vercel_redeploy(
    vc: VercelClient,
    *,
    project_name: str,
) -> dict[str, Any]:
    """Redeploy the newest deployment for a Vercel project."""
    proj = vc.get_project(project_name)
    if not proj:
        return {"ok": False, "error": "project_not_found", "project_name": project_name}

    deployments = vc.list_deployments(project_id=proj.get("id"), limit=5)
    if not deployments:
        return {"ok": False, "error": "no_deployments_found"}

    dep = deployments[0]
    dep_id = dep.get("uid") or dep.get("id")
    if not dep_id:
        return {"ok": False, "error": "deployment_id_missing"}

    out = vc.redeploy(dep_id)
    return {"ok": True, "deployment_id": dep_id, "redeploy_response": out}
