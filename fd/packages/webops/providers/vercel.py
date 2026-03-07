"""Vercel API client — projects, deployments, domains.

Thin wrapper around Vercel REST API with rate limiting and retries.
Used by WebOps checks to verify deployment state and domain config.
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.rate_limit import RateLimiter


class VercelClient:
    """Vercel REST API client with rate limiting."""

    BASE = "https://api.vercel.com"

    def __init__(self, api_token: str, limiter: RateLimiter) -> None:
        self.api_token = api_token
        self.limiter = limiter

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }

    # ── Projects ───────────────────────────────────────

    def get_project(self, project_name: str) -> dict[str, Any] | None:
        """Fetch project metadata by name. Returns None if not found."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/v9/projects/{project_name}",
            headers=self._headers(),
            timeout=20,
        ))
        return r.json() if r.status_code == 200 else None

    # ── Deployments ────────────────────────────────────

    def list_deployments(
        self,
        *,
        project_id: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """List recent deployments, optionally filtered by project."""
        params: dict[str, Any] = {"limit": limit}
        if project_id:
            params["projectId"] = project_id
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/v6/deployments",
            headers=self._headers(),
            params=params,
            timeout=20,
        ))
        data = r.json()
        return data.get("deployments", []) if isinstance(data, dict) else []

    # ── Domains ────────────────────────────────────────

    def list_domains(self, project_name: str) -> list[dict[str, Any]]:
        """List domains attached to a project."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.get(
            f"{self.BASE}/v9/projects/{project_name}/domains",
            headers=self._headers(),
            timeout=20,
        ))
        data = r.json()
        return data.get("domains", []) if isinstance(data, dict) else []

    # ── Redeploy ───────────────────────────────────────

    def redeploy(self, deployment_id: str) -> dict[str, Any]:
        """Trigger a redeploy for an existing deployment."""
        self.limiter.wait()
        r = with_retries(lambda: httpx.post(
            f"{self.BASE}/v13/deployments/{deployment_id}/redeploy",
            headers=self._headers(),
            timeout=30,
        ))
        return r.json()
