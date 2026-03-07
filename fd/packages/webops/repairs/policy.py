"""WebOps repair policy — classify failures into safe vs risky actions.

Safe actions are low-risk + reversible (cache purge, redeploy latest).
Risky actions require a Repair Plan and human approval before execution.
"""
from __future__ import annotations

from typing import Any

SAFE_ACTIONS: dict[str, str] = {
    "cloudflare_purge_cache": "Purge Cloudflare cache (safe, reversible).",
    "vercel_redeploy_latest": "Redeploy latest Vercel deployment (safe, no code changes).",
}

RISKY_ACTIONS: dict[str, str] = {
    "stripe_create_or_update_webhook": "Create/update Stripe webhook endpoint (requires approval).",
    "webflow_publish_site": "Publish Webflow site (requires approval).",
    "inject_tracking_tags": "Modify site tracking tags (requires approval).",
    "vercel_bind_domain": "Bind/alter project domain config (requires approval).",
}


def classify_repairs(
    site_score: dict[str, Any],
    raw_check_payload: dict[str, Any],
) -> dict[str, Any]:
    """Turn site failures into safe actions + risky plan steps.

    Args:
        site_score: From score_sites() — status, failures, warnings.
        raw_check_payload: Full run payload (unused in v1, reserved for
            deeper heuristics later).

    Returns:
        {"safe": [...], "risky_plan": [...]}
    """
    safe: list[dict[str, Any]] = []
    risky: list[dict[str, Any]] = []

    site_key = site_score["site_key"]
    failures = site_score.get("failures", [])

    for f in failures:
        tool = f["tool"]
        check = f["check"]
        reason = f.get("reason", "")

        if tool == "cloudflare":
            safe.append({
                "action": "cloudflare_purge_cache",
                "params": {"site_key": site_key, "purge_everything": False},
                "why": (
                    f"Cloudflare check failed ({check}:{reason}); "
                    "cache purge can resolve stale SSL/DNS propagation issues."
                ),
            })

        elif tool == "vercel":
            safe.append({
                "action": "vercel_redeploy_latest",
                "params": {"site_key": site_key},
                "why": (
                    f"Vercel check failed ({check}:{reason}); "
                    "redeploy can clear transient deployment issues."
                ),
            })

        elif tool == "stripe":
            risky.append({
                "action": "stripe_create_or_update_webhook",
                "params": {"site_key": site_key},
                "why": (
                    "Stripe webhook mismatch/missing requires precise "
                    "endpoint + events and should be approved."
                ),
            })

        elif tool == "tracking":
            risky.append({
                "action": "inject_tracking_tags",
                "params": {"site_key": site_key},
                "why": (
                    "Tracking tag missing requires editing site code; "
                    "propose a repair plan for approval."
                ),
            })

        elif tool == "webflow":
            risky.append({
                "action": "webflow_publish_site",
                "params": {"site_key": site_key},
                "why": (
                    "Webflow publish/domain repair can impact production; "
                    "propose a repair plan for approval."
                ),
            })

    # De-duplicate by action name
    def _dedupe(lst: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for a in lst:
            k = a["action"]
            if k in seen:
                continue
            seen.add(k)
            out.append(a)
        return out

    safe = [a for a in _dedupe(safe) if a["action"] in SAFE_ACTIONS]
    risky = [a for a in _dedupe(risky) if a["action"] in RISKY_ACTIONS]

    return {"safe": safe, "risky_plan": risky}
