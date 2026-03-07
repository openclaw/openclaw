"""Admin skills endpoints — skill discovery, widget rendering, fork workflow, UI.

POST /admin/skills/scan           — Run scout, write report files, return summary
POST /admin/skills/render_widget  — Write skills widget to Command Center (safe_mode default)
POST /admin/skills/fork_request   — Create checklist page + backlog item for a skill
GET  /admin/skills/ui             — Tiny HTML page with fork buttons

All endpoints require admin ops token.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_writer import create_skills_backlog_item
from packages.agencyu.notion.skills_checklist_template import create_skill_checklist_page
from packages.agencyu.notion.widgets.cc_skills_recommendations_writer import (
    write_cc_skills_recommendations,
)
from packages.agencyu.skills.models import SkillCandidate
from packages.agencyu.skills.scout_service import run_skills_scout
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.skills")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)

# ─────────────────────────────────────────
# Memory pain-point heuristics
# ─────────────────────────────────────────

_MEMORY_KEYWORDS = [
    "memory", "persistent", "context", "remember", "recall",
    "long-term", "longterm", "session", "state", "knowledge base",
    "knowledge graph", "vector", "embedding", "rag",
]


def _infer_pain_point(c: SkillCandidate) -> str:
    """Heuristic: tag candidates related to memory/persistence."""
    haystack = f"{c.title} {c.description} {c.skill_key} {' '.join(c.tags)}".lower()
    for kw in _MEMORY_KEYWORDS:
        if kw in haystack:
            return "Persistent Memory"
    return ""


def _infer_notes(c: SkillCandidate, pain_point: str) -> str:
    """Auto-generate notes based on pain point and signals."""
    parts: list[str] = []
    if pain_point == "Persistent Memory":
        parts.append("Memory-related skill — review context/state management approach.")
    if c.trust_tier == "official":
        parts.append("Official source — likely well-maintained.")
    elif c.trust_tier == "community":
        parts.append("Community source — extra review recommended.")
    return " ".join(parts)


# ─────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────


@router.post("/admin/skills/scan")
def scan_skills(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run the skills scout pipeline.

    Scans allowlisted sources, scores candidates, writes report files.
    Read-only: never installs or modifies anything beyond report files.
    """
    try:
        report = run_skills_scout("config/skills_sources.yaml")
        return {
            "ok": True,
            "generated_at": report.generated_at,
            "candidates_count": len(report.candidates),
            "top_full_digital": report.top_full_digital,
            "top_cutmv": report.top_cutmv,
            "do_not_install": report.do_not_install[:25],
        }
    except Exception as exc:
        log.error("skills_scan_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.post("/admin/skills/render_widget")
def render_skills_widget(
    _: None = Depends(require_admin_ops_token),
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Run scout and write the skills recommendations widget to Command Center."""
    try:
        report = run_skills_scout("config/skills_sources.yaml")

        client = NotionClient()
        api = NotionAPI(client=client)
        cc_page_id = _get_command_center_page_id()

        if not cc_page_id:
            return {"ok": False, "error": "command_center page not bound in notion_bindings"}

        result = write_cc_skills_recommendations(
            conn=_conn,
            notion_api=api,
            command_center_page_id=cc_page_id,
            report=report,
            safe_mode=safe_mode,
            correlation_id="skills_widget_render",
        )

        return {
            "ok": True,
            "mode": "simulate" if safe_mode else "apply",
            "result": result,
        }
    except Exception as exc:
        log.error("skills_render_widget_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.post("/admin/skills/fork_request")
def fork_request(
    skill_key: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Create a checklist page + backlog item for the given skill.

    1. Runs scout to find the candidate by skill_key
    2. Creates a checklist page under NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID
    3. Creates a backlog item in NOTION_DB_SKILLS_BACKLOG_ID
    4. Returns URLs for both
    """
    try:
        report = run_skills_scout("config/skills_sources.yaml")

        candidate = _find_candidate(report.candidates, skill_key)
        if not candidate:
            return {"ok": False, "error": f"skill_key '{skill_key}' not found in scout report"}

        backlog_db_id = settings.NOTION_DB_SKILLS_BACKLOG_ID
        checklists_root_id = settings.NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID

        if not backlog_db_id:
            return {"ok": False, "error": "NOTION_DB_SKILLS_BACKLOG_ID not configured"}
        if not checklists_root_id:
            return {"ok": False, "error": "NOTION_PAGE_SKILLS_CHECKLISTS_ROOT_ID not configured"}

        client = NotionClient()
        api = NotionAPI(client=client)

        pain_point = _infer_pain_point(candidate)
        notes = _infer_notes(candidate, pain_point)

        # 1. Create checklist page
        checklist_result = create_skill_checklist_page(
            notion_api=api,
            root_page_id=checklists_root_id,
            skill_key=candidate.skill_key,
            title=candidate.title,
            source_url=candidate.source_url,
            trust_tier=candidate.trust_tier,
            fit_score=candidate.fit_score,
            risk_score=candidate.risk_score,
            recommended_mode=candidate.recommended_mode,
            pain_point=pain_point,
            notes=notes,
        )

        # 2. Create backlog item
        backlog_result = create_skills_backlog_item(
            notion_api=api,
            database_id=backlog_db_id,
            candidate=candidate,
            checklist_page_url=checklist_result["url"],
            pain_point=pain_point,
            notes=notes,
        )

        return {
            "ok": True,
            "skill_key": candidate.skill_key,
            "title": candidate.title,
            "pain_point": pain_point,
            "checklist": checklist_result,
            "backlog": backlog_result,
        }
    except Exception as exc:
        log.error("fork_request_error", extra={"error": str(exc), "skill_key": skill_key})
        return {"ok": False, "error": str(exc)}


@router.get("/admin/skills/ui", response_class=HTMLResponse)
def skills_ui(
    _: None = Depends(require_admin_ops_token),
) -> str:
    """Tiny HTML page showing recommended skills with fork buttons."""
    try:
        report = run_skills_scout("config/skills_sources.yaml")
    except Exception as exc:
        return f"<html><body><h1>Error</h1><p>{exc}</p></body></html>"

    rows_html = ""
    for c in report.candidates:
        if c.recommended_mode == "do_not_install":
            continue
        pain = _infer_pain_point(c)
        mode_label = (
            "safe + confirm" if c.recommended_mode == "safe_then_confirm"
            else "confirm only"
        )
        pain_badge = f'<span class="badge memory">{pain}</span>' if pain else ""
        rows_html += f"""<tr>
  <td>{_esc(c.title)}</td>
  <td><code>{_esc(c.skill_key)}</code></td>
  <td>{c.trust_tier}</td>
  <td>{c.fit_score:.1f}</td>
  <td>{c.risk_score:.1f}</td>
  <td>{mode_label}</td>
  <td>{pain_badge}</td>
  <td><button onclick="forkSkill('{_esc(c.skill_key)}', this)">Fork this skill</button></td>
</tr>
"""

    # Memory candidates section
    memory_rows = ""
    for c in report.candidates:
        if c.recommended_mode == "do_not_install":
            continue
        if _infer_pain_point(c) == "Persistent Memory":
            memory_rows += f"<li><strong>{_esc(c.title)}</strong> ({_esc(c.skill_key)}) — Fit: {c.fit_score:.1f}, Risk: {c.risk_score:.1f}</li>\n"

    memory_section = ""
    if memory_rows:
        memory_section = f"""
<h2>Memory Candidates</h2>
<p>These skills address persistent memory / context management:</p>
<ul>{memory_rows}</ul>
<hr>
"""

    return _SKILLS_UI_HTML.format(
        rows=rows_html,
        memory_section=memory_section,
        count=len([c for c in report.candidates if c.recommended_mode != "do_not_install"]),
    )


# ─────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────


def _find_candidate(candidates: list[SkillCandidate], skill_key: str) -> SkillCandidate | None:
    for c in candidates:
        if c.skill_key == skill_key:
            return c
    return None


def _get_command_center_page_id() -> str | None:
    """Look up command_center page ID from notion_bindings table."""
    try:
        row = _conn.execute(
            "SELECT notion_object_id FROM notion_bindings "
            "WHERE binding_type='command_center' LIMIT 1"
        ).fetchone()
        return row["notion_object_id"] if row else None
    except Exception:
        return None


def _esc(text: str) -> str:
    """Basic HTML escaping."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


_SKILLS_UI_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skills Scout — Fork Manager</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #fafafa; color: #1a1a1a; }}
  h1 {{ font-size: 1.5rem; }}
  h2 {{ font-size: 1.2rem; margin-top: 2rem; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 1rem; background: #fff; }}
  th, td {{ border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9rem; }}
  th {{ background: #f5f5f5; font-weight: 600; }}
  tr:hover {{ background: #f9f9ff; }}
  code {{ background: #eee; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }}
  button {{ background: #2563eb; color: #fff; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }}
  button:hover {{ background: #1d4ed8; }}
  button:disabled {{ background: #94a3b8; cursor: not-allowed; }}
  .badge {{ display: inline-block; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }}
  .badge.memory {{ background: #dbeafe; color: #1e40af; }}
  .result {{ margin-top: 0.3rem; font-size: 0.8rem; }}
  .result a {{ color: #2563eb; }}
  .count {{ color: #666; font-size: 0.9rem; }}
</style>
</head>
<body>
<h1>Skills Scout — Fork Manager</h1>
<p class="count">{count} recommended skills available</p>

<div style="margin: 1rem 0; padding: 1rem; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px;">
  <strong>Database Bootstrap</strong>
  <p style="font-size: 0.85rem; color: #475569; margin: 0.3rem 0;">Create any missing OpenClaw databases under your configured parent page.</p>
  <button onclick="bootstrapDbs(this, true)" style="margin-right: 0.5rem;">Simulate (safe mode)</button>
  <button onclick="bootstrapDbs(this, false)" style="background: #dc2626;">Create missing DBs (apply)</button>
  <span id="bootstrap-result" style="font-size: 0.8rem; margin-left: 0.5rem;"></span>
</div>

{memory_section}

<table>
<thead>
<tr><th>Title</th><th>Key</th><th>Trust</th><th>Fit</th><th>Risk</th><th>Mode</th><th>Tags</th><th>Action</th></tr>
</thead>
<tbody>
{rows}
</tbody>
</table>

<script>
async function forkSkill(skillKey, btn) {{
  btn.disabled = true;
  btn.textContent = "Forking...";
  try {{
    const resp = await fetch("/admin/skills/fork_request?skill_key=" + encodeURIComponent(skillKey), {{
      method: "POST",
      headers: {{ "Authorization": "Bearer " + getToken() }},
    }});
    const data = await resp.json();
    if (data.ok) {{
      btn.textContent = "Forked";
      const div = document.createElement("div");
      div.className = "result";
      div.innerHTML = '<a href="' + data.checklist.url + '" target="_blank">Checklist</a> | <a href="' + data.backlog.url + '" target="_blank">Backlog</a>';
      btn.parentElement.appendChild(div);
    }} else {{
      btn.textContent = "Error";
      btn.title = data.error || "Unknown error";
    }}
  }} catch (e) {{
    btn.textContent = "Error";
    btn.title = e.message;
  }}
}}
async function bootstrapDbs(btn, safeMode) {{
  btn.disabled = true;
  btn.textContent = safeMode ? "Simulating..." : "Creating...";
  const result = document.getElementById("bootstrap-result");
  try {{
    const resp = await fetch("/admin/notion/db/bootstrap_skills_backlog", {{
      method: "POST",
      headers: {{ "Authorization": "Bearer " + getToken(), "Content-Type": "application/json" }},
      body: JSON.stringify({{ safe_mode: safeMode }}),
    }});
    const data = await resp.json();
    if (data.ok) {{
      const r = data.result;
      if (r.created) {{
        result.innerHTML = '<span style="color:#16a34a">DB created: ' + (r.db_id || "—") + '</span>';
      }} else if (r.blocked_reason) {{
        result.innerHTML = '<span style="color:#d97706">Simulated: DB missing (use apply to create)</span>';
      }} else {{
        result.innerHTML = '<span style="color:#16a34a">DB exists' + (r.compliance && r.compliance.compliant ? ' + compliant' : '') + '</span>';
      }}
    }} else {{
      result.innerHTML = '<span style="color:#dc2626">Error: ' + (data.error || "unknown") + '</span>';
    }}
  }} catch (e) {{
    result.innerHTML = '<span style="color:#dc2626">Error: ' + e.message + '</span>';
  }}
  btn.disabled = false;
  btn.textContent = safeMode ? "Simulate (safe mode)" : "Create missing DBs (apply)";
}}
function getToken() {{
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}}
</script>
</body>
</html>"""
