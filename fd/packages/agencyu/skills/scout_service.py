"""Skills Scout — single orchestration layer.

Load config -> fetch candidates -> score -> build report -> write files.

Usage:
    report = run_skills_scout("config/skills_sources.yaml")
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.skills.models import ScoutReport
from packages.agencyu.skills.scout_ranker import SkillsScoutRanker
from packages.agencyu.skills.scout_report import build_report, write_report_files
from packages.agencyu.skills.scout_sources import SkillsScoutSources, SourceConfig
from packages.common.logging import get_logger

log = get_logger("agencyu.skills.scout_service")


def run_skills_scout(
    config_path: str = "config/skills_sources.yaml",
) -> ScoutReport:
    """Run the full skills scout pipeline.

    1. Load config
    2. Build source adapters
    3. Fetch candidates from all enabled sources
    4. Score candidates (fit + risk)
    5. Build report
    6. Write output files (JSON + Markdown)

    Returns the ScoutReport.
    """
    cfg = _load_config(config_path)
    root = cfg["skills_scout"]

    if not root.get("enabled", True):
        raise RuntimeError("skills_scout is disabled in config")

    allow_domains = root["allow_domains"]
    max_bytes = int(root.get("max_skill_md_bytes", 250_000))

    # Build source configs
    sources: list[SourceConfig] = []
    for s in root["sources"]:
        sources.append(SourceConfig(
            source_key=s["source_key"],
            type=s["type"],
            trust_tier=s.get("trust_tier", "unknown"),
            notes=s.get("notes", ""),
            repo=s.get("repo"),
            branch=s.get("branch", "main"),
            base_path=s.get("base_path"),
            url=s.get("url"),
        ))

    # Fetch
    fetcher = SkillsScoutSources(
        allow_domains=allow_domains,
        max_bytes=max_bytes,
    )
    candidates = fetcher.fetch_candidates(sources)

    log.info("scout_fetch_complete", extra={
        "candidate_count": len(candidates),
        "source_count": len(sources),
    })

    # Cap candidates
    max_candidates = int(root.get("max_candidates", 250))
    if len(candidates) > max_candidates:
        candidates = candidates[:max_candidates]

    # Score
    ranker = SkillsScoutRanker(
        fit_profile=root["fit_profile"],
        risk_rules=root["risk_rules"],
    )
    candidates = ranker.score(candidates)

    # Build report
    report = build_report(candidates, max_top=10)

    # Write output files
    out = root.get("output", {})
    json_path = out.get("json_path", "var/skills_scout/latest.json")
    md_path = out.get("md_path", "var/skills_scout/latest.md")
    write_report_files(report, json_path=json_path, md_path=md_path)

    log.info("scout_run_complete", extra={
        "candidates": len(report.candidates),
        "top_fd": len(report.top_full_digital),
        "do_not_install": len(report.do_not_install),
    })

    return report


def _load_config(path: str) -> dict[str, Any]:
    """Load and validate skills scout config YAML."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Skills config not found: {path}")

    raw = yaml.safe_load(p.read_text())
    if not isinstance(raw, dict) or "skills_scout" not in raw:
        raise ValueError("skills_sources.yaml must have 'skills_scout' top-level key")

    return raw
