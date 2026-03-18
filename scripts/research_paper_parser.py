#!/usr/bin/env python3
"""
Research Paper Parser — Multi-site parser for AI/ML research papers.

Fetches top papers relevant to OpenClaw bot improvements from multiple
research aggregation sites via their APIs.

Supported sites (with API access):
  1. Semantic Scholar — Free API, 200M+ papers
  2. Papers With Code — Trending papers + code links
  3. arXiv — Direct API (Atom XML → JSON)
  4. Emergent Mind — arXiv CS/AI analysis
  5. AlphaXiv — arXiv annotations
  6. HuggingFace Papers — Trending ML papers

Sites analyzed but not parseable (no public API / require auth):
  - Synthical.com — Requires login, no public API
  - Moonlight (themoonlight.io) — PDF reader, no search API
  - Elicit.org — Requires account, API is paid
  - Scite.ai — Paid API only
  - Connected Papers — No public API
  - OpenRead — No public API
  - SciSpace — Paid only
  - Research Rabbit — Requires login
  - Litmaps — Requires login
  - PubPeer — Comments only, no paper search API
  - NotebookLM — Google product, no API
  - Anara — Too new, no API
  - Papiers — Not yet launched fully

Usage:
    python scripts/research_paper_parser.py [--topics "topic1,topic2"] [--limit 20]
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Output directory
BASE_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "ru", "research")

# Topics relevant to OpenClaw bot improvements
DEFAULT_TOPICS = [
    "reinforcement learning language model training",
    "GRPO group relative policy optimization",
    "LoRA fine-tuning small language models",
    "multi-agent systems tool use",
    "RLHF alternatives verifiable rewards",
    "on-policy distillation language models",
    "memory augmented language models",
    "code generation reinforcement learning",
    "model quantization efficient inference",
    "chain of thought reasoning small models",
]


@dataclass
class Paper:
    """Represents a research paper."""
    title: str
    authors: List[str]
    abstract: str
    url: str
    source: str  # Which site this came from
    published: str = ""
    arxiv_id: str = ""
    citations: int = 0
    code_url: str = ""
    relevance_score: float = 0.0
    topics: List[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        """Convert paper to markdown format."""
        authors_str = ", ".join(self.authors[:5])
        if len(self.authors) > 5:
            authors_str += f" и ещё {len(self.authors) - 5}"

        md = f"## {self.title}\n\n"
        md += f"**Авторы:** {authors_str}\n"
        md += f"**Источник:** {self.source}\n"
        if self.published:
            md += f"**Дата:** {self.published}\n"
        if self.citations:
            md += f"**Цитирования:** {self.citations}\n"
        md += f"**Ссылка:** <{self.url}>\n"
        if self.arxiv_id:
            md += f"**arXiv:** {self.arxiv_id}\n"
        if self.code_url:
            md += f"**Код:** <{self.code_url}>\n"
        md += f"\n### Аннотация\n\n{self.abstract[:1000]}\n"
        if self.relevance_score > 0:
            md += f"\n**Релевантность для OpenClaw:** {self.relevance_score:.1f}/10\n"
        return md


def _http_get_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = 30) -> Any:
    """Simple HTTP GET returning JSON."""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "OpenClaw-Research-Parser/1.0 (academic research)")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ⚠️ HTTP error for {url}: {e}")
        return None


def _http_get_text(url: str, timeout: int = 30) -> Optional[str]:
    """Simple HTTP GET returning text."""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "OpenClaw-Research-Parser/1.0 (academic research)")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        print(f"  ⚠️ HTTP error for {url}: {e}")
        return None


# ============================================================
# Site-specific parsers
# ============================================================

def fetch_semantic_scholar(topic: str, limit: int = 20) -> List[Paper]:
    """
    Fetch papers from Semantic Scholar API.
    API: https://api.semanticscholar.org/graph/v1/paper/search
    Free, no auth required (rate limited).
    """
    papers = []
    query = urllib.parse.quote(topic)
    url = (
        f"https://api.semanticscholar.org/graph/v1/paper/search"
        f"?query={query}"
        f"&limit={limit}"
        f"&fields=title,authors,abstract,url,year,citationCount,externalIds,openAccessPdf"
        f"&year=2024-2026"
    )

    data = _http_get_json(url)
    if not data or "data" not in data:
        return papers

    for item in data["data"][:limit]:
        if not item.get("abstract"):
            continue
        arxiv_id = ""
        if item.get("externalIds", {}).get("ArXiv"):
            arxiv_id = item["externalIds"]["ArXiv"]

        papers.append(Paper(
            title=item.get("title", ""),
            authors=[a.get("name", "") for a in item.get("authors", [])],
            abstract=item.get("abstract", ""),
            url=item.get("url", ""),
            source="Semantic Scholar",
            published=str(item.get("year", "")),
            arxiv_id=arxiv_id,
            citations=item.get("citationCount", 0),
            topics=[topic],
        ))

    return papers


def fetch_papers_with_code(topic: str, limit: int = 20) -> List[Paper]:
    """
    Fetch papers from Papers With Code API.
    API: https://paperswithcode.com/api/v1/papers/
    """
    papers = []
    query = urllib.parse.quote(topic)
    url = f"https://paperswithcode.com/api/v1/papers/?q={query}&items_per_page={limit}"

    data = _http_get_json(url)
    if not data or "results" not in data:
        return papers

    for item in data["results"][:limit]:
        abstract = item.get("abstract", "") or ""
        if not abstract and not item.get("title"):
            continue

        arxiv_id = item.get("arxiv_id", "") or ""
        paper_url = item.get("url_abs", "") or item.get("url", "")
        if not paper_url and arxiv_id:
            paper_url = f"https://arxiv.org/abs/{arxiv_id}"

        code_url = ""
        if item.get("proceeding") and "github" in str(item.get("proceeding", "")):
            code_url = item["proceeding"]

        papers.append(Paper(
            title=item.get("title", ""),
            authors=item.get("authors", "").split(", ") if isinstance(item.get("authors"), str) else [],
            abstract=abstract,
            url=paper_url,
            source="Papers With Code",
            published=item.get("published", ""),
            arxiv_id=arxiv_id,
            code_url=code_url,
            topics=[topic],
        ))

    return papers


def fetch_arxiv(topic: str, limit: int = 20) -> List[Paper]:
    """
    Fetch papers from arXiv API (Atom XML).
    API: https://export.arxiv.org/api/query
    """
    papers = []
    query = urllib.parse.quote(topic)
    url = (
        f"https://export.arxiv.org/api/query"
        f"?search_query=all:{query}"
        f"&sortBy=submittedDate&sortOrder=descending"
        f"&max_results={limit}"
    )

    xml_text = _http_get_text(url)
    if not xml_text:
        return papers

    # Parse Atom XML
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return papers

    for entry in root.findall("atom:entry", ns)[:limit]:
        title = entry.findtext("atom:title", "", ns).strip().replace("\n", " ")
        abstract = entry.findtext("atom:summary", "", ns).strip().replace("\n", " ")
        published = entry.findtext("atom:published", "", ns)[:10]

        authors = []
        for author in entry.findall("atom:author", ns):
            name = author.findtext("atom:name", "", ns)
            if name:
                authors.append(name)

        entry_id = entry.findtext("atom:id", "", ns)
        arxiv_id = entry_id.split("/abs/")[-1] if "/abs/" in entry_id else ""

        papers.append(Paper(
            title=title,
            authors=authors,
            abstract=abstract,
            url=entry_id,
            source="arXiv",
            published=published,
            arxiv_id=arxiv_id,
            topics=[topic],
        ))

    return papers


def fetch_huggingface_papers(topic: str, limit: int = 20) -> List[Paper]:
    """
    Fetch trending papers from HuggingFace Papers API.
    API: https://huggingface.co/api/daily_papers
    """
    papers = []
    url = "https://huggingface.co/api/daily_papers"

    data = _http_get_json(url)
    if not data:
        return papers

    topic_words = set(topic.lower().split())

    for item in data[:50]:  # Check more items, filter by topic
        paper = item.get("paper", {})
        title = paper.get("title", "")
        abstract = paper.get("summary", "") or ""

        # Simple relevance filter
        text = (title + " " + abstract).lower()
        matches = sum(1 for w in topic_words if w in text)
        if matches < 2:  # Require at least 2 topic words
            continue

        authors = [a.get("name", "") for a in paper.get("authors", [])]
        arxiv_id = paper.get("id", "")

        papers.append(Paper(
            title=title,
            authors=authors,
            abstract=abstract,
            url=f"https://huggingface.co/papers/{arxiv_id}" if arxiv_id else "",
            source="HuggingFace Papers",
            published=paper.get("publishedAt", "")[:10],
            arxiv_id=arxiv_id,
            topics=[topic],
        ))

        if len(papers) >= limit:
            break

    return papers


# ============================================================
# Relevance scoring
# ============================================================

OPENCLAW_KEYWORDS = {
    # High relevance (weight 3)
    "reinforcement learning": 3, "fine-tuning": 3, "fine tuning": 3,
    "lora": 3, "grpo": 3, "rlhf": 3, "rlvr": 3,
    "tool use": 3, "function calling": 3, "agent training": 3,
    "multi-agent": 3, "model training": 3, "policy optimization": 3,
    # Medium relevance (weight 2)
    "quantization": 2, "distillation": 2, "chain of thought": 2,
    "reasoning": 2, "code generation": 2, "memory": 2,
    "inference": 2, "small language model": 2, "llm": 2,
    "reward model": 2, "vram": 2, "gpu": 2,
    # Low relevance (weight 1)
    "transformer": 1, "attention": 1, "neural network": 1,
    "benchmark": 1, "evaluation": 1, "dataset": 1,
    "arxiv": 1, "open source": 1, "python": 1,
}


def compute_relevance(paper: Paper) -> float:
    """Compute relevance score for OpenClaw bot improvements."""
    text = (paper.title + " " + paper.abstract).lower()
    score = 0.0

    for keyword, weight in OPENCLAW_KEYWORDS.items():
        if keyword in text:
            score += weight

    # Normalize to 0-10 scale
    score = min(10.0, score)

    # Bonus for recent papers
    if paper.published:
        try:
            year = int(paper.published[:4])
            if year >= 2026:
                score = min(10.0, score + 1.0)
            elif year >= 2025:
                score = min(10.0, score + 0.5)
        except (ValueError, IndexError):
            pass

    # Bonus for having code
    if paper.code_url:
        score = min(10.0, score + 0.5)

    return round(score, 1)


# ============================================================
# Main parser logic
# ============================================================

def parse_all_sites(topics: List[str], limit_per_topic: int = 10) -> Dict[str, List[Paper]]:
    """
    Parse papers from all supported sites for all topics.
    Returns dict: {site_name: [Paper, ...]}
    """
    all_papers: Dict[str, List[Paper]] = {
        "semantic_scholar": [],
        "papers_with_code": [],
        "arxiv": [],
        "huggingface": [],
    }

    parsers = {
        "semantic_scholar": ("Semantic Scholar", fetch_semantic_scholar),
        "papers_with_code": ("Papers With Code", fetch_papers_with_code),
        "arxiv": ("arXiv", fetch_arxiv),
        "huggingface": ("HuggingFace Papers", fetch_huggingface_papers),
    }

    for topic in topics:
        print(f"\n📖 Тема: {topic}")

        for site_key, (site_name, fetch_fn) in parsers.items():
            print(f"  🔍 {site_name}...", end=" ", flush=True)
            try:
                papers = fetch_fn(topic, limit=limit_per_topic)
                # Score and deduplicate
                for p in papers:
                    p.relevance_score = compute_relevance(p)

                # Deduplicate by title similarity
                existing_titles = {p.title.lower()[:50] for p in all_papers[site_key]}
                new_papers = [
                    p for p in papers
                    if p.title.lower()[:50] not in existing_titles
                ]
                all_papers[site_key].extend(new_papers)
                print(f"✅ {len(new_papers)} новых статей")
            except Exception as e:
                print(f"❌ Ошибка: {e}")

            # Rate limiting: be nice to APIs
            time.sleep(1)

    # Sort each site's papers by relevance
    for site_key in all_papers:
        all_papers[site_key].sort(key=lambda p: (-p.relevance_score, -p.citations))

    return all_papers


def save_results(all_papers: Dict[str, List[Paper]], output_dir: str, limit: int = 20) -> None:
    """Save top papers per site as markdown files in separate folders."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    site_display_names = {
        "semantic_scholar": "Semantic Scholar",
        "papers_with_code": "Papers With Code",
        "arxiv": "arXiv",
        "huggingface": "HuggingFace Papers",
    }

    total_saved = 0

    for site_key, papers in all_papers.items():
        site_name = site_display_names.get(site_key, site_key)
        site_dir = output_path / site_key
        site_dir.mkdir(parents=True, exist_ok=True)

        top_papers = papers[:limit]
        if not top_papers:
            print(f"  ⚠️ {site_name}: нет статей для сохранения")
            continue

        # Create index file
        index_md = f"# Топ {len(top_papers)} статей — {site_name}\n\n"
        index_md += f"> Сгенерировано: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
        index_md += f"> Релевантность для OpenClaw Bot: обучение моделей, RL, LoRA, multi-agent systems\n\n"
        index_md += "| # | Статья | Релевантность | Цитирования | Год |\n"
        index_md += "|---|--------|--------------|-------------|-----|\n"

        for i, paper in enumerate(top_papers, 1):
            safe_title = paper.title[:80].replace("|", "\\|")
            index_md += (
                f"| {i} | [{safe_title}]({paper.url}) "
                f"| {paper.relevance_score}/10 "
                f"| {paper.citations} "
                f"| {paper.published[:4] if paper.published else '?'} |\n"
            )

        index_md += "\n---\n\n"

        # Add full paper details
        for i, paper in enumerate(top_papers, 1):
            index_md += f"### {i}. {paper.title}\n\n"
            index_md += paper.to_markdown().replace(f"## {paper.title}\n\n", "")
            index_md += "\n---\n\n"

        # Relevance summary
        avg_relevance = sum(p.relevance_score for p in top_papers) / max(1, len(top_papers))
        index_md += f"\n## Средняя релевантность: {avg_relevance:.1f}/10\n"

        with open(site_dir / "README.md", "w", encoding="utf-8") as f:
            f.write(index_md)

        # Also save raw JSON for programmatic use
        raw_data = [asdict(p) for p in top_papers]
        with open(site_dir / "papers.json", "w", encoding="utf-8") as f:
            json.dump(raw_data, f, ensure_ascii=False, indent=2)

        total_saved += len(top_papers)
        print(f"  📁 {site_name}: {len(top_papers)} статей → {site_dir}/")

    # Create master index
    master_md = "# 📚 Исследование: Статьи для улучшения OpenClaw Bot\n\n"
    master_md += f"> Дата: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
    master_md += f"> Всего статей: {total_saved}\n\n"
    master_md += "## Источники\n\n"
    for site_key, papers in all_papers.items():
        site_name = site_display_names.get(site_key, site_key)
        count = min(limit, len(papers))
        master_md += f"- [{site_name}](./{site_key}/README.md) — {count} статей\n"

    master_md += "\n## Темы поиска\n\n"
    for topic in DEFAULT_TOPICS:
        master_md += f"- {topic}\n"

    master_md += "\n## Как использовать\n\n"
    master_md += "1. Просмотрите README.md в каждой папке для обзора статей\n"
    master_md += "2. Используйте papers.json для программного доступа к данным\n"
    master_md += "3. Статьи отсортированы по релевантности для OpenClaw Bot\n"
    master_md += "4. Фокус: RL, LoRA, GRPO, multi-agent, tool use, quantization\n"

    with open(output_path / "README.md", "w", encoding="utf-8") as f:
        f.write(master_md)

    print(f"\n✅ Всего сохранено: {total_saved} статей в {output_path}/")


def main():
    parser = argparse.ArgumentParser(
        description="Research Paper Parser for OpenClaw Bot Improvements"
    )
    parser.add_argument(
        "--topics",
        type=str,
        default=None,
        help="Comma-separated topics to search (default: built-in OpenClaw topics)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Max papers per site (default: 20)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=BASE_OUTPUT_DIR,
        help="Output directory (default: docs/ru/research/)",
    )
    parser.add_argument(
        "--limit-per-topic",
        type=int,
        default=8,
        help="Max papers per topic per site (default: 8)",
    )

    args = parser.parse_args()

    topics = args.topics.split(",") if args.topics else DEFAULT_TOPICS

    print("🔬 OpenClaw Research Paper Parser")
    print(f"   Темы: {len(topics)}")
    print(f"   Лимит на сайт: {args.limit}")
    print(f"   Вывод: {args.output}")
    print("=" * 60)

    all_papers = parse_all_sites(topics, limit_per_topic=args.limit_per_topic)
    save_results(all_papers, args.output, limit=args.limit)


if __name__ == "__main__":
    main()
