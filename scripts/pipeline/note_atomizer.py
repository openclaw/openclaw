#!/usr/bin/env python3
"""
note_atomizer.py — 옵시디언 제텔카스텐 원자화 + PARA 승격 파이프라인

5단계: enrich → atomize → promote → link → moc

Usage:
  python3 note_atomizer.py --full              # 전체 5단계
  python3 note_atomizer.py --enrich            # 보강만
  python3 note_atomizer.py --atomize           # 원자화만
  python3 note_atomizer.py --promote           # 승격만
  python3 note_atomizer.py --link              # 크로스링크만
  python3 note_atomizer.py --moc              # MOC 재생성만
  python3 note_atomizer.py --batch-size 50     # 배치 크기 조절
  python3 note_atomizer.py --dry-run           # 미리보기
  python3 note_atomizer.py --report            # 현황 리포트
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from shared.log import make_logger
from shared.classify import load_classification, classify_by_text, get_sector_label, get_category_label

# ══════════════════════════════════════════════════════════════════════════════
# Constants & Paths
# ══════════════════════════════════════════════════════════════════════════════

from shared.vault_paths import VAULT, INBOX, NOTES, STRUCTURE, REPORTS, LEGACY_NOTES

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
INBOX_DIR = INBOX
NOTES_DIR = LEGACY_NOTES
MOC_DIR = STRUCTURE
REPORT_DIR = REPORTS
STATE_FILE = WORKSPACE / "memory" / "note_atomizer_state.json"
TELEGRAM_DATA_DIR = WORKSPACE / "memory" / "telegram-topics"
ANALYSIS_EXPORT_DIR = Path(os.path.expanduser(
    "~/Downloads/지식사랑방_export/Analysis"
))
LOG_DIR = WORKSPACE / "logs"

GATEWAY_URL = "http://127.0.0.1:18789/v1/chat/completions"
GATEWAY_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
if not GATEWAY_TOKEN:
    _env_file = Path(os.path.expanduser("~/.openclaw/.env"))
    if _env_file.exists():
        for _line in _env_file.read_text().splitlines():
            if _line.startswith("OPENCLAW_TOKEN="):
                GATEWAY_TOKEN = _line.split("=", 1)[1].strip().strip('"')

LLM_TIMEOUT = 60
LLM_DELAY = 1.0
LLM_MODEL_CHAIN = ["openclaw:main", "github-copilot/gpt-5-mini", "qwen3:8b"]

# PARA promotion thresholds
PROMOTE_TO_RESOURCES = 60
PROMOTE_TO_AREAS_CANDIDATE = 80
PROMOTE_LLM_RANGE = (40, 59)

# Cross-link thresholds
JACCARD_THRESHOLD = 0.15
MAX_RELATED_PER_NOTE = 10

# ══════════════════════════════════════════════════════════════════════════════
# v3 classification compatibility
# ══════════════════════════════════════════════════════════════════════════════


def _is_v3_classification(classification):
    """Check if classification dict is v3 format."""
    return classification and "categories" in classification


def _normalize_classify_result(result):
    """Normalize v3 classify_by_text() result to v2-compatible keys.

    v3 returns {category, subcategory, folder, ...}
    v2 returns {sector, industry_group, industry, domain, ...}
    Frontmatter and internal code expects v2 keys.
    """
    if "sector" in result:
        return result  # Already v2
    return {
        "sector": result.get("category", "UNCLASSIFIED"),
        "industry_group": result.get("subcategory", ""),
        "industry": "",
        "domain": "general",
        "matched_tags": result.get("matched_tags", []),
        "confidence": result.get("confidence", 0.0),
        "runner_up": result.get("runner_up"),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Logging
# ══════════════════════════════════════════════════════════════════════════════

_LOG_LINES = []
log = make_logger(collector=_LOG_LINES)


# ══════════════════════════════════════════════════════════════════════════════
# State Management (idempotency)
# ══════════════════════════════════════════════════════════════════════════════

def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            log("State file corrupt, starting fresh", "WARN")
    return {"version": 1, "notes": {}, "last_run": None, "stats": {}}


def save_state(state):
    state["last_run"] = datetime.now().isoformat()
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(STATE_FILE)


def content_hash(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:12]


def note_state(state, filename):
    return state["notes"].setdefault(filename, {
        "enriched": False, "atomized": False,
        "promoted": False, "linked": False,
        "content_hash": "", "phase_log": [],
    })


# Classification functions delegated to shared.classify:
# load_classification, classify_by_text, get_sector_label


# ══════════════════════════════════════════════════════════════════════════════
# Frontmatter parsing & rendering
# ══════════════════════════════════════════════════════════════════════════════

def parse_frontmatter(filepath):
    """마크다운 노트에서 frontmatter + body 추출."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}, ""

    meta = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    k = key.strip()
                    v = val.strip()
                    # Parse JSON arrays
                    if v.startswith("["):
                        try:
                            meta[k] = json.loads(v)
                        except json.JSONDecodeError:
                            meta[k] = v.strip("[]").replace('"', '').split(",")
                            meta[k] = [t.strip() for t in meta[k] if t.strip()]
                    else:
                        meta[k] = v.strip('"').strip("'")
            body = parts[2]
    return meta, body


def render_frontmatter(meta):
    """dict → YAML frontmatter string."""
    lines = ["---"]
    key_order = [
        "title", "date", "tags", "sector", "industry_group", "industry",
        "zk_type", "maturity", "para_bucket", "domain", "source_type",
        "source", "purpose",
    ]
    done = set()
    for k in key_order:
        if k in meta:
            lines.append(_fm_line(k, meta[k]))
            done.add(k)
    for k, v in meta.items():
        if k not in done:
            lines.append(_fm_line(k, v))
    lines.append("---")
    return "\n".join(lines)


def _fm_line(k, v):
    if isinstance(v, list):
        return f"{k}: {json.dumps(v, ensure_ascii=False)}"
    elif isinstance(v, bool):
        return f"{k}: {'true' if v else 'false'}"
    elif isinstance(v, (int, float)):
        return f"{k}: {v}"
    else:
        return f'{k}: "{v}"'


def rewrite_note(filepath, meta, body):
    """노트 파일 재작성 (frontmatter + body)."""
    content = render_frontmatter(meta) + "\n" + body
    tmp = filepath.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.rename(filepath)


def body_line_count(body):
    """의미 있는 본문 줄 수."""
    lines = [l for l in body.strip().split("\n") if l.strip() and
             not l.strip().startswith("#") and
             l.strip() != "(registry에서 생성된 시드 노트)"]
    return len(lines)


# ══════════════════════════════════════════════════════════════════════════════
# Keyword extraction & similarity
# ══════════════════════════════════════════════════════════════════════════════

_STOPWORDS = {
    "the", "and", "for", "from", "with", "this", "that", "are", "was",
    "have", "has", "been", "will", "can", "not", "but", "all", "you",
    "하는", "있는", "것을", "것이", "위해", "대한", "통해", "않는",
    "합니다", "입니다", "습니다", "입니다", "에서", "으로", "에게",
}


def extract_keywords(text):
    if not text:
        return set()
    korean = set(re.findall(r"[가-힣]{2,}", text))
    english = set(w.lower() for w in re.findall(r"[a-zA-Z]{3,}", text))
    return (korean | english) - _STOPWORDS


def jaccard_similarity(set_a, set_b):
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    union = set_a | set_b
    return len(intersection) / len(union) if union else 0.0


def extract_tickers(text):
    """종목 티커/이름 추출."""
    tickers = set()
    # 한국 종목명 패턴 (xx전자, xx바이오 등)
    kr_names = re.findall(r"[가-힣]{2,}(?:전자|바이오|제약|증권|화학|건설|에너지|그룹|산업)", text)
    tickers.update(kr_names)
    # US tickers
    us_tickers = re.findall(r"\b[A-Z]{2,5}\b", text)
    known_tickers = {"NVDA", "AMD", "TSMC", "ASML", "INTC", "QCOM", "AAPL",
                     "MSFT", "GOOG", "AMZN", "META", "TSLA", "VRT", "HLB",
                     "SOXX", "SMH", "QQQ", "SPY", "VOO", "BTC", "ETH"}
    tickers.update(t for t in us_tickers if t in known_tickers)
    return tickers


def extract_wikilinks(text):
    return set(re.findall(r"\[\[(.+?)\]\]", text))


def extract_urls(text):
    return re.findall(r"https?://[^\s\)\"']+", text)


# ══════════════════════════════════════════════════════════════════════════════
# LLM helpers
# ══════════════════════════════════════════════════════════════════════════════

_llm_available = None


def check_gateway():
    global _llm_available
    try:
        req = Request(
            "http://127.0.0.1:18789/health",
            method="GET",
        )
        with urlopen(req, timeout=5) as r:
            _llm_available = r.status == 200
    except Exception:
        _llm_available = False
    return _llm_available


def call_llm(system_msg, user_msg, max_tokens=2000):
    """Gateway LLM 호출. Returns (ok, response_text)."""
    if _llm_available is False:
        return False, "Gateway unavailable"

    for model_id in LLM_MODEL_CHAIN:
        payload = json.dumps({
            "model": model_id,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }, ensure_ascii=False).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        if GATEWAY_TOKEN:
            headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

        req = Request(GATEWAY_URL, data=payload, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=LLM_TIMEOUT) as r:
                data = json.loads(r.read().decode("utf-8"))
            choices = data.get("choices", [])
            if choices:
                text = choices[0].get("message", {}).get("content", "").strip()
                if text:
                    time.sleep(LLM_DELAY)
                    return True, text
        except (HTTPError, URLError, TimeoutError, OSError) as e:
            log(f"LLM call failed ({model_id}): {e}", "WARN")
            continue
        except Exception as e:
            log(f"LLM unexpected error ({model_id}): {e}", "ERROR")
            continue

    return False, "All models failed"


# ══════════════════════════════════════════════════════════════════════════════
# Vault scanning
# ══════════════════════════════════════════════════════════════════════════════

def scan_all_notes():
    """수신함 + 노트 디렉토리의 모든 .md 파일 스캔."""
    notes = []
    for search_dir, location in [(INBOX_DIR, "inbox"), (NOTES_DIR, "notes")]:
        if not search_dir.exists():
            continue
        for md_file in sorted(search_dir.glob("*.md")):
            meta, body = parse_frontmatter(md_file)
            if meta is None:
                continue
            notes.append({
                "path": md_file,
                "filename": md_file.name,
                "stem": md_file.stem,
                "location": location,
                "meta": meta,
                "body": body,
                "keywords": extract_keywords(
                    (body or "") + " " + meta.get("title", "")
                ),
                "tickers": extract_tickers(
                    (body or "") + " " + meta.get("title", "")
                ),
                "wikilinks": extract_wikilinks(body or ""),
            })
    return notes


def load_telegram_data():
    """텔레그램 JSON 파일 전체 로드 → {topic: [entries]}."""
    data = defaultdict(list)
    if not TELEGRAM_DATA_DIR.exists():
        return data
    for topic_dir in TELEGRAM_DATA_DIR.iterdir():
        if not topic_dir.is_dir():
            continue
        for jf in topic_dir.glob("*.json"):
            try:
                entry = json.loads(jf.read_text(encoding="utf-8"))
                data[entry.get("topic", topic_dir.name)].append(entry)
            except (json.JSONDecodeError, OSError):
                continue
    return data


def load_analysis_exports():
    """Analysis 내보내기 파일 목록 로드."""
    exports = []
    if not ANALYSIS_EXPORT_DIR.exists():
        return exports
    for f in ANALYSIS_EXPORT_DIR.iterdir():
        if f.suffix in (".md", ".txt"):
            try:
                exports.append({
                    "path": f,
                    "name": f.stem,
                    "content": f.read_text(encoding="utf-8"),
                })
            except (OSError, UnicodeDecodeError):
                continue
    return exports


# ══════════════════════════════════════════════════════════════════════════════
# Phase 1: Enrich (콘텐츠 보강)
# ══════════════════════════════════════════════════════════════════════════════

def phase_enrich(notes, state, batch_size, dry_run, classification):
    """빈 스텁 노트에 콘텐츠 채우기."""
    log("=" * 60)
    log("Phase 1: ENRICH — 콘텐츠 보강")
    log("=" * 60)

    # 보강 대상: 본문 3줄 이하 노트
    targets = []
    for n in notes:
        if n["location"] != "inbox":
            continue
        ns = note_state(state, n["filename"])
        if ns["enriched"]:
            old_hash = ns.get("content_hash", "")
            new_hash = content_hash(n["body"] or "")
            if old_hash == new_hash:
                continue
        if body_line_count(n["body"] or "") <= 3:
            targets.append(n)

    log(f"보강 대상: {len(targets)}건 (배치: {batch_size})")
    targets = targets[:batch_size]

    # Pre-load enrichment sources
    telegram_data = load_telegram_data()
    analysis_exports = load_analysis_exports()
    all_telegram_texts = {}
    for topic, entries in telegram_data.items():
        for entry in entries:
            key = entry.get("text", "")[:40] or entry.get("url", "")[:40]
            if key:
                all_telegram_texts[key.lower()] = entry

    stats = {"enriched": 0, "skipped": 0, "llm_calls": 0, "methods": defaultdict(int)}

    for i, note in enumerate(targets, 1):
        title = note["meta"].get("title", note["stem"])
        log(f"  [{i}/{len(targets)}] {title[:50]}...")

        enrichment = _try_enrich(note, telegram_data, all_telegram_texts,
                                 analysis_exports, classification)

        if not enrichment:
            stats["skipped"] += 1
            continue

        method, new_body = enrichment

        if dry_run:
            log(f"    [DRY] method={method}, body_preview={new_body[:80]}...")
            stats["enriched"] += 1
            stats["methods"][method] += 1
            continue

        # Update note
        meta = note["meta"]
        meta["enriched_at"] = datetime.now().strftime("%Y-%m-%d")
        meta["enrichment_method"] = method

        # Append enrichment to existing body
        old_body = note["body"] or ""
        # Strip stub text
        old_body = old_body.replace("(registry에서 생성된 시드 노트)", "").strip()
        if old_body:
            full_body = f"\n{old_body}\n\n{new_body}\n"
        else:
            full_body = f"\n# {title}\n\n{new_body}\n"

        rewrite_note(note["path"], meta, full_body)

        ns = note_state(state, note["filename"])
        ns["enriched"] = True
        ns["content_hash"] = content_hash(full_body)
        ns["phase_log"].append(f"enriched:{method}:{datetime.now().isoformat()}")

        stats["enriched"] += 1
        stats["methods"][method] += 1
        if method == "llm_synthesis":
            stats["llm_calls"] += 1

    log(f"Phase 1 완료: 보강 {stats['enriched']}건, 스킵 {stats['skipped']}건")
    log(f"  방법별: {dict(stats['methods'])}")
    return stats


def _try_enrich(note, telegram_data, telegram_index, analysis_exports, classification):
    """보강 시도. Returns (method, body_text) or None."""
    title = note["meta"].get("title", note["stem"])
    source_msgid = note["meta"].get("source_msgid", "")
    source = note["meta"].get("source", "")
    tags = note["meta"].get("tags", [])

    # Priority 1: Telegram JSON matching
    enrichment = _enrich_from_telegram(title, source_msgid, telegram_data, telegram_index)
    if enrichment:
        return "telegram", enrichment

    # Priority 2: Analysis export fuzzy matching
    enrichment = _enrich_from_analysis(title, analysis_exports)
    if enrichment:
        return "analysis_export", enrichment

    # Priority 3: LLM synthesis
    if _llm_available is not False:
        enrichment = _enrich_via_llm(title, tags, note["meta"], classification)
        if enrichment:
            return "llm_synthesis", enrichment

    return None


def _enrich_from_telegram(title, source_msgid, telegram_data, telegram_index):
    """텔레그램 JSON에서 콘텐츠 추출."""
    # By message ID
    if source_msgid:
        for topic, entries in telegram_data.items():
            for entry in entries:
                if str(entry.get("message_id", "")) == str(source_msgid):
                    return _format_telegram_entry(entry)

    # By fuzzy title match
    title_lower = title.lower()[:40]
    for key, entry in telegram_index.items():
        if SequenceMatcher(None, title_lower, key).ratio() > 0.6:
            return _format_telegram_entry(entry)

    return None


def _format_telegram_entry(entry):
    """텔레그램 엔트리를 마크다운 본문으로 포맷."""
    parts = []
    text = entry.get("text", "")
    url = entry.get("url", "")
    file_path = entry.get("file", "")
    author = entry.get("author", "")
    topic = entry.get("topic", "")

    if text:
        parts.append(text)
    if url:
        parts.append(f"\n**소스**: {url}")
    if file_path:
        parts.append(f"\n**첨부**: `{file_path}`")
    if author:
        parts.append(f"\n*— {author} via {topic}*")

    return "\n".join(parts) if parts else None


def _enrich_from_analysis(title, analysis_exports):
    """Analysis 내보내기에서 퍼지 매칭."""
    if not analysis_exports:
        return None

    best_match = None
    best_ratio = 0.0

    for export in analysis_exports:
        ratio = SequenceMatcher(None, title.lower(), export["name"].lower()).ratio()
        if ratio > best_ratio and ratio > 0.4:
            best_ratio = ratio
            best_match = export

    if best_match:
        content = best_match["content"].strip()
        if len(content) > 50:
            return content[:3000]  # Cap at 3000 chars

    return None


def _enrich_via_llm(title, tags, meta, classification):
    """LLM으로 제목+태그+섹터 기반 핵심 내용 합성."""
    sector = meta.get("sector", "UNCLASSIFIED")
    sector_label = ""
    if classification and sector != "UNCLASSIFIED":
        if _is_v3_classification(classification):
            sector_label = get_category_label(classification, sector)
        else:
            sector_label = classification.get("sectors", {}).get(
                sector, {}
            ).get("label", "")

    tag_str = ", ".join(tags[:10]) if isinstance(tags, list) else str(tags)

    system_msg = (
        "당신은 투자·기술 지식 정리 전문가입니다. "
        "주어진 제목과 태그를 바탕으로 핵심 내용을 200-500자로 합성하세요. "
        "마크다운 형식. 추측 내용은 반드시 '(추정)' 표시."
    )
    user_msg = (
        f"제목: {title}\n"
        f"태그: {tag_str}\n"
        f"섹터: {sector} {sector_label}\n\n"
        f"이 주제의 핵심 내용을 200-500자로 합성해주세요. "
        f"구체적 팩트가 없으면 (추정)으로 표시하세요."
    )

    ok, response = call_llm(system_msg, user_msg, max_tokens=1000)
    if ok and len(response.strip()) > 50:
        return f"**(추정) LLM 합성 콘텐츠**\n\n{response.strip()}"
    return None


# ══════════════════════════════════════════════════════════════════════════════
# Phase 2: Atomize (원자화)
# ══════════════════════════════════════════════════════════════════════════════

def phase_atomize(notes, state, batch_size, dry_run, classification):
    """규칙 기반 분할 + LLM 판단."""
    log("=" * 60)
    log("Phase 2: ATOMIZE — 원자화")
    log("=" * 60)

    targets = []
    for n in notes:
        ns = note_state(state, n["filename"])
        if ns["atomized"]:
            continue
        if body_line_count(n["body"] or "") < 2:
            # 본문 없는 노트는 원자화 대상 아님
            ns["atomized"] = True
            continue
        targets.append(n)

    log(f"원자화 대상: {len(targets)}건 (배치: {batch_size})")
    targets = targets[:batch_size]

    stats = {"split": 0, "already_atomic": 0, "children_created": 0, "llm_calls": 0}

    for i, note in enumerate(targets, 1):
        title = note["meta"].get("title", note["stem"])
        body = note["body"] or ""
        log(f"  [{i}/{len(targets)}] {title[:50]}...")

        splits = _detect_splits(note, classification)

        if not splits:
            ns = note_state(state, note["filename"])
            ns["atomized"] = True
            ns["phase_log"].append(f"atomized:atomic:{datetime.now().isoformat()}")
            stats["already_atomic"] += 1
            continue

        if dry_run:
            log(f"    [DRY] 분할 감지: {len(splits)}건 — {[s['reason'] for s in splits]}")
            stats["split"] += 1
            stats["children_created"] += len(splits)
            continue

        # Create child notes
        children = []
        for split in splits:
            child_path = _create_child_note(note, split, classification)
            if child_path:
                children.append(child_path.name)
                stats["children_created"] += 1

        # Update parent with atomized_into
        if children:
            meta = note["meta"]
            meta["atomized_into"] = children
            meta["atomized_at"] = datetime.now().strftime("%Y-%m-%d")
            # Add backlinks in body
            body_addition = "\n\n## 분할된 노트\n"
            for child in children:
                body_addition += f"- [[{Path(child).stem}]]\n"
            rewrite_note(note["path"], meta, body + body_addition)
            stats["split"] += 1

        ns = note_state(state, note["filename"])
        ns["atomized"] = True
        ns["phase_log"].append(f"atomized:split:{len(children)}:{datetime.now().isoformat()}")

    log(f"Phase 2 완료: 분할 {stats['split']}건, 이미 원자적 {stats['already_atomic']}건, "
        f"자식 노트 {stats['children_created']}건 생성")
    return stats


def _detect_splits(note, classification):
    """규칙 기반 분할 트리거 감지."""
    body = note["body"] or ""
    title = note["meta"].get("title", "")
    full_text = f"{title}\n{body}"
    splits = []

    # Rule 1: 복수 종목 → 종목별 분할
    tickers = extract_tickers(full_text)
    if len(tickers) >= 2:
        for ticker in sorted(tickers):
            # Extract content related to this ticker
            relevant_lines = []
            for line in body.split("\n"):
                if ticker.lower() in line.lower() or ticker in line:
                    relevant_lines.append(line)
            if relevant_lines:
                splits.append({
                    "reason": f"ticker:{ticker}",
                    "title": f"{title} — {ticker}",
                    "body": "\n".join(relevant_lines),
                    "extra_tags": [ticker],
                })

    # Rule 2: 복수 섹터 교차 → 합성 노트
    if classification:
        sector_mentions = set()
        sectors = classification.get("sectors", {})
        for s_code, sector in sectors.items():
            label = sector.get("label", "")
            if label and label.lower() in full_text.lower():
                sector_mentions.add(s_code)
            for ig in sector.get("industry_groups", {}).values():
                for ind in ig.get("industries", {}).values():
                    for tag in ind.get("tags", []):
                        if tag.lower() in full_text.lower():
                            sector_mentions.add(s_code)
                            break

        if len(sector_mentions) >= 2 and not splits:
            splits.append({
                "reason": f"cross_sector:{'_'.join(sorted(sector_mentions))}",
                "title": f"[합성] {title}",
                "body": body,
                "extra_tags": ["synthesis"],
                "zk_type": "synthesis",
            })

    # Rule 3: 복수 URL → 소스별 literature 노트
    urls = extract_urls(full_text)
    if len(urls) >= 2 and not splits:
        for j, url in enumerate(urls[:5]):
            # Find surrounding context
            context_lines = []
            for line in body.split("\n"):
                if url in line:
                    context_lines.append(line)
            splits.append({
                "reason": f"url:{j}",
                "title": f"{title} — 소스 {j+1}",
                "body": "\n".join(context_lines) if context_lines else url,
                "extra_tags": ["source/url"],
                "source": url,
            })

    # Rule 4: 본문 300자 초과 시 LLM 판단 (splits가 이미 있으면 스킵)
    if not splits and len(body) > 300 and _llm_available is not False:
        llm_splits = _llm_atomize_check(title, body)
        if llm_splits:
            splits.extend(llm_splits)

    return splits


def _llm_atomize_check(title, body):
    """LLM에게 원자화 필요 여부 판단 요청."""
    system_msg = (
        "제텔카스텐 원자화 전문가입니다. "
        "노트를 분석하여 독립적인 아이디어 단위로 분할이 필요한지 판단하세요."
    )
    user_msg = (
        f"제목: {title}\n본문:\n{body[:1500]}\n\n"
        f"이 노트를 독립적 아이디어로 분할해야 합니까?\n"
        f"분할 필요 시 JSON 배열로 응답: "
        f'[{{"title": "...", "key_content": "..."}}]\n'
        f"분할 불필요 시: []"
    )
    ok, response = call_llm(system_msg, user_msg, max_tokens=1500)
    if not ok:
        return None

    # Parse JSON response
    try:
        match = re.search(r'\[.*\]', response, re.DOTALL)
        if match:
            items = json.loads(match.group())
            if len(items) >= 2:
                splits = []
                for item in items[:5]:
                    splits.append({
                        "reason": "llm_split",
                        "title": item.get("title", "Untitled"),
                        "body": item.get("key_content", ""),
                        "extra_tags": [],
                    })
                return splits
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def _create_child_note(parent, split_info, classification):
    """자식 노트 생성."""
    parent_meta = parent["meta"]
    title = split_info["title"]

    # Sanitize filename
    slug = re.sub(r"[^\w가-힣\s-]", "", title)
    slug = re.sub(r"\s+", "_", slug.strip())[:60]
    if not slug:
        slug = f"child_{content_hash(title)}"

    filename = f"{slug}.md"
    # Determine location based on parent
    dest_dir = parent["path"].parent
    filepath = dest_dir / filename

    # Avoid collisions
    c = 1
    while filepath.exists():
        filepath = dest_dir / f"{slug}_{c}.md"
        c += 1

    # Build frontmatter
    tags = list(parent_meta.get("tags", []))
    for t in split_info.get("extra_tags", []):
        if t not in tags:
            tags.append(t)

    child_meta = {
        "title": title[:80],
        "date": parent_meta.get("date", datetime.now().strftime("%Y-%m-%d")),
        "tags": tags,
        "sector": parent_meta.get("sector", "UNCLASSIFIED"),
        "industry_group": parent_meta.get("industry_group", ""),
        "industry": parent_meta.get("industry", ""),
        "zk_type": split_info.get("zk_type", "literature"),
        "maturity": "seedling",
        "para_bucket": parent_meta.get("para_bucket", "inbox"),
        "domain": parent_meta.get("domain", "general"),
        "source_type": parent_meta.get("source_type", "capture"),
        "source": split_info.get("source", parent_meta.get("source", "")),
        "parent_note": parent["stem"],
        "split_reason": split_info["reason"],
    }

    # If better classification from split, re-classify
    if classification and split_info.get("extra_tags"):
        combined = f"{title} {split_info.get('body', '')}"
        gics = _normalize_classify_result(
            classify_by_text(combined, classification=classification)
        )
        if gics["sector"] != "UNCLASSIFIED":
            child_meta["sector"] = gics["sector"]
            child_meta["industry_group"] = gics["industry_group"]
            child_meta["industry"] = gics["industry"]
            child_meta["domain"] = gics["domain"]
            # Low-confidence flagging
            confidence = gics.get("confidence", 0.0)
            if confidence > 0 and confidence < 0.4:
                child_meta["classification_confidence"] = "low"
                child_meta["needs_review"] = True

    body = f"\n# {title}\n\n{split_info.get('body', '')}\n\n"
    body += f"## 출처\n- [[{parent['stem']}]] (원본 노트)\n"

    content = render_frontmatter(child_meta) + body
    filepath.write_text(content, encoding="utf-8")
    log(f"    자식 노트 생성: {filepath.name}")
    return filepath


# ══════════════════════════════════════════════════════════════════════════════
# Phase 3: Promote (PARA 승격)
# ══════════════════════════════════════════════════════════════════════════════

def phase_promote(notes, state, batch_size, dry_run, classification):
    """규칙 기반 스코어링 + PARA 승격."""
    log("=" * 60)
    log("Phase 3: PROMOTE — PARA 승격")
    log("=" * 60)

    # Build inlink index (어떤 노트가 어떤 노트를 링크하는지)
    inlinks = defaultdict(set)
    for n in notes:
        for link in n["wikilinks"]:
            inlinks[link].add(n["stem"])

    targets = []
    for n in notes:
        if n["location"] != "inbox":
            continue
        ns = note_state(state, n["filename"])
        if ns["promoted"]:
            continue
        targets.append(n)

    log(f"승격 대상: {len(targets)}건 (배치: {batch_size})")
    targets = targets[:batch_size]

    stats = {
        "promoted_resources": 0, "promoted_areas_candidate": 0,
        "llm_judged": 0, "stayed_inbox": 0,
    }

    for i, note in enumerate(targets, 1):
        title = note["meta"].get("title", note["stem"])
        score = _compute_promote_score(note, inlinks)

        log(f"  [{i}/{len(targets)}] {title[:40]}... score={score}")

        if score >= PROMOTE_TO_RESOURCES:
            new_bucket = "resources"
            new_zk_type = "literature"
            new_maturity = "seedling"

            if score >= PROMOTE_TO_AREAS_CANDIDATE:
                new_bucket = "areas"
                new_zk_type = "permanent"
                new_maturity = "growing"
                stats["promoted_areas_candidate"] += 1
            else:
                stats["promoted_resources"] += 1

            if dry_run:
                log(f"    [DRY] 승격: {note['meta'].get('para_bucket', 'inbox')} → {new_bucket}")
                continue

            _execute_promotion(note, state, new_bucket, new_zk_type, new_maturity)

        elif PROMOTE_LLM_RANGE[0] <= score <= PROMOTE_LLM_RANGE[1]:
            # LLM judgment for borderline cases
            if _llm_available is not False:
                llm_bucket = _llm_promote_judge(note, score)
                stats["llm_judged"] += 1
                if llm_bucket and llm_bucket != "inbox":
                    if not dry_run:
                        zk = "literature" if llm_bucket == "resources" else "permanent"
                        mat = "seedling" if llm_bucket == "resources" else "growing"
                        _execute_promotion(note, state, llm_bucket, zk, mat)
                    log(f"    [LLM] 승격 판단: → {llm_bucket}")
                else:
                    stats["stayed_inbox"] += 1
            else:
                stats["stayed_inbox"] += 1
        else:
            stats["stayed_inbox"] += 1
            ns = note_state(state, note["filename"])
            ns["promoted"] = True  # Mark as evaluated

    log(f"Phase 3 완료: resources {stats['promoted_resources']}건, "
        f"areas후보 {stats['promoted_areas_candidate']}건, "
        f"LLM판단 {stats['llm_judged']}건, 유지 {stats['stayed_inbox']}건")
    return stats


def _compute_promote_score(note, inlinks):
    """PARA 승격 스코어 계산 (0-100)."""
    score = 0
    meta = note["meta"]
    body = note["body"] or ""

    # +20: 본문 있음
    if body_line_count(body) > 3:
        score += 20

    # +15: GICS 분류됨
    if meta.get("sector", "UNCLASSIFIED") != "UNCLASSIFIED":
        score += 15

    # +15: 보강됨
    if meta.get("enriched_at") or meta.get("enrichment_method"):
        score += 15

    # +10: 위키링크 있음
    if note["wikilinks"]:
        score += 10

    # +10: 태그 3개 이상
    tags = meta.get("tags", [])
    if isinstance(tags, list) and len(tags) >= 3:
        score += 10

    # +10: 소스 URL 있음
    if meta.get("source") or extract_urls(body):
        score += 10

    # +10: 원자적 (atomized_into 없거나 이미 자식)
    if not meta.get("atomized_into"):
        score += 10

    # +10: 인링크 있음
    if note["stem"] in inlinks:
        score += 10

    return min(score, 100)


def _execute_promotion(note, state, new_bucket, new_zk_type, new_maturity):
    """실제 승격 실행: 메타 업데이트 + 파일 이동."""
    meta = note["meta"]
    old_bucket = meta.get("para_bucket", "inbox")
    meta["para_bucket"] = new_bucket
    meta["zk_type"] = new_zk_type
    meta["maturity"] = new_maturity
    meta["promoted_at"] = datetime.now().strftime("%Y-%m-%d")
    meta["promoted_from"] = old_bucket

    old_path = note["path"]
    if old_bucket == "inbox" and new_bucket in ("resources", "areas"):
        # Move from 110 → 120
        new_path = NOTES_DIR / note["filename"]
        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        # Avoid collision
        c = 1
        while new_path.exists():
            new_path = NOTES_DIR / f"{note['stem']}_{c}.md"
            c += 1

        rewrite_note(old_path, meta, note["body"] or "")
        old_path.rename(new_path)
        log(f"    승격: {old_path.name} → {NOTES_DIR.name}/{new_path.name} ({new_bucket})")
    else:
        # Just update metadata
        rewrite_note(old_path, meta, note["body"] or "")
        log(f"    메타 업데이트: {old_path.name} → {new_bucket}")

    ns = note_state(state, note["filename"])
    ns["promoted"] = True
    ns["phase_log"].append(f"promoted:{new_bucket}:{datetime.now().isoformat()}")


def _llm_promote_judge(note, score):
    """LLM에게 PARA 버킷 결정 위임."""
    title = note["meta"].get("title", "")
    body_preview = (note["body"] or "")[:500]
    tags = note["meta"].get("tags", [])

    system_msg = (
        "PARA 지식관리 전문가입니다. 노트의 PARA 버킷을 판단하세요.\n"
        "- inbox: 아직 가치 판단 불가\n"
        "- resources: 참고 가치 있는 자료\n"
        "- areas: 지속적으로 관리해야 할 지식 영역\n"
        "한 단어로만 응답: inbox / resources / areas"
    )
    user_msg = (
        f"제목: {title}\n태그: {tags}\n현재 점수: {score}/100\n"
        f"본문 미리보기:\n{body_preview}\n\n"
        f"이 노트의 PARA 버킷은?"
    )

    ok, response = call_llm(system_msg, user_msg, max_tokens=50)
    if ok:
        resp = response.strip().lower()
        for bucket in ["areas", "resources", "inbox"]:
            if bucket in resp:
                return bucket
    return "inbox"


# ══════════════════════════════════════════════════════════════════════════════
# Phase 4: Cross-link (크로스링크)
# ══════════════════════════════════════════════════════════════════════════════

def phase_link(notes, state, batch_size, dry_run, classification):
    """자동 크로스링크 생성."""
    log("=" * 60)
    log("Phase 4: LINK — 크로스링크")
    log("=" * 60)

    # Re-scan to pick up newly created/moved notes
    notes = scan_all_notes()

    # Build indices
    by_industry = defaultdict(list)
    by_ticker = defaultdict(list)
    by_sector = defaultdict(list)
    stem_to_note = {}

    for n in notes:
        stem_to_note[n["stem"]] = n
        sector = n["meta"].get("sector", "")
        industry = n["meta"].get("industry", "")
        if industry:
            by_industry[industry].append(n)
        if sector:
            by_sector[sector].append(n)
        for ticker in n["tickers"]:
            by_ticker[ticker].append(n)

    # Target: notes not yet linked
    targets = []
    for n in notes:
        ns = note_state(state, n["filename"])
        if ns["linked"]:
            continue
        targets.append(n)

    log(f"링크 대상: {len(targets)}건 (배치: {batch_size})")
    targets = targets[:batch_size]

    # Build inverted keyword index once for O(N) → O(candidates) Jaccard
    kw_index = _build_keyword_index(notes)

    stats = {"linked": 0, "links_added": 0}

    for i, note in enumerate(targets, 1):
        title = note["meta"].get("title", note["stem"])
        existing_links = note["wikilinks"]

        # Find candidates
        candidates = _find_link_candidates(
            note, by_industry, by_ticker, by_sector, stem_to_note, notes,
            kw_index=kw_index,
        )

        # Remove already-linked and self
        new_links = []
        for cand_stem, reason, sim in candidates:
            if cand_stem == note["stem"]:
                continue
            if cand_stem in existing_links:
                continue
            if len(new_links) >= MAX_RELATED_PER_NOTE:
                break
            new_links.append((cand_stem, reason, sim))

        if not new_links:
            ns = note_state(state, note["filename"])
            ns["linked"] = True
            continue

        if dry_run:
            log(f"  [{i}] {title[:40]}: +{len(new_links)} links")
            for stem, reason, sim in new_links[:3]:
                log(f"    → [[{stem}]] ({reason}, {sim:.2f})")
            stats["linked"] += 1
            stats["links_added"] += len(new_links)
            continue

        # Append "## 관련 노트" section
        body = note["body"] or ""
        if "## 관련 노트" not in body:
            body += "\n\n## 관련 노트\n"
        for stem, reason, sim in new_links:
            body += f"- [[{stem}]] — {reason}\n"

        rewrite_note(note["path"], note["meta"], body)

        ns = note_state(state, note["filename"])
        ns["linked"] = True
        ns["phase_log"].append(f"linked:{len(new_links)}:{datetime.now().isoformat()}")
        stats["linked"] += 1
        stats["links_added"] += len(new_links)

    log(f"Phase 4 완료: {stats['linked']}건 노트에 {stats['links_added']}개 링크 추가")
    return stats


def _build_keyword_index(all_notes):
    """키워드 inverted index 구축. Returns {keyword: set(note_index)}."""
    kw_to_indices = defaultdict(set)
    for i, n in enumerate(all_notes):
        for kw in n["keywords"]:
            kw_to_indices[kw].add(i)
    return kw_to_indices


def _find_link_candidates(note, by_industry, by_ticker, by_sector, stem_to_note, all_notes,
                          kw_index=None):
    """링크 후보 탐색. Returns [(stem, reason, similarity)]."""
    candidates = {}  # stem → (reason, similarity)

    industry = note["meta"].get("industry", "")
    sector = note["meta"].get("sector", "")

    # Same industry
    if industry and industry in by_industry:
        for n2 in by_industry[industry]:
            if n2["stem"] != note["stem"]:
                candidates[n2["stem"]] = ("같은 산업", 0.8)

    # Same ticker
    for ticker in note["tickers"]:
        if ticker in by_ticker:
            for n2 in by_ticker[ticker]:
                if n2["stem"] != note["stem"]:
                    old = candidates.get(n2["stem"], ("", 0))
                    candidates[n2["stem"]] = (f"같은 종목 ({ticker})", max(old[1], 0.9))

    # Jaccard similarity — use inverted index to narrow candidates
    if kw_index and note["keywords"]:
        candidate_indices = set()
        for kw in note["keywords"]:
            candidate_indices.update(kw_index.get(kw, set()))
        for idx in candidate_indices:
            n2 = all_notes[idx]
            if n2["stem"] == note["stem"] or n2["stem"] in candidates:
                continue
            sim = jaccard_similarity(note["keywords"], n2["keywords"])
            if sim >= JACCARD_THRESHOLD:
                candidates[n2["stem"]] = ("키워드 유사", sim)
    else:
        # Fallback: brute-force (no index available)
        for n2 in all_notes:
            if n2["stem"] == note["stem"] or n2["stem"] in candidates:
                continue
            sim = jaccard_similarity(note["keywords"], n2["keywords"])
            if sim >= JACCARD_THRESHOLD:
                candidates[n2["stem"]] = ("키워드 유사", sim)

    # Same sector (lower priority)
    if sector and sector in by_sector and len(candidates) < MAX_RELATED_PER_NOTE:
        for n2 in by_sector[sector]:
            if n2["stem"] not in candidates and n2["stem"] != note["stem"]:
                candidates[n2["stem"]] = ("같은 섹터", 0.3)
                if len(candidates) >= MAX_RELATED_PER_NOTE * 2:
                    break

    # Sort by similarity
    result = [(stem, reason, sim) for stem, (reason, sim) in candidates.items()]
    result.sort(key=lambda x: -x[2])
    return result[:MAX_RELATED_PER_NOTE]


# ══════════════════════════════════════════════════════════════════════════════
# Phase 5: MOC Regeneration (MOC 재생성)
# ══════════════════════════════════════════════════════════════════════════════

def phase_moc(notes, state, dry_run, classification):
    """MOC를 계층적 섹션 구조로 재생성."""
    log("=" * 60)
    log("Phase 5: MOC — 구조 노트 재생성")
    log("=" * 60)

    if not classification:
        log("classification.json 없음 — MOC 재생성 스킵", "WARN")
        return {"mocs_updated": 0}

    # Re-scan
    notes = scan_all_notes()

    # Index notes by sector/category → subcategory/ig → industry
    # Notes may have v2 'sector' (S10...) or v3 'category' (기업...) metadata
    index = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for n in notes:
        meta = n["meta"]
        # v3 category takes precedence, fall back to v2 sector
        cat = meta.get("category", "")
        sector = meta.get("sector", "")
        key = cat if (cat and cat != "UNCLASSIFIED") else sector
        sub = meta.get("subcategory", "") or meta.get("industry_group", "")
        ind = meta.get("industry", "")
        if key and key != "UNCLASSIFIED":
            index[key][sub][ind].append(n)

    # v3 uses 'categories', v2 uses 'sectors'
    if _is_v3_classification(classification):
        category_defs = classification.get("categories", {})
    else:
        category_defs = classification.get("sectors", {})

    stats = {"mocs_updated": 0, "llm_calls": 0}

    # Load previous MOC hashes for incremental skip
    moc_hashes = state.get("moc_hashes", {})
    skipped = 0

    for cat_code, cat_def in category_defs.items():
        cat_label = cat_def.get("label", cat_code)
        slug = _safe_slug(cat_label)
        moc_filename = f"MOC-{cat_code}-{slug}.md" if not _is_v3_classification(classification) else f"MOC-{slug}.md"
        moc_path = MOC_DIR / moc_filename

        # Find existing MOC (match both old and new naming)
        existing_mocs = list(MOC_DIR.glob(f"MOC-{slug}*.md"))
        if not existing_mocs and not _is_v3_classification(classification):
            existing_mocs = list(MOC_DIR.glob(f"MOC-{cat_code}-*.md"))
        if existing_mocs:
            moc_path = existing_mocs[0]

        cat_notes = index.get(cat_code, {})
        total_notes = sum(
            len(notes_list)
            for sub_notes in cat_notes.values()
            for notes_list in sub_notes.values()
        )

        if total_notes == 0 and not moc_path.exists():
            continue

        # Compute note list hash for incremental skip
        note_stems = sorted(
            n["stem"]
            for sub_notes in cat_notes.values()
            for notes_list in sub_notes.values()
            for n in notes_list
        )
        current_hash = hashlib.md5(
            "|".join(note_stems).encode()
        ).hexdigest()

        if current_hash == moc_hashes.get(cat_code) and moc_path.exists():
            skipped += 1
            continue

        log(f"  MOC {cat_code} {cat_label}: {total_notes}건 노트")

        if _is_v3_classification(classification):
            moc_content = _generate_moc_v3(
                cat_code, cat_def, cat_notes, total_notes
            )
        else:
            moc_content = _generate_moc(
                cat_code, cat_def, cat_notes, classification, total_notes
            )

        if dry_run:
            log(f"    [DRY] MOC 재생성: {moc_path.name} ({total_notes}건)")
            stats["mocs_updated"] += 1
            moc_hashes[cat_code] = current_hash
            continue

        MOC_DIR.mkdir(parents=True, exist_ok=True)
        tmp = moc_path.with_suffix(".tmp")
        tmp.write_text(moc_content, encoding="utf-8")
        tmp.rename(moc_path)
        stats["mocs_updated"] += 1
        moc_hashes[cat_code] = current_hash

    # Persist hashes to state
    state["moc_hashes"] = moc_hashes

    if skipped:
        log(f"  MOC 변경 없음 — {skipped}개 스킵")
    log(f"Phase 5 완료: MOC {stats['mocs_updated']}개 업데이트, {skipped}개 스킵")
    return stats


def _safe_slug(text):
    """한글/영문 슬러그."""
    clean = re.sub(r"[^\w가-힣·-]", "", text)
    return clean[:30] if clean else "unknown"


def _generate_moc_v3(cat_code, cat_def, cat_notes, total_notes):
    """v3 카테고리 기반 2-level MOC 마크다운 생성."""
    cat_label = cat_def.get("label", cat_code)

    lines = [
        "---",
        f'title: "MOC — {cat_label}"',
        f'tags: ["moc", "category/{cat_code}"]',
        f'zk_type: "structure"',
        f'category: "{cat_code}"',
        f'updated_at: "{datetime.now().strftime("%Y-%m-%d")}"',
        "llm_synthesized: true",
        "---",
        "",
        f"# {cat_label}",
        "",
    ]

    overview = _generate_sector_overview(cat_code, cat_label, total_notes)
    if overview:
        lines.append(f"> {overview}")
        lines.append("")

    # Iterate subcategories
    sub_defs = cat_def.get("subcategories", {})
    for sub_code in sorted(sub_defs.keys()):
        sub_notes_by_ind = cat_notes.get(sub_code, {})
        # Flatten — v3 has no industry level, all notes are in industry=""
        all_sub_notes = []
        for ind_notes in sub_notes_by_ind.values():
            all_sub_notes.extend(ind_notes)

        if not all_sub_notes:
            continue

        lines.append(f"## {sub_code} ({len(all_sub_notes)}건)")
        theme = _generate_ig_theme(sub_code, len(all_sub_notes))
        if theme:
            lines.append(f"> {theme}")
        lines.append("")

        for n in sorted(all_sub_notes, key=lambda x: x["meta"].get("date", ""), reverse=True):
            title = n["meta"].get("title", n["stem"])
            insight = _extract_insight_line(n)
            if insight:
                lines.append(f"- [[{n['stem']}|{title[:60]}]] — {insight}")
            else:
                lines.append(f"- [[{n['stem']}|{title[:60]}]]")

        lines.append("")

    # Uncategorized notes (subcategory="" or not in sub_defs)
    for sub_key, sub_notes_by_ind in cat_notes.items():
        if sub_key in sub_defs:
            continue
        all_uncategorized = []
        for ind_notes in sub_notes_by_ind.values():
            all_uncategorized.extend(ind_notes)
        if all_uncategorized:
            lines.append(f"## 미분류 ({len(all_uncategorized)}건)")
            lines.append("")
            for n in sorted(all_uncategorized, key=lambda x: x["meta"].get("date", ""), reverse=True):
                title = n["meta"].get("title", n["stem"])
                lines.append(f"- [[{n['stem']}|{title[:60]}]]")
            lines.append("")

    return "\n".join(lines) + "\n"


def _generate_moc(s_code, sector_def, sector_notes, classification, total_notes):
    """계층적 MOC 마크다운 생성."""
    sector_label = sector_def.get("label", s_code)
    domain = sector_def.get("domain", "general")

    lines = [
        "---",
        f'title: "MOC — {s_code} {sector_label}"',
        f'tags: ["moc", "sector/{s_code}"]',
        f'zk_type: "structure"',
        f'sector: "{s_code}"',
        f'domain: "{domain}"',
        f'updated_at: "{datetime.now().strftime("%Y-%m-%d")}"',
        "---",
        "",
        f"# {s_code} {sector_label}",
        "",
    ]

    # Sector overview (LLM generated if available)
    overview = _generate_sector_overview(s_code, sector_label, total_notes)
    if overview:
        lines.append(f"> {overview}")
        lines.append("")

    # Iterate industry groups
    ig_defs = sector_def.get("industry_groups", {})
    for ig_code in sorted(ig_defs.keys()):
        ig_def = ig_defs[ig_code]
        ig_label = ig_def.get("label", ig_code)
        ig_notes = sector_notes.get(ig_code, {})

        ig_total = sum(len(v) for v in ig_notes.values())
        lines.append(f"## {ig_code} {ig_label}")

        # Industry group theme summary
        if ig_total > 0:
            theme = _generate_ig_theme(ig_label, ig_total)
            if theme:
                lines.append(f"> {theme}")
            lines.append("")

        # Iterate industries
        i_defs = ig_def.get("industries", {})
        for i_code in sorted(i_defs.keys()):
            i_def = i_defs[i_code]
            i_label = i_def.get("label", i_code)
            i_notes = ig_notes.get(i_code, [])

            if not i_notes:
                continue

            lines.append(f"### {i_code} {i_label} ({len(i_notes)}건)")
            for n in sorted(i_notes, key=lambda x: x["meta"].get("date", ""), reverse=True):
                title = n["meta"].get("title", n["stem"])
                # Extract a one-line insight if possible
                insight = _extract_insight_line(n)
                if insight:
                    lines.append(f"- [[{n['stem']}|{title[:60]}]] — {insight}")
                else:
                    lines.append(f"- [[{n['stem']}|{title[:60]}]]")
            lines.append("")

    # Unclassified notes in this sector (those with sector but no industry)
    unclassified = sector_notes.get("", {}).get("", [])
    if unclassified:
        lines.append("## 미분류")
        for n in unclassified:
            title = n["meta"].get("title", n["stem"])
            lines.append(f"- [[{n['stem']}|{title[:60]}]]")
        lines.append("")

    # Statistics
    classified_count = total_notes - len(unclassified)
    avg_links = 0
    all_sector_notes = []
    for ig_notes in sector_notes.values():
        for i_notes in ig_notes.values():
            all_sector_notes.extend(i_notes)
    if all_sector_notes:
        avg_links = sum(len(n["wikilinks"]) for n in all_sector_notes) / len(all_sector_notes)

    lines.append("---")
    lines.append("## 통계")
    lines.append(f"- 총 노트: {total_notes}건")
    lines.append(f"- 분류율: {classified_count}/{total_notes} "
                 f"({classified_count*100//max(total_notes,1)}%)")
    lines.append(f"- 평균 연결: {avg_links:.1f}개")
    lines.append(f"- 최종 갱신: {datetime.now().strftime('%Y-%m-%d')}")
    lines.append("")

    return "\n".join(lines)


def _generate_sector_overview(s_code, sector_label, total_notes):
    """섹터 개요 생성 (LLM 또는 기본 문구)."""
    if _llm_available is not False and total_notes > 0:
        ok, text = call_llm(
            "지식 분류 전문가. 2-3문장으로 섹터 개요를 작성하세요.",
            f"섹터: {s_code} {sector_label}, 노트 수: {total_notes}건. "
            f"이 섹터의 지식 테마를 2-3문장으로 요약하세요.",
            max_tokens=200,
        )
        if ok:
            return text.strip().replace("\n", " ")

    return f"**{sector_label}** 섹터의 구조 노트입니다. 하위 노트 {total_notes}건."


def _generate_ig_theme(ig_label, count):
    """산업군 테마 요약."""
    return f"{ig_label} 관련 노트 {count}건이 수집되어 있습니다."


def _extract_insight_line(note):
    """노트에서 핵심 인사이트 한 줄 추출."""
    body = note["body"] or ""
    # Skip headers and empty lines
    for line in body.split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("---"):
            continue
        if line.startswith("(registry"):
            continue
        if line.startswith("- [["):
            continue
        # Return first meaningful line
        if len(line) > 10:
            return line[:80]
    return None


# ══════════════════════════════════════════════════════════════════════════════
# Report Generation
# ══════════════════════════════════════════════════════════════════════════════

def generate_report(phase_stats, notes, state):
    """실행 리포트 생성."""
    today = datetime.now().strftime("%Y-%m-%d")
    report_path = REPORT_DIR / f"atomizer-{today}.md"
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    notes = scan_all_notes()

    # Vault health metrics
    total = len(notes)
    inbox_count = sum(1 for n in notes if n["location"] == "inbox")
    notes_count = sum(1 for n in notes if n["location"] == "notes")
    classified = sum(1 for n in notes
                     if n["meta"].get("sector", "UNCLASSIFIED") != "UNCLASSIFIED")
    enriched = sum(1 for n in notes if n["meta"].get("enriched_at"))
    linked = sum(1 for n in notes if n["wikilinks"])
    avg_links = (sum(len(n["wikilinks"]) for n in notes) / max(total, 1))

    by_maturity = defaultdict(int)
    by_zk_type = defaultdict(int)
    by_para = defaultdict(int)
    for n in notes:
        by_maturity[n["meta"].get("maturity", "unknown")] += 1
        by_zk_type[n["meta"].get("zk_type", "unknown")] += 1
        by_para[n["meta"].get("para_bucket", "unknown")] += 1

    lines = [
        "---",
        f"date: {today}",
        "type: report",
        "source: note_atomizer",
        "---",
        "",
        f"# 원자화 파이프라인 리포트 — {today}",
        "",
        "## 실행 요약",
        "",
    ]

    for phase_name, stats in phase_stats.items():
        lines.append(f"### {phase_name}")
        for k, v in stats.items():
            if isinstance(v, dict):
                lines.append(f"- {k}: {json.dumps(v, ensure_ascii=False)}")
            else:
                lines.append(f"- {k}: {v}")
        lines.append("")

    lines.extend([
        "## 볼트 건강 지표",
        "",
        f"| 지표 | 값 |",
        f"|------|-----|",
        f"| 전체 노트 | {total} |",
        f"| 수신함 (110) | {inbox_count} |",
        f"| 노트 (120) | {notes_count} |",
        f"| GICS 분류율 | {classified}/{total} ({classified*100//max(total,1)}%) |",
        f"| 보강된 노트 | {enriched} |",
        f"| 링크 있는 노트 | {linked} ({linked*100//max(total,1)}%) |",
        f"| 평균 링크 수 | {avg_links:.1f} |",
        "",
        "### 성숙도 분포",
        "",
    ])
    for mat, cnt in sorted(by_maturity.items()):
        lines.append(f"- {mat}: {cnt}")

    lines.extend(["", "### ZK 유형 분포", ""])
    for zk, cnt in sorted(by_zk_type.items()):
        lines.append(f"- {zk}: {cnt}")

    lines.extend(["", "### PARA 분포", ""])
    for para, cnt in sorted(by_para.items()):
        lines.append(f"- {para}: {cnt}")

    lines.append("")

    # Errors from log
    errors = [l for l in _LOG_LINES if "[ERROR]" in l]
    if errors:
        lines.extend(["## 에러 목록", ""])
        for e in errors:
            lines.append(f"- {e}")
        lines.append("")

    report_content = "\n".join(lines)
    report_path.write_text(report_content, encoding="utf-8")
    log(f"리포트 생성: {report_path}")
    return report_path


# ══════════════════════════════════════════════════════════════════════════════
# Quick Report (현황만)
# ══════════════════════════════════════════════════════════════════════════════

def quick_report():
    """현황 리포트 출력 (파일 생성 없이 stdout)."""
    notes = scan_all_notes()
    total = len(notes)
    inbox = sum(1 for n in notes if n["location"] == "inbox")
    notes_ct = sum(1 for n in notes if n["location"] == "notes")
    classified = sum(1 for n in notes
                     if n["meta"].get("sector", "UNCLASSIFIED") != "UNCLASSIFIED")
    enriched = sum(1 for n in notes if n["meta"].get("enriched_at"))
    linked = sum(1 for n in notes if n["wikilinks"])
    avg_links = (sum(len(n["wikilinks"]) for n in notes) / max(total, 1))

    by_sector = defaultdict(int)
    for n in notes:
        by_sector[n["meta"].get("sector", "UNCLASSIFIED")] += 1

    print(f"\n{'='*50}")
    print(f"  제텔카스텐 볼트 현황 리포트")
    print(f"{'='*50}")
    print(f"  전체 노트:     {total}")
    print(f"  수신함 (110):  {inbox}")
    print(f"  노트 (120):    {notes_ct}")
    print(f"  GICS 분류율:   {classified}/{total} ({classified*100//max(total,1)}%)")
    print(f"  보강된 노트:   {enriched}")
    print(f"  링크 있는 노트: {linked} ({linked*100//max(total,1)}%)")
    print(f"  평균 링크 수:  {avg_links:.1f}")
    print(f"\n  섹터별 분포:")
    for sector, cnt in sorted(by_sector.items(), key=lambda x: -x[1]):
        print(f"    {sector}: {cnt}")
    print(f"{'='*50}\n")


# ══════════════════════════════════════════════════════════════════════════════
# CLI & Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="제텔카스텐 원자화 파이프라인")
    parser.add_argument("--full", action="store_true", help="전체 5단계 실행")
    parser.add_argument("--enrich", action="store_true", help="Phase 1: 콘텐츠 보강")
    parser.add_argument("--atomize", action="store_true", help="Phase 2: 원자화")
    parser.add_argument("--promote", action="store_true", help="Phase 3: PARA 승격")
    parser.add_argument("--link", action="store_true", help="Phase 4: 크로스링크")
    parser.add_argument("--moc", action="store_true", help="Phase 5: MOC 재생성")
    parser.add_argument("--report", action="store_true", help="현황 리포트")
    parser.add_argument("--batch-size", type=int, default=30, help="배치 크기 (기본 30)")
    parser.add_argument("--dry-run", action="store_true", help="미리보기 (파일 변경 없음)")

    args = parser.parse_args()

    # If no phase selected, show help
    if not any([args.full, args.enrich, args.atomize, args.promote,
                args.link, args.moc, args.report]):
        parser.print_help()
        return

    # Report only mode
    if args.report:
        quick_report()
        return

    log(f"note_atomizer 시작 — dry_run={args.dry_run}, batch_size={args.batch_size}")

    # Load essentials
    classification = load_classification()
    state = load_state()
    gateway_ok = check_gateway()
    log(f"Gateway: {'OK' if gateway_ok else 'UNAVAILABLE'}")
    log(f"Classification: {'loaded' if classification else 'MISSING'}")

    # Scan vault
    notes = scan_all_notes()
    log(f"볼트 스캔 완료: {len(notes)}건 노트")

    phase_stats = {}

    # Phase execution
    phases = []
    if args.full:
        phases = ["enrich", "atomize", "promote", "link", "moc"]
    else:
        if args.enrich:
            phases.append("enrich")
        if args.atomize:
            phases.append("atomize")
        if args.promote:
            phases.append("promote")
        if args.link:
            phases.append("link")
        if args.moc:
            phases.append("moc")

    for phase in phases:
        try:
            if phase == "enrich":
                phase_stats["enrich"] = phase_enrich(
                    notes, state, args.batch_size, args.dry_run, classification
                )
            elif phase == "atomize":
                phase_stats["atomize"] = phase_atomize(
                    notes, state, args.batch_size, args.dry_run, classification
                )
            elif phase == "promote":
                phase_stats["promote"] = phase_promote(
                    notes, state, args.batch_size, args.dry_run, classification
                )
            elif phase == "link":
                phase_stats["link"] = phase_link(
                    notes, state, args.batch_size, args.dry_run, classification
                )
            elif phase == "moc":
                phase_stats["moc"] = phase_moc(
                    notes, state, args.dry_run, classification
                )

            # Re-scan after each phase for fresh data
            if phase != "moc":
                notes = scan_all_notes()

        except Exception as e:
            log(f"Phase '{phase}' 실패: {e}", "ERROR")
            phase_stats[phase] = {"error": str(e)}

    # Save state
    if not args.dry_run:
        save_state(state)
        log("상태 저장 완료")

    # Generate report
    if not args.dry_run:
        report_path = generate_report(phase_stats, notes, state)
        log(f"리포트: {report_path}")

    log("note_atomizer 완료")


if __name__ == "__main__":
    main()
