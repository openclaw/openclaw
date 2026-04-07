#!/usr/bin/env python3
"""Produce exactly two SEO-ready articles about trending AI tools for a client."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

try:
    import requests
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Install the 'requests' package (pip install requests)." ) from exc

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

import xml.etree.ElementTree as ET

SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = SKILL_DIR / "assets"
TEMPLATE_PATH = ASSETS_DIR / "seo-article-template.md"
WORK_ROOT = Path(os.path.expanduser("~/openclaw-work"))
CLIENTS_DIR = WORK_ROOT / "clients"
OUT_ROOT = WORK_ROOT / "out" / "articles"
DEFAULT_LIMIT = 8
REQUIRED_ARTICLE_COUNT = 2

@dataclass
class ToolRecord:
    title: str
    url: str
    summary: str
    source: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create two SEO articles about trending AI tools")
    parser.add_argument("--client", required=True, help="Client slug under ~/openclaw-work/clients")
    parser.add_argument("--date", help="Override date (YYYY-MM-DD)")
    parser.add_argument("--max-per-source", type=int, default=DEFAULT_LIMIT, help="Maximum tool cards per source")
    parser.add_argument("--dry-run", action="store_true", help="Print articles to stdout instead of writing files")
    parser.add_argument("--init-dirs", action="store_true", help="Ensure client + output directories exist, then exit")
    return parser.parse_args()


def ensure_dirs(client: str) -> None:
    (CLIENTS_DIR / client).mkdir(parents=True, exist_ok=True)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)


def load_config(client: str) -> Dict[str, Any]:
    cfg_path = CLIENTS_DIR / client / "config.json"
    if not cfg_path.exists():
        raise FileNotFoundError(f"Missing config: {cfg_path}")
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    data.setdefault("client", client)
    return data


def resolve_date(cfg: Dict[str, Any], override: Optional[str]) -> dt.date:
    if override:
        return dt.date.fromisoformat(override)
    tz = cfg.get("timezone")
    if tz and ZoneInfo:
        now = dt.datetime.now(ZoneInfo(tz))
    else:
        now = dt.datetime.utcnow()
    return now.date()


def html_list(source: Dict[str, Any], limit: int) -> List[ToolRecord]:
    if BeautifulSoup is None:
        raise RuntimeError("Install beautifulsoup4 to parse HTML list views.")
    resp = requests.get(source["url"], timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    item_selector = source.get("item_selector")
    if not item_selector:
        raise ValueError(f"html-list source {source.get('name')} missing item_selector")
    cards = soup.select(item_selector)
    records: List[ToolRecord] = []
    for card in cards[:limit]:
        title_node = card.select_one(source.get("title_selector") or "h3")
        desc_node = card.select_one(source.get("description_selector") or "p")
        link_node = card.select_one(source.get("link_selector") or "a")
        title = title_node.get_text(strip=True) if title_node else "Untitled Tool"
        summary = desc_node.get_text(strip=True) if desc_node else ""
        href = link_node.get("href") if link_node else ""
        if href and not href.startswith("http"):
            href = requests.compat.urljoin(source["url"], href)
        records.append(ToolRecord(title=title, url=href, summary=summary, source=source.get("name", "unknown")))
    return records


def rss_feed(source: Dict[str, Any], limit: int) -> List[ToolRecord]:
    resp = requests.get(source["url"], timeout=20)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items = root.findall('.//item')
    records: List[ToolRecord] = []
    for node in items[:limit]:
        title = (node.findtext('title') or '').strip()
        summary = (node.findtext('description') or '').strip()
        link = (node.findtext('link') or '').strip()
        records.append(ToolRecord(title=title or "Untitled Tool", url=link, summary=summary, source=source.get("name", "rss")))
    return records


def api_list(source: Dict[str, Any], limit: int) -> List[ToolRecord]:
    resp = requests.get(source["url"], headers=source.get("headers"), params=source.get("params"), timeout=20)
    resp.raise_for_status()
    data = resp.json()
    payload = dig_path(data, source.get("path"))
    if not isinstance(payload, list):
        payload = [payload]
    mapping = source.get("mapping", {})
    title_key = mapping.get("title", "title")
    summary_key = mapping.get("summary", "description")
    url_key = mapping.get("url", "url")
    records: List[ToolRecord] = []
    for row in payload[:limit]:
        if not isinstance(row, dict):
            continue
        title = str(row.get(title_key) or "Untitled Tool")
        summary = str(row.get(summary_key) or "")
        link = str(row.get(url_key) or "")
        records.append(ToolRecord(title=title.strip(), url=link.strip(), summary=summary.strip(), source=source.get("name", "api")))
    return records


def dig_path(payload: Any, path: Optional[str]) -> Any:
    if not path:
        return payload
    cursor = payload
    for key in path.split('.'):
        if isinstance(cursor, dict):
            cursor = cursor.get(key)
        elif isinstance(cursor, list):
            cursor = cursor[int(key)]
        else:
            return None
    return cursor


def collect_tools(cfg: Dict[str, Any], max_per_source: int) -> List[ToolRecord]:
    pool: List[ToolRecord] = []
    for source in cfg.get("sources", []):
        stype = source.get("type", "html-list").lower()
        limit = min(max_per_source, int(source.get("limit", max_per_source)))
        try:
            if stype == "rss":
                batch = rss_feed(source, limit)
            elif stype == "api":
                batch = api_list(source, limit)
            else:
                batch = html_list(source, limit)
        except Exception as exc:  # pragma: no cover
            print(f"[warn] {source.get('name')} failed: {exc}", file=sys.stderr)
            continue
        pool.extend(batch)
    return dedupe_tools(pool)


def dedupe_tools(records: Iterable[ToolRecord]) -> List[ToolRecord]:
    seen = set()
    unique: List[ToolRecord] = []
    for rec in records:
        key = re.sub(r"\W+", "", rec.title.lower())
        if key in seen:
            continue
        seen.add(key)
        unique.append(rec)
    return unique


def ensure_article_capacity(articles: List[Dict[str, Any]]) -> None:
    if len(articles) < REQUIRED_ARTICLE_COUNT:
        raise SystemExit(f"Config must include at least {REQUIRED_ARTICLE_COUNT} article entries.")


def build_outline(spec: Dict[str, Any], persona: str) -> str:
    outline = spec.get("outline") or [
        f"1. Pressure check for {persona} teams",
        "2. Where AI tools remove toil right now",
        "3. Tool-by-tool stack impact",
        "4. Implementation roadmap",
        "5. Metrics, FAQs, and next steps",
    ]
    return "\n".join(outline)


def build_sections(spec: Dict[str, Any], persona: str, angle: str, tools: List[ToolRecord]) -> str:
    default_sections = [
        (f"Why {persona} teams need an AI upgrade", f"Tie {angle} KPIs to automation benefits and cite pains like headcount caps or shrinking launch cycles."),
        ("How to evaluate the current wave of tools", "Lay out criteria: integration effort, data governance, pricing transparency, and speed-to-value."),
        ("Activation plan", "Outline a 30-60-90 roadmap with pilot, rollout, and optimization."),
    ]
    section_defs = spec.get("sections") or default_sections
    parts: List[str] = []
    for title, body in section_defs:
        augmented = body
        if tools:
            augmented += f" Mention highlights from {tools[0].title} or {tools[1].title if len(tools) > 1 else tools[0].title}."
        parts.append(f"## {title}\n{augmented}\n")
    return "\n".join(parts)


def build_faq(spec: Dict[str, Any], primary_keyword: str, persona: str) -> str:
    faq = spec.get("faq") or [
        (f"What does {primary_keyword} actually cover?", f"It spans discovery, evaluation, and rollout steps tailored to {persona} teams."),
        ("How fast can we pilot these tools?", "Map a 2-week experiment with a single workflow, then expand only if KPIs move."),
        ("How do we keep the stack lean?", "Audit overlapping subscriptions quarterly and sunset anything without attributable impact."),
    ]
    lines = []
    for idx, (question, answer) in enumerate(faq, start=1):
        lines.append(f"{idx}. **{question}**\n   {answer}")
    return "\n".join(lines)


def build_article(spec: Dict[str, Any], cfg: Dict[str, Any], date: dt.date, tools: List[ToolRecord]) -> str:
    if not TEMPLATE_PATH.exists():
        raise FileNotFoundError(f"Missing template: {TEMPLATE_PATH}")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    persona = cfg.get("persona", "GTM leaders")
    keyword_list = spec.get("keywords") or []
    keywords = ", ".join(keyword_list)
    primary_keyword = spec.get("primary_keyword", keyword_list[0] if keyword_list else "ai tools")
    meta_description = spec.get("meta_description") or (
        f"Discover trending AI tools {persona} teams can use to level up {primary_keyword}."
    )
    outline = build_outline(spec, persona)
    sections = build_sections(spec, persona, spec.get("angle", "Revenue"), tools)
    faq_block = build_faq(spec, primary_keyword, persona)
    tool_rows = "\n".join(
        f"| **{tool.title}** | {tool.summary or 'Practical use-case TBD'} | [{tool.url}]({tool.url}) |"
        for tool in tools[: max(3, min(len(tools), 6))]
    ) or "| _Add tool_ | _Add detail_ | _Add link_ |"
    source_notes = "\n".join(f"- {tool.source}: [{tool.title}]({tool.url})" for tool in tools) or "- Add citations"
    cta = spec.get("cta") or cfg.get("cta") or "Book a workflow teardown to design your AI stack."
    return template.format(
        title=spec.get("title", "AI Tools Roundup"),
        date=date.isoformat(),
        slug=spec.get("slug", f"ai-tools-{date.isoformat()}"),
        keywords=keywords,
        meta_description=meta_description,
        client=cfg.get("client"),
        hook=spec.get("hook", "Your buyers expect AI-grade experiences—here are the tools to deliver."),
        outline=outline,
        sections=sections,
        tool_rows=tool_rows,
        faq_block=faq_block,
        cta=cta,
        source_notes=source_notes,
    )


def write_articles(date: dt.date, articles: List[Dict[str, Any]], cfg: Dict[str, Any], tools: List[ToolRecord], dry_run: bool) -> List[Path]:
    ensure_article_capacity(articles)
    out_dir = OUT_ROOT / date.isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []
    targets = articles[:REQUIRED_ARTICLE_COUNT]
    for spec in targets:
        content = build_article(spec, cfg, date, tools)
        slug = spec.get("slug") or f"article-{len(written)+1}"
        target = out_dir / f"{slug}.md"
        if dry_run:
            print("\n" + "#" * 80)
            print(target)
            print(content)
        else:
            target.write_text(content, encoding="utf-8")
            written.append(target)
    return written


def main() -> None:
    args = parse_args()
    ensure_dirs(args.client)
    if args.init_dirs:
        print(f"Initialized scaffolding under {WORK_ROOT}")
        return
    cfg = load_config(args.client)
    date = resolve_date(cfg, args.date)
    tools = collect_tools(cfg, args.max_per_source)
    articles_cfg = cfg.get("articles", [])
    written = write_articles(date, articles_cfg, cfg, tools, args.dry_run)
    if written:
        for path in written:
            print(f"Wrote {path}")
    else:
        print("Dry-run completed; no files written.")


if __name__ == "__main__":
    main()
