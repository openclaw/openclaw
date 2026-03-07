"""cc.skills_recommendations widget — renders Skills Scout results on Command Center.

Shows:
- Top skill picks (safe to fork)
- Do-not-install flagged list
- Next actions

Uses standard [[OPENCLAW:CC_SKILLS_RECOMMENDATIONS:START/END]] marker convention.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.skills.models import ScoutReport
from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    heading_3,
    paragraph,
)

MARKER_KEY = "CC_SKILLS_RECOMMENDATIONS"


def render_skills_recommendations(
    report: ScoutReport,
    *,
    limit: int = 7,
) -> list[dict[str, Any]]:
    """Render Skills Scout results as Notion blocks for the Command Center.

    5-year-old standard: simple, actionable, no jargon.
    """
    blocks: list[dict[str, Any]] = []

    blocks.append(heading_2("\U0001f50c Skills to Fork (Recommended)"))
    blocks.append(paragraph(
        "These are candidates only. No installs happen automatically. "
        "Review SKILL.md and scripts before forking."
    ))

    blocks.append(divider())
    blocks.append(heading_3("Top picks"))

    shown = 0
    for c in report.candidates:
        if shown >= limit:
            break
        if c.recommended_mode == "do_not_install":
            continue

        mode_label = (
            "safe + confirm" if c.recommended_mode == "safe_then_confirm"
            else "confirm only"
        )
        blocks.append(bulleted_list_item(
            f"{c.title} ({c.skill_key})"
        ))
        blocks.append(paragraph(
            f"  Fit: {c.fit_score:.1f} | Risk: {c.risk_score:.1f} | "
            f"Mode: {mode_label}",
            color="gray",
        ))
        blocks.append(paragraph(
            f"  Source: {c.source_key} ({c.trust_tier})",
            color="gray",
        ))
        shown += 1

    if shown == 0:
        blocks.append(callout(
            "No safe recommendations found in the last scan.",
            icon="info",
            color="gray_background",
        ))

    blocks.append(divider())
    blocks.append(heading_3("Do-not-install (flagged)"))

    if report.do_not_install:
        for k in report.do_not_install[:10]:
            blocks.append(bulleted_list_item(k))
    else:
        blocks.append(paragraph("None flagged.", color="gray"))

    # Memory candidates section
    memory_candidates = _find_memory_candidates(report)
    if memory_candidates:
        blocks.append(divider())
        blocks.append(heading_3("Memory candidates"))
        blocks.append(paragraph(
            "These skills address persistent memory / context management:",
            color="gray",
        ))
        for c in memory_candidates[:5]:
            blocks.append(bulleted_list_item(
                f"{c.title} ({c.skill_key}) — Fit: {c.fit_score:.1f}, Risk: {c.risk_score:.1f}"
            ))

    blocks.append(divider())
    blocks.append(heading_3("Next actions"))
    blocks.append(bulleted_list_item(
        "Run: POST /admin/skills/scan"
    ))
    blocks.append(bulleted_list_item(
        "Then: choose 1 skill to fork into /openclaw/skills_forked/ "
        "with safe-mode defaults."
    ))
    blocks.append(bulleted_list_item(
        "Or: open /admin/skills/ui to fork directly from the browser."
    ))

    return blocks


_MEMORY_KEYWORDS = [
    "memory", "persistent", "context", "remember", "recall",
    "long-term", "longterm", "session", "state", "knowledge base",
    "knowledge graph", "vector", "embedding", "rag",
]


def _find_memory_candidates(report: ScoutReport) -> list:
    """Return candidates whose title/description/tags match memory keywords."""
    from packages.agencyu.skills.models import SkillCandidate

    results: list[SkillCandidate] = []
    for c in report.candidates:
        if c.recommended_mode == "do_not_install":
            continue
        haystack = f"{c.title} {c.description} {c.skill_key} {' '.join(c.tags)}".lower()
        for kw in _MEMORY_KEYWORDS:
            if kw in haystack:
                results.append(c)
                break
    return results
