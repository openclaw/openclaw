#!/usr/bin/env python3
"""Generate a market briefing markdown file for a specific client.

Key responsibilities:
1. Load client configuration from ~/openclaw-work/clients/<client>/config.json
2. Fetch items from configured web sources (html, rss, api)
3. Render a markdown briefing stub, pre-populating headline bullets per source
4. Write output to ~/openclaw-work/out/<client>/briefing_YYYY-MM-DD.md

Example:
    python scripts/generate_briefing.py --client acme-industries --date 2026-03-04
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
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
    raise SystemExit("The 'requests' package is required. Install it with `pip install requests`." ) from exc

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = ROOT / "assets"
TEMPLATE_PATH = ASSETS_DIR / "briefing-template.md"
WORK_DIR = Path(os.path.expanduser("~/openclaw-work"))
CLIENTS_DIR = WORK_DIR / "clients"
OUT_DIR = WORK_DIR / "out"
DEFAULT_LIMIT = 5

@dataclass
class SourceItem:
    title: str
    url: str
    summary: str = ""
    published: Optional[str] = None
    source_name: Optional[str] = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a market briefing file")
    parser.add_argument("--client", required=True, help="Client slug (folder name under ~/openclaw-work/clients)")
    parser.add_argument("--date", help="Override briefing date (YYYY-MM-DD)")
    parser.add_argument("--max-per-source", type=int, default=DEFAULT_LIMIT, help="Cap of items per source")
    parser.add_argument("--init-dirs", action="store_true", help="Create client/out directories if missing and exit")
    parser.add_argument("--dry-run", action="store_true", help="Gather data but do not write output")
    return parser.parse_args()


def ensure_dirs(client: str) -> None:
    (CLIENTS_DIR / client).mkdir(parents=True, exist_ok=True)
    (OUT_DIR / client).mkdir(parents=True, exist_ok=True)


def load_config(client: str) -> Dict[str, Any]:
    config_path = CLIENTS_DIR / client / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(f"Missing config file: {config_path}")
    with config_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("client") and data["client"] != client:
        raise ValueError(f"Config client '{data['client']}' does not match folder '{client}'")
    data.setdefault("client", client)
    return data


def resolve_date(cfg: Dict[str, Any], override: Optional[str]) -> dt.date:
    if override:
        return dt.date.fromisoformat(override)
    tz_name = cfg.get("timezone")
    if tz_name and ZoneInfo:
        now = dt.datetime.now(ZoneInfo(tz_name))
    else:
        now = dt.datetime.utcnow()
    return now.date()


def fetch_html(source: Dict[str, Any], limit: int) -> List[SourceItem]:
    if BeautifulSoup is None:
        raise RuntimeError("Parsing HTML sources requires beautifulsoup4. Install it with `pip install beautifulsoup4`." )
    resp = requests.get(source["url"], timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    selector = source.get("selector") or "article a"
    nodes = soup.select(selector)
    items: List[SourceItem] = []
    for node in nodes[:limit]:
        title = node.get_text(strip=True)
        href = node.get("href")
        if not title or not href:
            continue
        href = href if href.startswith("http") else requests.compat.urljoin(source["url"], href)
        items.append(SourceItem(title=title, url=href, source_name=source.get("name")))
    return items


def fetch_rss(source: Dict[str, Any], limit: int) -> List[SourceItem]:
    resp = requests.get(source["url"], timeout=20)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    channel_items = root.findall(".//item")
    items: List[SourceItem] = []
    for node in channel_items[:limit]:
        title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        description = (node.findtext("description") or "").strip()
        pub_date = (node.findtext("pubDate") or "").strip()
        if not title:
            continue
        items.append(SourceItem(title=title, url=link, summary=description, published=pub_date, source_name=source.get("name")))
    return items


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


def fetch_api(source: Dict[str, Any], limit: int) -> List[SourceItem]:
    params = source.get("params")
    headers = source.get("headers")
    resp = requests.get(source["url"], params=params, headers=headers, timeout=20)
    resp.raise_for_status()
    payload = resp.json()
    payload = dig_path(payload, source.get("path"))
    if not isinstance(payload, list):
        payload = [payload]
    mapping: Dict[str, str] = source.get("mapping", {})
    items: List[SourceItem] = []
    for row in payload[:limit]:
        if not isinstance(row, dict):
            continue
        title = str(row.get(mapping.get("title", "title")) or row.get("title") or "").strip()
        url = str(row.get(mapping.get("url", "url")) or row.get("url") or "").strip()
        summary = str(row.get(mapping.get("summary", "summary")) or row.get("summary") or "").strip()
        published = str(row.get(mapping.get("published", "published")) or row.get("published") or "").strip()
        if not title:
            continue
        items.append(SourceItem(title=title, url=url, summary=summary, published=published, source_name=source.get("name")))
    return items


def gather_sources(cfg: Dict[str, Any], max_per_source: int) -> List[SourceItem]:
    collected: List[SourceItem] = []
    for source in cfg.get("sources", []):
        stype = source.get("type", "html").lower()
        limit = min(max_per_source, int(source.get("limit", max_per_source)))
        try:
            if stype == "rss":
                batch = fetch_rss(source, limit)
            elif stype == "api":
                batch = fetch_api(source, limit)
            else:
                batch = fetch_html(source, limit)
        except Exception as exc:  # pragma: no cover
            print(f"[warn] Failed to fetch {source.get('name')}: {exc}", file=sys.stderr)
            continue
        collected.extend(batch)
    return collected


def format_source_bullets(items: Iterable[SourceItem]) -> str:
    lines = ["## Auto-Collected Headlines\n"]
    for item in items:
        title = item.title or "Untitled"
        source = f" ({item.source_name})" if item.source_name else ""
        published = f" — {item.published}" if item.published else ""
        summary = f" — {item.summary}" if item.summary else ""
        link = item.url if item.url else ""
        lines.append(f"- **{title}**{source}{published}{summary} [{link}]({link})")
    return "\n".join(lines) if len(lines) > 1 else ""


def render_briefing(cfg: Dict[str, Any], briefing_date: dt.date, items: List[SourceItem]) -> str:
    if not TEMPLATE_PATH.exists():
        raise FileNotFoundError(f"Missing template: {TEMPLATE_PATH}")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    base = template.format(
        client_name=cfg.get("client", "unknown-client"),
        briefing_date=briefing_date.isoformat(),
    )
    focus = cfg.get("focus") or []
    focus_block = "\n".join(f"- {topic}" for topic in focus)
    focus_block = f"\n### Focus Priorities\n{focus_block}\n" if focus_block else ""
    source_block = format_source_bullets(items)
    custom_sections = []
    for section in cfg.get("custom_sections", []):
        title = section.get("title") or "Custom Section"
        template_type = (section.get("template") or "freeform").lower()
        if template_type == "table":
            body = "| Item | Detail |\n|------|--------|\n|      |        |\n"
        elif template_type == "bullet":
            body = "- Item\n- Insight\n"
        else:
            body = "(Add narrative here)\n"
        custom_sections.append(f"## {title}\n{body}")
    custom_block = "\n".join(custom_sections)
    return "\n\n".join(filter(None, [base.strip(), focus_block.strip(), source_block.strip(), custom_block.strip()])) + "\n"


def write_output(client: str, briefing_date: dt.date, content: str) -> Path:
    ensure_dirs(client)
    out_path = OUT_DIR / client / f"briefing_{briefing_date.isoformat()}.md"
    out_path.write_text(content, encoding="utf-8")
    return out_path


def main() -> None:
    args = parse_args()
    ensure_dirs(args.client)
    if args.init_dirs:
        print(f"Initialized directories for {args.client} under {WORK_DIR}")
        return
    cfg = load_config(args.client)
    briefing_date = resolve_date(cfg, args.date)
    items = gather_sources(cfg, args.max_per_source)
    content = render_briefing(cfg, briefing_date, items)
    if args.dry_run:
        print(content)
        return
    out_path = write_output(args.client, briefing_date, content)
    print(f"Briefing written to {out_path}")


if __name__ == "__main__":
    main()
