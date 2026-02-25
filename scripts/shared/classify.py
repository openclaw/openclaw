"""shared/classify.py — Knowledge classification engine (v3 + v2 compat).

v3: 5-category system (기업/시장/산업분석/프로그래밍/인사이트) with folder mapping.
v2: Legacy GICS 3-tier (sector/industry_group/industry) — auto-detected.

All callers should use:
    from shared.classify import classify_by_text, load_classification, ...
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from shared.vault_paths import VAULT, CLASSIFICATION_FILE, VAULT_CATEGORY_DIRS


def get_vault_note_dirs(include_inbox: bool = True,
                        include_legacy: bool = True) -> list[Path]:
    """모든 볼트 노트 디렉토리 반환 (v3 카테고리 + inbox + legacy fallback).

    Args:
        include_inbox: 110 수신함 포함 여부
        include_legacy: 120 노트 (v2 legacy flat dir) 포함 여부 (비어있지 않을 때만)
    """
    dirs: list[Path] = []
    if include_inbox:
        dirs.append(VAULT / "100 지식" / "110 수신함")
    for d in VAULT_CATEGORY_DIRS.values():
        dirs.append(d)
    if include_legacy:
        legacy = VAULT / "100 지식" / "120 노트"
        if legacy.exists():
            try:
                if any(legacy.iterdir()):
                    dirs.append(legacy)
            except OSError:
                pass
    return dirs

# ── v2 fallback ──────────────────────────────────────────────────────────────

_UNCLASSIFIED_V2 = {
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

# ── v3 return structure ──────────────────────────────────────────────────────

_UNCLASSIFIED_V3 = {
    "category": "UNCLASSIFIED",
    "subcategory": "",
    "folder": "",
    "matched_tags": [],
    "confidence": 0.0,
    "runner_up": None,
    "secondary_categories": [],
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


def _korean_boundary_pattern(tag: str) -> re.Pattern:
    """Build boundary-aware regex for Korean/mixed tags.

    - 3+ syllable Korean tags: left-boundary only (compounds OK on right)
    - 1-2 syllable Korean tags: both boundaries (prevent substring false positives)
    """
    syllable_count = sum(1 for c in tag if '\uac00' <= c <= '\ud7a3')
    left = r'(?:^|(?<=[\s\.,;:!?\u00b7/\-()\"\'【「\n]))'
    if syllable_count >= 3:
        return re.compile(left + re.escape(tag), re.IGNORECASE)
    else:
        right = r'(?:$|(?=[\s\.,;:!?\u00b7/\-()\"\'】」\n]))'
        return re.compile(left + re.escape(tag) + right, re.IGNORECASE)


def _make_tag_pattern(tag: str) -> re.Pattern:
    """Select appropriate pattern for tag: ASCII boundary or Korean boundary."""
    if _is_ascii_tag(tag):
        return _ascii_boundary_pattern(tag)
    return _korean_boundary_pattern(tag)


# ── Version detection ────────────────────────────────────────────────────────

def _is_v3(classification: dict) -> bool:
    """Detect v3 classification structure (has 'categories' key)."""
    return "categories" in classification


# ── v3 pattern building ──────────────────────────────────────────────────────

def _build_patterns_v3(classification: dict) -> dict:
    """Pre-compile regex patterns for v3 categories.

    Returns dict keyed by (category, subcategory) with:
      - tag_patterns: list of (tag, compiled_regex)
      - synonym_patterns: list of (synonym_key, canonical_tag, compiled_regex)
      - total_tags: int
    """
    cache_key = id(classification)
    if cache_key in _pattern_cache:
        return _pattern_cache[cache_key]

    patterns = {}
    categories = classification.get("categories", {})

    for cat_name, cat_def in categories.items():
        for subcat_name, subcat_def in cat_def.get("subcategories", {}).items():
            key = (cat_name, subcat_name)
            tag_patterns = []
            for tag in subcat_def.get("tags", []):
                pat = _make_tag_pattern(tag)
                tag_patterns.append((tag, pat))

            synonym_patterns = []
            for syn_key, canonical in subcat_def.get("synonyms", {}).items():
                pat = _make_tag_pattern(syn_key)
                synonym_patterns.append((syn_key, canonical, pat))

            patterns[key] = {
                "tag_patterns": tag_patterns,
                "synonym_patterns": synonym_patterns,
                "total_tags": len(tag_patterns),
            }

    _pattern_cache[cache_key] = patterns
    return patterns


# ── v2 pattern building (legacy) ─────────────────────────────────────────────

def _build_patterns(classification: dict) -> dict:
    """Pre-compile regex patterns and synonym maps for all industries (v2).

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
                    pat = _make_tag_pattern(tag)
                    tag_patterns.append((tag, pat))

                synonym_patterns = []
                for syn_key, canonical in industry.get("synonyms", {}).items():
                    pat = _make_tag_pattern(syn_key)
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


# ══════════════════════════════════════════════════════════════════════════════
# v3 classification
# ══════════════════════════════════════════════════════════════════════════════

# Company-specific names that disambiguate 기업 vs 산업분석
_COMPANY_NAMES = {
    "삼성전자", "SK하이닉스", "TSMC", "NVIDIA", "AMD", "ASML",
    "셀트리온", "삼성바이오로직스", "알테오젠", "HLB",
    "HD현대", "한진중공업", "대한조선", "한화에어로스페이스",
    "현대차", "LG에너지솔루션", "에코프로",
    "메리츠", "미래에셋", "KB", "신한",
    "하이브", "크래프톤", "넥슨", "CJ",
    "바이두", "알리바바", "텐센트",
    "BYD", "CATL",
}


def _classify_v3(text: str, url: str, classification: dict) -> dict:
    """v3 classification: 5-category keyword matching."""
    combined = strip_meta_phrases(f"{text} {url}")
    patterns = _build_patterns_v3(classification)
    categories = classification.get("categories", {})

    # Score all (category, subcategory) pairs
    scored: list[tuple[int, str, str, dict, list[str], int]] = []
    # (score, cat_name, subcat_name, cat_def, matched_tags, total_tags)

    for cat_name, cat_def in categories.items():
        for subcat_name, subcat_def in cat_def.get("subcategories", {}).items():
            key = (cat_name, subcat_name)
            p_info = patterns.get(key, {})
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
                    len(matched), cat_name, subcat_name,
                    cat_def, matched, total_tags,
                ))

    if not scored:
        return dict(_UNCLASSIFIED_V3)

    # Sort by score descending
    scored.sort(key=lambda x: -x[0])

    # Disambiguation: 기업 vs 산업분석
    scored = _disambiguate_company_industry(scored, combined)

    best = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else 0

    cat_def = best[3]
    subcat_def = cat_def.get("subcategories", {}).get(best[2], {})

    confidence = _compute_confidence(
        best[0], best[5], best[0], second_score,
    )

    # Build folder path
    cat_folder = cat_def.get("folder", "")
    subcat_folder = subcat_def.get("folder", best[2])
    folder = f"{cat_folder}/{subcat_folder}" if cat_folder else subcat_folder

    result = {
        "category": best[1],
        "subcategory": best[2],
        "folder": folder,
        "matched_tags": best[4],
        "confidence": confidence,
        "runner_up": None,
        "secondary_categories": [],
    }

    # Runner-up info
    if len(scored) > 1:
        ru = scored[1]
        ru_cat_def = ru[3]
        ru_subcat_def = ru_cat_def.get("subcategories", {}).get(ru[2], {})
        ru_folder = ru_cat_def.get("folder", "") + "/" + ru_subcat_def.get("folder", ru[2])
        result["runner_up"] = {
            "category": ru[1],
            "subcategory": ru[2],
            "folder": ru_folder,
            "score": ru[0],
            "matched_tags": ru[4],
        }

    # Cross-category detection: secondary categories where score >= 50% of best
    best_score = best[0]
    seen_cats = {best[1]}
    for entry in scored[1:]:
        cat = entry[1]
        if cat in seen_cats:
            continue
        if entry[0] >= best_score * 0.5:
            result["secondary_categories"].append({
                "category": cat,
                "subcategory": entry[2],
                "score": entry[0],
            })
            seen_cats.add(cat)

    return result


def _disambiguate_company_industry(scored: list, combined: str) -> list:
    """Resolve 기업 vs 산업분석 ambiguity.

    Rules:
    - If specific company name is present → prefer 기업
    - If no company name → prefer 산업분석
    - 매크로 keywords (금리/FOMC/환율) → prefer 시장
    """
    if len(scored) < 2:
        return scored

    top = scored[0]
    # Only disambiguate when top is 기업 or 산업분석
    if top[1] not in ("기업", "산업분석"):
        return scored

    # Check if company name is in text
    has_company = any(name in combined for name in _COMPANY_NAMES)

    if top[1] == "산업분석" and has_company:
        # Find a 기업 entry and swap if close score
        for i, entry in enumerate(scored[1:], 1):
            if entry[1] == "기업" and entry[0] >= top[0] * 0.5:
                scored[0], scored[i] = scored[i], scored[0]
                break
    elif top[1] == "기업" and not has_company:
        # Find a 산업분석 entry and swap if close score
        for i, entry in enumerate(scored[1:], 1):
            if entry[1] == "산업분석" and entry[0] >= top[0] * 0.5:
                scored[0], scored[i] = scored[i], scored[0]
                break

    return scored


# ══════════════════════════════════════════════════════════════════════════════
# Public API — auto-dispatches v2/v3
# ══════════════════════════════════════════════════════════════════════════════

def classify_by_text(text: str, url: str = "",
                     classification: dict | None = None) -> dict:
    """Keyword-based classification from text + URL.

    Auto-detects v2 (GICS) or v3 (5-category) classification.json.

    v3 returns: category/subcategory/folder/matched_tags/confidence/runner_up
    v2 returns: sector/industry_group/industry/domain/labels/matched_tags/confidence
    """
    if not classification:
        return dict(_UNCLASSIFIED_V3)

    if _is_v3(classification):
        return _classify_v3(text, url, classification)

    # v2 path (legacy)
    return _classify_v2(text, url, classification)


def _classify_v2(text: str, url: str, classification: dict) -> dict:
    """v2 GICS classification (legacy)."""
    combined = strip_meta_phrases(f"{text} {url}")
    sectors = classification.get("sectors", {})
    patterns = _build_patterns(classification)

    # Score all industries
    scored: list[tuple[int, str, str, str, dict, list[str], int]] = []

    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                p_info = patterns.get(i_code, {})
                tag_pats = p_info.get("tag_patterns", [])
                syn_pats = p_info.get("synonym_patterns", [])
                total_tags = p_info.get("total_tags", 0)

                matched: list[str] = []

                for tag, pat in tag_pats:
                    if pat.search(combined):
                        matched.append(tag)

                for syn_key, canonical, pat in syn_pats:
                    if pat.search(combined) and canonical not in matched:
                        matched.append(canonical)

                if matched:
                    scored.append((
                        len(matched), s_code, ig_code, i_code,
                        sector, matched, total_tags,
                    ))

    if not scored:
        return dict(_UNCLASSIFIED_V2)

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

    Works with both v2 and v3 classification.
    """
    if not classification or not text:
        return []

    combined = f"{text} {url}"

    if _is_v3(classification):
        patterns = _build_patterns_v3(classification)
        all_tags: list[str] = []
        for key, p_info in patterns.items():
            for tag, pat in p_info.get("tag_patterns", []):
                if pat.search(combined) and tag not in all_tags:
                    all_tags.append(tag)
            for syn_key, canonical, pat in p_info.get("synonym_patterns", []):
                if pat.search(combined) and canonical not in all_tags:
                    all_tags.append(canonical)
        return all_tags[:max_tags]

    # v2 path
    patterns = _build_patterns(classification)
    all_tags = []
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

    Works with both v2 and v3 classification.
    """
    if not classification or not note_tags:
        return []

    if _is_v3(classification):
        return _classify_by_tags_v3(note_tags, classification)

    # v2 path (legacy)
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


def _classify_by_tags_v3(note_tags: list[str], classification: dict) -> list[dict]:
    """v3 tag-set classification."""
    matches = []
    categories = classification.get("categories", {})
    note_tags_lower = set(t.lower() for t in note_tags)

    for cat_name, cat_def in categories.items():
        for subcat_name, subcat_def in cat_def.get("subcategories", {}).items():
            subcat_tags = set(t.lower() for t in subcat_def.get("tags", []))
            overlap = subcat_tags & note_tags_lower
            if overlap:
                cat_folder = cat_def.get("folder", "")
                subcat_folder = subcat_def.get("folder", subcat_name)
                matches.append({
                    "category": cat_name,
                    "subcategory": subcat_name,
                    "folder": f"{cat_folder}/{subcat_folder}",
                    "overlap": list(overlap),
                    "score": len(overlap),
                })

    return sorted(matches, key=lambda x: -x["score"])


def get_sector_label(classification: dict | None, sector_code: str) -> str:
    """Get human-readable sector label from classification dict (v2 only).

    Returns sector_code as-is if classification is None or code not found.
    """
    if not classification:
        return sector_code
    return classification.get("sectors", {}).get(
        sector_code, {}
    ).get("label", sector_code)


def get_category_label(classification: dict | None, category: str) -> str:
    """Get human-readable category label from v3 classification."""
    if not classification:
        return category
    return classification.get("categories", {}).get(
        category, {}
    ).get("label", category)


def get_folder_path(classification: dict | None,
                    category: str, subcategory: str) -> str:
    """Get folder path for category/subcategory pair from v3 classification."""
    if not classification or not _is_v3(classification):
        return ""
    cat_def = classification.get("categories", {}).get(category, {})
    cat_folder = cat_def.get("folder", "")
    subcat_def = cat_def.get("subcategories", {}).get(subcategory, {})
    subcat_folder = subcat_def.get("folder", subcategory)
    return f"{cat_folder}/{subcat_folder}" if cat_folder else subcat_folder
