"""shared/classify.py — GICS 3-tier classification engine (v2).

Consolidates classification logic from:
  - ingest_topic_media.py (classify_by_text, load_classification, extract_keyword_tags)
  - pipeline/note_atomizer.py (classify_by_text, load_classification, get_sector_label)
  - pipeline/vault_reeval.py (classify_by_tags, load_classification)
  - batch_classify_registry.py (imports from ingest_topic_media)

v2 enhancements:
  - Word-boundary matching for English tags (regex \\b)
  - Synonym expansion from classification.json
  - Confidence scoring (tag_coverage × 0.6 + uniqueness × 0.3 + depth × 0.1)
  - Runner-up return for review
  - Compiled regex pattern cache

All callers should use:
    from shared.classify import classify_by_text, load_classification, ...
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

CLASSIFICATION_FILE = Path(os.path.expanduser(
    "~/knowledge/900 시스템/classification.json"
))

_UNCLASSIFIED = {
    "sector": "UNCLASSIFIED",
    "industry_group": "",
    "industry": "",
    "domain": "general",
    "sector_label": "",
    "matched_tags": [],
    "confidence": 0.0,
    "runner_up": None,
    "secondary_sectors": [],
}

# Pattern cache: keyed by id(classification) → compiled patterns
_pattern_cache: dict[int, dict] = {}

# Regex: all-ASCII check (for word-boundary matching decision)
_ASCII_RE = re.compile(r'^[A-Za-z0-9_\-./]+$')

# Meta-phrases injected by note_atomizer LLM synthesis — cause false tag matches
_META_PHRASE_PATTERNS = [
    re.compile(r'\*{0,2}\(추정\)\s*LLM\s*합성\s*콘텐츠\*{0,2}'),  # **(추정) LLM 합성 콘텐츠**
    re.compile(r'^-\s*(제목|태그|섹터|요약)\s*:.*$', re.MULTILINE),  # - 제목: ... metadata lines
    re.compile(r'^##\s*(출처|관련\s*노트|분할된\s*노트)\s*\n(?:.*\n)*?(?=^##|\Z)',
               re.MULTILINE),  # ## 출처/관련 노트 sections
    re.compile(r'\[\[.*?\]\]'),  # [[wikilinks]] — internal note refs
    re.compile(r'\(원본\s*노트\)'),  # (원본 노트)
    re.compile(r'같은\s*산업'),  # — 같은 산업 (link annotations)
]


def _is_ascii_tag(tag: str) -> bool:
    """Check if tag is purely ASCII (English/technical) for word-boundary matching."""
    return bool(_ASCII_RE.match(tag))


def _ascii_boundary_pattern(tag: str) -> re.Pattern:
    """Build word-boundary regex for ASCII tags.

    Uses ASCII-only boundaries (?<![A-Za-z0-9])...(?![A-Za-z0-9])
    so Korean characters adjacent to ASCII tags don't break matching.
    e.g. "GPU와" matches "GPU", but "plAIn" doesn't match "AI".
    """
    return re.compile(
        r'(?<![A-Za-z0-9])' + re.escape(tag) + r'(?![A-Za-z0-9])',
        re.IGNORECASE,
    )


def _build_patterns(classification: dict) -> dict:
    """Pre-compile regex patterns and synonym maps for all industries.

    Returns a dict keyed by industry code with:
      - tag_patterns: list of (tag, compiled_regex)
      - synonym_patterns: list of (synonym_key, canonical_tag, compiled_regex)
      - total_tags: int (number of tags + synonyms for coverage calc)
    """
    cache_key = id(classification)
    if cache_key in _pattern_cache:
        return _pattern_cache[cache_key]

    patterns = {}
    sectors = classification.get("sectors", {})

    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                tag_patterns = []
                for tag in industry.get("tags", []):
                    if _is_ascii_tag(tag):
                        pat = _ascii_boundary_pattern(tag)
                    else:
                        pat = re.compile(re.escape(tag), re.IGNORECASE)
                    tag_patterns.append((tag, pat))

                synonym_patterns = []
                for syn_key, canonical in industry.get("synonyms", {}).items():
                    if _is_ascii_tag(syn_key):
                        pat = _ascii_boundary_pattern(syn_key)
                    else:
                        pat = re.compile(re.escape(syn_key), re.IGNORECASE)
                    synonym_patterns.append((syn_key, canonical, pat))

                patterns[i_code] = {
                    "tag_patterns": tag_patterns,
                    "synonym_patterns": synonym_patterns,
                    "total_tags": len(tag_patterns),
                }

    _pattern_cache[cache_key] = patterns
    return patterns


def _compute_confidence(matched_count: int, total_tags: int,
                        best_score: int, second_score: int) -> float:
    """Compute classification confidence score.

    Formula: depth × 0.4 + uniqueness × 0.4 + tag_coverage × 0.2
      - depth = min(matched / 3, 1.0) (absolute match depth, caps at 3)
      - uniqueness = 1.0 if gap >= 2, else 0.5 (how distinct from runner-up)
      - tag_coverage = matched / total (minor bonus for high coverage)

    Design: depth + uniqueness are primary drivers (80% weight).
    Adding more tags to an industry should not penalize notes that
    match fewer of them — only the absolute match count matters.
    """
    if total_tags == 0 or matched_count == 0:
        return 0.0

    depth = min(matched_count / 3.0, 1.0)
    gap = best_score - second_score
    uniqueness = 1.0 if gap >= 2 else 0.5
    tag_coverage = min(matched_count / total_tags, 1.0)

    return round(depth * 0.4 + uniqueness * 0.4 + tag_coverage * 0.2, 3)


def load_classification(path: str | Path | None = None) -> dict | None:
    """Load classification.json from disk.

    Args:
        path: Override path (default: ~/knowledge/900 시스템/classification.json).

    Returns:
        Parsed dict or None on error.
    """
    p = Path(path) if path else CLASSIFICATION_FILE
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def strip_meta_phrases(text: str) -> str:
    """Remove system-generated meta phrases that cause false classification.

    Strips LLM synthesis headers, metadata lines, wikilinks, and
    auto-generated section annotations injected by note_atomizer.
    """
    result = text
    for pat in _META_PHRASE_PATTERNS:
        result = pat.sub('', result)
    return result


def classify_by_text(text: str, url: str = "",
                     classification: dict | None = None) -> dict:
    """Keyword-based GICS classification from text + URL.

    Uses word-boundary regex for English tags, substring for Korean.
    Expands synonyms from classification.json.
    Returns confidence score and runner-up for review.

    Returns:
        dict with sector/industry_group/industry/domain/labels/matched_tags/
        confidence/runner_up, or UNCLASSIFIED fallback.
    """
    if not classification:
        return dict(_UNCLASSIFIED)

    combined = strip_meta_phrases(f"{text} {url}")
    sectors = classification.get("sectors", {})
    patterns = _build_patterns(classification)

    # Score all industries
    scored: list[tuple[int, str, str, str, dict, list[str], int]] = []
    # (score, s_code, ig_code, i_code, sector_dict, matched_tags, total_tags)

    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                p_info = patterns.get(i_code, {})
                tag_pats = p_info.get("tag_patterns", [])
                syn_pats = p_info.get("synonym_patterns", [])
                total_tags = p_info.get("total_tags", 0)

                matched: list[str] = []

                # Direct tag matching
                for tag, pat in tag_pats:
                    if pat.search(combined):
                        matched.append(tag)

                # Synonym matching → count canonical tag
                for syn_key, canonical, pat in syn_pats:
                    if pat.search(combined) and canonical not in matched:
                        matched.append(canonical)

                if matched:
                    scored.append((
                        len(matched), s_code, ig_code, i_code,
                        sector, matched, total_tags,
                    ))

    if not scored:
        return dict(_UNCLASSIFIED)

    # Sort by score descending
    scored.sort(key=lambda x: -x[0])

    best = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else 0

    sector = best[4]
    ig = sector.get("industry_groups", {}).get(best[2], {})
    industry = ig.get("industries", {}).get(best[3], {})

    confidence = _compute_confidence(
        best[0], best[6], best[0], second_score,
    )

    result = {
        "sector": best[1],
        "sector_label": sector["label"],
        "industry_group": best[2],
        "ig_label": ig.get("label", ""),
        "industry": best[3],
        "i_label": industry.get("label", ""),
        "domain": sector.get("domain", "general"),
        "matched_tags": best[5],
        "confidence": confidence,
        "runner_up": None,
        "secondary_sectors": [],
    }

    # Runner-up info
    if len(scored) > 1:
        ru = scored[1]
        ru_sector = ru[4]
        ru_ig = ru_sector.get("industry_groups", {}).get(ru[2], {})
        ru_industry = ru_ig.get("industries", {}).get(ru[3], {})
        result["runner_up"] = {
            "sector": ru[1],
            "sector_label": ru_sector["label"],
            "industry": ru[3],
            "i_label": ru_industry.get("label", ""),
            "score": ru[0],
            "matched_tags": ru[5],
        }

    # Cross-sector detection: secondary sectors where score >= 50% of best
    best_score = best[0]
    seen_sectors = {best[1]}
    for entry in scored[1:]:
        s_code = entry[1]
        if s_code in seen_sectors:
            continue
        if entry[0] >= best_score * 0.5:
            entry_sector = entry[4]
            result["secondary_sectors"].append({
                "sector": s_code,
                "sector_label": entry_sector["label"],
                "score": entry[0],
            })
            seen_sectors.add(s_code)

    return result


def extract_keyword_tags(text: str, url: str = "",
                         classification: dict | None = None,
                         max_tags: int = 5) -> list[str]:
    """Extract industry keyword tags matching the given text.

    Uses word-boundary regex for English, substring for Korean.
    Includes synonym-expanded matches.

    Returns:
        list of matched tag strings (up to max_tags).
    """
    if not classification or not text:
        return []

    combined = f"{text} {url}"
    patterns = _build_patterns(classification)
    all_tags: list[str] = []

    for i_code, p_info in patterns.items():
        for tag, pat in p_info.get("tag_patterns", []):
            if pat.search(combined) and tag not in all_tags:
                all_tags.append(tag)
        for syn_key, canonical, pat in p_info.get("synonym_patterns", []):
            if pat.search(combined) and canonical not in all_tags:
                all_tags.append(canonical)

    return all_tags[:max_tags]


def classify_by_tags(note_tags: list[str],
                     classification: dict | None = None) -> list[dict]:
    """Tag-set based classification matching.

    Compares note tags against industry tags using set intersection.
    Returns all matches sorted by overlap score (descending).

    Returns:
        list of dicts with sector/industry_group/industry/overlap/score.
    """
    if not classification or not note_tags:
        return []

    matches = []
    sectors = classification.get("sectors", {})

    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                industry_tags = set(t.lower() for t in industry.get("tags", []))
                note_tags_lower = set(t.lower() for t in note_tags)
                overlap = industry_tags & note_tags_lower
                if overlap:
                    matches.append({
                        "sector": s_code,
                        "sector_label": sector["label"],
                        "industry_group": ig_code,
                        "ig_label": ig["label"],
                        "industry": i_code,
                        "i_label": industry["label"],
                        "overlap": list(overlap),
                        "score": len(overlap),
                    })

    return sorted(matches, key=lambda x: -x["score"])


def get_sector_label(classification: dict | None, sector_code: str) -> str:
    """Get human-readable sector label from classification dict.

    Returns sector_code as-is if classification is None or code not found.
    """
    if not classification:
        return sector_code
    return classification.get("sectors", {}).get(
        sector_code, {}
    ).get("label", sector_code)
