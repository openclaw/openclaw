"""Skills Scout — source adapters for discovering forkable skills.

Scans allowlisted public skill registries/repos:
- GitHub repos: list directories under base_path, fetch SKILL.md, parse frontmatter
- Web directories: best-effort candidate discovery via simple HTML heuristics
- Manual entries: inline skill definitions from config

Safety:
- Every HTTP request is checked against the allow_domains list
- No arbitrary link crawling
- All discovery is read-only; no auto-install
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from packages.agencyu.skills.models import SkillCandidate
from packages.common.logging import get_logger

log = get_logger("agencyu.skills.scout_sources")


@dataclass
class SourceConfig:
    """Configuration for a single skill source."""

    source_key: str
    type: str  # github_repo | web_directory
    trust_tier: str
    notes: str
    repo: str | None = None
    branch: str = "main"
    base_path: str | None = None
    url: str | None = None


class SkillsScoutSources:
    """Fetches skill candidates from allowlisted external sources."""

    def __init__(
        self,
        *,
        allow_domains: list[str],
        max_bytes: int = 250_000,
        timeout_s: int = 15,
    ) -> None:
        self.allow_domains = {d.lower() for d in allow_domains}
        self.max_bytes = max_bytes
        self.timeout_s = timeout_s

    def fetch_candidates(self, sources: list[SourceConfig]) -> list[SkillCandidate]:
        """Scan all sources and return discovered candidates."""
        out: list[SkillCandidate] = []
        for s in sources:
            try:
                if s.type == "github_repo":
                    out.extend(self._scan_github_repo(s))
                elif s.type == "web_directory":
                    out.extend(self._scan_web_directory(s))
            except Exception:
                log.warning("source_scan_error", extra={
                    "source_key": s.source_key,
                }, exc_info=True)
        return out

    # ─────────────────────────────────────────
    # GitHub scanning
    # ─────────────────────────────────────────

    def _scan_github_repo(self, s: SourceConfig) -> list[SkillCandidate]:
        """Scan a GitHub repo for skill folders with SKILL.md.

        Strategy (read-only):
        1. Use GitHub API to list directories under base_path
        2. For each folder, fetch SKILL.md via raw.githubusercontent.com
        3. Parse YAML frontmatter for name/description
        """
        if not s.repo or not s.base_path:
            return []

        api_url = (
            f"https://api.github.com/repos/{s.repo}/contents/{s.base_path}"
            f"?ref={s.branch}"
        )
        self._assert_allowed(api_url)

        body = self._fetch_text(api_url)
        if not body:
            return []

        import json
        try:
            items = json.loads(body)
        except (json.JSONDecodeError, TypeError):
            return []

        if not isinstance(items, list):
            return []

        candidates: list[SkillCandidate] = []
        for it in items:
            if it.get("type") != "dir":
                continue

            folder = it.get("name", "")
            skill_md_url = (
                f"https://raw.githubusercontent.com/{s.repo}/{s.branch}"
                f"/{s.base_path}/{folder}/SKILL.md"
            )
            self._assert_allowed(skill_md_url)

            md = self._fetch_text(skill_md_url)
            if not md:
                continue

            meta = _parse_skill_md(md)
            skill_key = str(meta.get("name") or f"{s.source_key}:{folder}")
            title = meta.get("title") or folder
            desc = str(meta.get("description") or "No description found.")

            candidates.append(SkillCandidate(
                skill_key=skill_key,
                title=title,
                description=desc,
                source_key=s.source_key,
                source_url=skill_md_url,
                trust_tier=s.trust_tier,
                signals={"folder": folder, "repo": s.repo},
                raw_snippet=md[:1200],
            ))

        return candidates

    # ─────────────────────────────────────────
    # Web directory scanning
    # ─────────────────────────────────────────

    def _scan_web_directory(self, s: SourceConfig) -> list[SkillCandidate]:
        """Best-effort: parse landing page and extract skill-like names.

        We do NOT claim to capture everything; we produce candidates
        for manual review.
        """
        if not s.url:
            return []

        self._assert_allowed(s.url)
        html = self._fetch_text(s.url)
        if not html:
            return []

        candidates: list[SkillCandidate] = []
        skill_names = _extract_probable_skill_names(html)[:200]
        for name in skill_names:
            candidates.append(SkillCandidate(
                skill_key=name,
                title=name,
                description="Discovered from directory page; open source_url for details.",
                source_key=s.source_key,
                source_url=s.url,
                trust_tier=s.trust_tier,
                signals={"discovery": "directory_heuristic"},
            ))
        return candidates

    # ─────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────

    def _fetch_text(self, url: str) -> str | None:
        """Fetch URL text content with size cap."""
        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                resp = client.get(url)
                if resp.status_code != 200:
                    return None
                text = resp.text
                if len(text.encode("utf-8")) > self.max_bytes:
                    return text.encode("utf-8")[:self.max_bytes].decode(
                        "utf-8", errors="ignore"
                    )
                return text
        except Exception:
            return None

    def _assert_allowed(self, url: str) -> None:
        """Enforce allow_domains for every request."""
        host = urlparse(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        if host not in self.allow_domains:
            raise ValueError(f"Blocked by allowlist: {host}")


# ─────────────────────────────────────────
# Parsing helpers
# ─────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*(.*?)\s*---\s*(.*)$", re.DOTALL)


def _parse_skill_md(md: str) -> dict[str, Any]:
    """Parse YAML frontmatter (name/description) + infer title from first H1."""
    out: dict[str, Any] = {}
    m = _FRONTMATTER_RE.match(md.strip())
    body = md
    if m:
        fm = m.group(1)
        body = m.group(2)
        for line in fm.splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")

    # Title: first markdown H1
    for line in body.splitlines():
        if line.startswith("# "):
            out["title"] = line[2:].strip()
            break

    return out


def _extract_probable_skill_names(html: str) -> list[str]:
    """Extract hyphenated skill-like names from HTML content."""
    names = set(re.findall(r"\b[a-z0-9][a-z0-9\-]{2,64}\b", html))
    # Prune common junk tokens
    junk = {
        "skills", "collections", "github", "claude", "skill",
        "install", "browse", "button", "content", "display",
        "padding", "margin", "border", "height", "width",
    }
    names = {n for n in names if n not in junk}
    # Prefer hyphenated (skill-like)
    hyphenated = [n for n in names if "-" in n]
    return sorted(hyphenated)
