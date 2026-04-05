"""
Deep Research Runner v11.6 — fetch Top-20 from each source, save to data/research/v11.6/.

Usage:
    python scripts/deep_research_v11_6.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.parsers.universal import UniversalParser, ResearchItem

# Research queries aligned with OpenClaw focus areas
QUERIES = [
    "multi-agent systems LLM optimization",
    "RAG retrieval augmented generation advanced techniques",
    "local LLM fine-tuning Python Rust",
    "AI agent orchestration framework 2025 2026",
]

OUTPUT_DIR = Path("data/research/v11.6")
TOP_N = 20


def _item_to_md(item: ResearchItem, rank: int) -> str:
    """Format a ResearchItem as Markdown entry."""
    lines = [
        f"### {rank}. {item.title}",
        f"- **URL:** {item.url}",
        f"- **Source:** `{item.source}`",
    ]
    if item.authors:
        lines.append(f"- **Authors:** {', '.join(item.authors[:5])}")
    if item.published:
        lines.append(f"- **Published:** {item.published}")
    if item.score:
        lines.append(f"- **Score/Citations:** {int(item.score)}")
    if item.tags:
        lines.append(f"- **Tags:** {', '.join(item.tags[:8])}")
    if item.summary:
        lines.append(f"- **Summary:** {item.summary[:300]}")

    extra_keys = [k for k in ("pdf_url", "oa_url", "language", "stars", "venue") if item.extra.get(k)]
    for k in extra_keys:
        lines.append(f"- **{k}:** {item.extra[k]}")

    lines.append("")
    return "\n".join(lines)


async def run_research() -> None:
    parser = UniversalParser()
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Fetch all sources for combined query
    combined_query = " ".join(QUERIES[:2])  # Use first two for main sweep

    # Source-specific queries for better results
    source_queries = {
        "habr": "мультиагентные системы LLM оптимизация RAG",
        "github": "topic:multi-agent language:python stars:>50",
        "reddit": "multi-agent systems LLM RAG optimization",
        "semantic_scholar": "multi-agent systems optimization",
        "arxiv": "multi-agent reinforcement learning LLM",
        "openalex": "retrieval augmented generation multi-agent",
    }

    print(f"[v11.6] Deep Research starting — {len(parser.adapter_names)} sources")

    total_items = 0

    for source_name in parser.adapter_names:
        query = source_queries.get(source_name, combined_query)
        adapter = parser.get_adapter(source_name)
        if not adapter:
            continue

        print(f"  [{source_name}] fetching with query: {query[:60]}...")
        try:
            items = await adapter.fetch(query, limit=TOP_N)
        except Exception as e:
            print(f"  [{source_name}] ERROR: {e}")
            items = []

        total_items += len(items)
        source_dir = OUTPUT_DIR / source_name
        source_dir.mkdir(parents=True, exist_ok=True)

        # Write Markdown report
        md_lines = [
            f"# Deep Research: {source_name}",
            f"*Generated: {timestamp}*",
            f"*Query: {combined_query[:100]}...*",
            f"*Results: {len(items)}*",
            "",
            "---",
            "",
        ]

        for i, item in enumerate(items[:TOP_N], 1):
            md_lines.append(_item_to_md(item, i))

        md_path = source_dir / "top_20.md"
        md_path.write_text("\n".join(md_lines), encoding="utf-8")
        print(f"  [{source_name}] {len(items)} items → {md_path}")

        # Write JSON for programmatic access
        json_data = [
            {
                "title": item.title,
                "url": item.url,
                "source": item.source,
                "summary": item.summary,
                "authors": item.authors,
                "tags": item.tags,
                "score": item.score,
                "published": item.published,
                "extra": item.extra,
            }
            for item in items[:TOP_N]
        ]
        json_path = source_dir / "top_20.json"
        json_path.write_text(json.dumps(json_data, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n[v11.6] Deep Research complete — {total_items} total items across {len(parser.adapter_names)} sources")


if __name__ == "__main__":
    asyncio.run(run_research())
