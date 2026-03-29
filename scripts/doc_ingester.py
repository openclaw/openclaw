"""
Brigade: OpenClaw
Role: Documentation RAG Ingester

Intelligent scraper that:
1. Downloads documentation pages from a configurable URL list.
2. Strips navigation, scripts, and styling via BeautifulSoup.
3. Converts clean HTML to LLM-readable Markdown via markdownify.
4. Splits large pages into context-friendly chunks (~1500 tokens).
5. Saves chunks into .memory-bank/docs/ for QMD vector search.

Usage:
    python doc_ingester.py                  # Ingest all configured sources
    python doc_ingester.py --url <URL>      # Ingest a single URL
"""

import argparse
import hashlib
import json
import os
import re
import textwrap
from datetime import datetime, timezone
from typing import List, Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DOCS_DIR = os.path.join(os.path.dirname(__file__), "..", ".memory-bank", "docs")
CHUNK_SIZE = 1500  # approximate token count per chunk (1 token ≈ 4 chars)
CHAR_LIMIT = CHUNK_SIZE * 4  # character budget per chunk

DEFAULT_SOURCES = [
    # Python 3.14 documentation
    "https://docs.python.org/release/3.14.2/library/asyncio.html",
    "https://docs.python.org/release/3.14.2/library/typing.html",
    "https://docs.python.org/release/3.14.2/whatsnew/3.14.html",
    # Rust Book (stable)
    "https://doc.rust-lang.org/stable/book/ch04-01-what-is-ownership.html",
    "https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html",
    # TypeScript handbook
    "https://www.typescriptlang.org/docs/handbook/2/types-from-types.html",
    "https://www.typescriptlang.org/docs/handbook/2/generics.html",
    # OpenClaw docs
    "https://docs.openclaw.ai/",
    "https://docs.openclaw.ai/concepts/",
    # Ollama API reference
    "https://docs.ollama.com/api",
    "https://docs.ollama.com/",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36 OpenClawBot/1.0"
    )
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _slug(url: str) -> str:
    """Create a filesystem-safe slug from a URL."""
    parsed = urlparse(url)
    path = parsed.netloc + parsed.path
    path = re.sub(r"[^a-zA-Z0-9_\-]", "_", path)
    return path.strip("_")[:120]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------
def fetch_html(url: str) -> Optional[str]:
    """Download raw HTML with a generous timeout."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException as exc:
        print(f"  ⚠️  Failed to fetch {url}: {exc}")
        return None


def clean_html(raw_html: str) -> str:
    """Remove nav, footer, scripts, styles, and other non-content elements."""
    soup = BeautifulSoup(raw_html, "html.parser")

    # Remove noisy elements
    for tag in soup.find_all(
        ["nav", "footer", "header", "script", "style", "aside", "noscript", "iframe"]
    ):
        tag.decompose()

    # Remove common navigation / cookie / ad containers by class/id patterns
    noise_patterns = re.compile(
        r"(nav|menu|sidebar|footer|header|cookie|banner|popup|ad-|promo)", re.I
    )
    for tag in soup.find_all(attrs={"class": noise_patterns}):
        tag.decompose()
    for tag in soup.find_all(attrs={"id": noise_patterns}):
        tag.decompose()

    # Try to isolate content – prefer <main> or <article>
    main = soup.find("main") or soup.find("article")
    if main:
        return str(main)
    # Fallback: return everything inside <body>
    body = soup.find("body")
    return str(body) if body else str(soup)


def html_to_markdown(clean: str) -> str:
    """Convert cleaned HTML to Markdown."""
    result = md(clean, heading_style="ATX", strip=["img"])
    # Collapse excessive blank lines
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def chunk_text(text: str, char_limit: int = CHAR_LIMIT) -> List[str]:
    """
    Split long Markdown into overlapping chunks, breaking at paragraph
    boundaries to preserve meaning.
    """
    paragraphs = re.split(r"\n\n+", text)
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for para in paragraphs:
        para_len = len(para)
        if current_len + para_len > char_limit and current:
            chunks.append("\n\n".join(current))
            # Keep last paragraph as overlap for context continuity
            overlap = current[-1] if current else ""
            current = [overlap] if overlap else []
            current_len = len(overlap)
        current.append(para)
        current_len += para_len

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def save_chunks(
    chunks: List[str],
    url: str,
    output_dir: str = DOCS_DIR,
) -> List[str]:
    """Save each chunk as a numbered Markdown file with front-matter metadata."""
    os.makedirs(output_dir, exist_ok=True)
    slug = _slug(url)
    saved: List[str] = []

    for i, chunk in enumerate(chunks):
        filename = f"{slug}__chunk_{i:03d}.md"
        filepath = os.path.join(output_dir, filename)

        front_matter = textwrap.dedent(f"""\
            ---
            source: "{url}"
            chunk: {i}
            total_chunks: {len(chunks)}
            hash: "{_hash(chunk)}"
            ingested_at: "{datetime.now(timezone.utc).isoformat()}"
            ---
        """)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(front_matter + "\n" + chunk)

        saved.append(filepath)

    return saved


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
def update_manifest(url: str, num_chunks: int, output_dir: str = DOCS_DIR):
    """Maintain a manifest.json tracking all ingested sources."""
    manifest_path = os.path.join(output_dir, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

    manifest[url] = {
        "chunks": num_chunks,
        "slug": _slug(url),
        "last_ingested": datetime.now(timezone.utc).isoformat(),
    }

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------
def ingest_url(url: str) -> int:
    """Full pipeline for a single URL. Returns number of chunks created."""
    print(f"📥 Ingesting: {url}")

    raw = fetch_html(url)
    if not raw:
        return 0

    clean = clean_html(raw)
    markdown = html_to_markdown(clean)

    if len(markdown) < 100:
        print(f"  ⚠️  Content too short after cleaning ({len(markdown)} chars), skipping.")
        return 0

    chunks = chunk_text(markdown)
    saved = save_chunks(chunks, url)
    update_manifest(url, len(chunks))

    print(f"  ✅ Saved {len(chunks)} chunks ({len(markdown)} chars total)")
    return len(chunks)


def ingest_all(urls: Optional[List[str]] = None):
    """Ingest all configured documentation sources."""
    sources = urls or DEFAULT_SOURCES
    total = 0
    print(f"\n{'='*60}")
    print(f"  OpenClaw Doc Ingester — {len(sources)} source(s)")
    print(f"  Output: {os.path.abspath(DOCS_DIR)}")
    print(f"{'='*60}\n")

    for url in sources:
        total += ingest_url(url)

    print(f"\n{'='*60}")
    print(f"  Done. {total} total chunks ingested.")
    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OpenClaw Documentation RAG Ingester")
    parser.add_argument("--url", help="Ingest a single URL instead of all defaults")
    parser.add_argument(
        "--urls-file",
        help="Path to a text file with one URL per line",
    )
    args = parser.parse_args()

    if args.url:
        ingest_all([args.url])
    elif args.urls_file:
        with open(args.urls_file, "r") as f:
            urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]
        ingest_all(urls)
    else:
        ingest_all()
