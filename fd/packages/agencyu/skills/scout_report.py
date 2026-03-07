"""Skills Scout — advisory report generation.

Produces:
- latest.json: machine-readable candidate list
- latest.md: human-readable advisory report
- Top lists for Full Digital and CUTMV
- Do-not-install flagged list

Reports are advisory only — no auto-install, no auto-approve.
"""
from __future__ import annotations

import json
import os
from typing import Any

from packages.agencyu.skills.models import ScoutReport, SkillCandidate, _candidate_to_dict
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.skills.scout_report")


def build_report(
    candidates: list[SkillCandidate],
    *,
    max_top: int = 10,
) -> ScoutReport:
    """Build a ScoutReport from scored candidates."""
    now = utc_now_iso()

    # Sort by fit score descending, then lower risk
    ranked = sorted(
        candidates,
        key=lambda c: (c.fit_score, -c.risk_score),
        reverse=True,
    )

    top_fd = [c.skill_key for c in ranked[:max_top]]
    top_cut = [c.skill_key for c in ranked[:max_top]]

    do_not = [c.skill_key for c in ranked if c.recommended_mode == "do_not_install"]

    notes = [
        "No skills are installed automatically.",
        "All candidates require manual review of SKILL.md + scripts folder before forking.",
    ]

    return ScoutReport(
        generated_at=now,
        candidates=ranked,
        top_full_digital=top_fd,
        top_cutmv=top_cut,
        do_not_install=do_not,
        notes=notes,
    )


def write_report_files(
    report: ScoutReport,
    *,
    json_path: str,
    md_path: str,
) -> None:
    """Write report to JSON and Markdown files."""
    _ensure_parent(json_path)
    _ensure_parent(md_path)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report.to_dict(), f, indent=2)

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_markdown(report))

    log.info("report_files_written", extra={
        "json_path": json_path,
        "md_path": md_path,
        "candidates": len(report.candidates),
    })


def render_markdown(report: ScoutReport) -> str:
    """Render a human-readable Markdown advisory report."""
    lines: list[str] = []
    lines.append("# OpenClaw Skills Scout Report")
    lines.append("")
    lines.append(f"- Generated: `{report.generated_at}`")
    lines.append(f"- Total candidates: {len(report.candidates)}")
    lines.append("")

    lines.append("## Top recommendations (Full Digital)")
    for k in report.top_full_digital:
        lines.append(f"- `{k}`")
    lines.append("")

    lines.append("## Top recommendations (CUTMV)")
    for k in report.top_cutmv:
        lines.append(f"- `{k}`")
    lines.append("")

    lines.append("## Do-not-install (high risk)")
    if report.do_not_install:
        for k in report.do_not_install[:50]:
            lines.append(f"- `{k}`")
    else:
        lines.append("- None flagged.")
    lines.append("")

    lines.append("## Notes")
    for n in report.notes:
        lines.append(f"- {n}")
    lines.append("")

    lines.append("## Candidates (ranked)")
    for c in report.candidates[:50]:
        lines.append(f"### {c.title} -- `{c.skill_key}`")
        lines.append(f"- Source: {c.source_key} ({c.trust_tier})")
        lines.append(
            f"- Fit: {c.fit_score:.1f} | Risk: {c.risk_score:.1f} "
            f"| Mode: {c.recommended_mode}"
        )
        lines.append(f"- Description: {c.description}")
        lines.append(f"- URL: {c.source_url}")
        lines.append("")

    lines.append("---")
    lines.append("*This is an advisory report. No skills have been installed.*")
    lines.append("*Review each recommendation and manually approve before forking.*")

    return "\n".join(lines)


def _ensure_parent(path: str) -> None:
    """Create parent directories if needed."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
