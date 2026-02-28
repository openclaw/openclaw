#!/usr/bin/env python3
"""
vault_architect.py — 볼트 v3 자율 구조 개선 파이프라인

5 Phase 자동화:
  Phase 1: 진단 (vault_flow_health 재사용)
  Phase 2: 카테고리 분류 (210 원자노트 → 220/225/230/235)
  Phase 3: 지식 성숙 (200 정리 인플레이스 maturity 업그레이드)
  Phase 4: 고아 연결 (고아 노트 → MOC)
  Phase 5: MOC 통합 (레거시 MOC → 활성 MOC)

Usage:
  python3 vault_architect.py --diagnose          # Phase 1만
  python3 vault_architect.py --categorize        # Phase 2
  python3 vault_architect.py --synthesize        # Phase 3
  python3 vault_architect.py --connect           # Phase 4
  python3 vault_architect.py --consolidate       # Phase 5
  python3 vault_architect.py --full              # 전체 5단계
  python3 vault_architect.py --full --dry-run    # 미리보기
  python3 vault_architect.py --full --notify     # 텔레그램 리포트
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.frontmatter import parse_frontmatter, update_frontmatter, write_note
from shared.classify import classify_by_text, load_classification
from shared.llm import llm_chat_direct, DIRECT_PREMIUM_CHAIN
from shared.log import make_logger
from shared.telegram import send_dm
from shared.vault_paths import (
    VAULT, NOTES, ATOMIC_NOTES, STRUCTURE,
    CAT_COMPANY, CAT_MARKET, CAT_INDUSTRY, CAT_PROG, CAT_INSIGHT,
    VAULT_CATEGORY_DIRS, _V3_MAP,
    OPS, REPORTS, REPORTS_ARCHIVE, PLAYBOOK,
    RESOURCES, RESOURCES_REF, RESOURCES_TOOLKIT, RESOURCES_LEARNING,
)
from pipeline.vault_flow_health import (
    count_stage_notes, detect_bottleneck, detect_orphan_notes,
    check_moc_freshness, detect_misplaced_notes,
)

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
STATE_DIR = WORKSPACE / "memory" / "vault-architect"
STATE_FILE = STATE_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "vault_architect.log"

# 카테고리 → 200 하위 폴더 매핑
CATEGORY_FOLDER_MAP = {
    "기업": CAT_COMPANY,
    "시장": CAT_MARKET,
    "산업분석": CAT_INDUSTRY,
    "프로그래밍": CAT_PROG,
    "인사이트": CAT_INSIGHT,
}

# MOC 디렉토리
MOC_DIR = STRUCTURE  # 300 연결
LEGACY_MOC_DIR = MOC_DIR / "459 MOC 통합" / "159.1 레거시 MOC"

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")

log = make_logger(log_file=LOG_FILE)


# ── 데이터 구조 ──────────────────────────────────────────────────

@dataclass
class PhaseStats:
    categorized: int = 0
    categorized_detail: dict = field(default_factory=dict)
    synthesized: int = 0
    connected: int = 0
    consolidated: int = 0
    nurtured: int = 0
    nurtured_detail: dict = field(default_factory=dict)
    corrected: int = 0
    corrected_detail: dict = field(default_factory=dict)
    ops_cleaned: int = 0
    ops_cleaned_detail: dict = field(default_factory=dict)
    resources_sorted: int = 0
    resources_detail: dict = field(default_factory=dict)


@dataclass
class DiagnosisResult:
    counts: dict
    bottleneck: str | None
    orphan_count: int
    orphan_total: int
    orphan_names: list[str]
    stale_mocs: list[str]
    uncategorized: int
    knowledge_count: int


# ── 상태 관리 ──────────────────────────────────────────────────

def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(STATE_FILE)


def record_action(state: dict, action: str, key: str, details: dict) -> None:
    state.setdefault(action, {})[key] = {**details, "at": datetime.now().isoformat()}
    today = datetime.now().strftime("%Y-%m-%d")
    daily = state.setdefault("daily_stats", {}).setdefault(today, {})
    daily[action] = daily.get(action, 0) + 1


# ── Phase 1: 진단 ──────────────────────────────────────────────

def _count_dir_md(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(1 for f in d.rglob("*.md") if "archives" not in f.parts and ".obsidian" not in f.parts)


def count_uncategorized_notes() -> int:
    if not ATOMIC_NOTES.exists():
        return 0
    return sum(1 for f in ATOMIC_NOTES.glob("*.md"))


def phase_diagnose() -> DiagnosisResult:
    counts = count_stage_notes(_V3_MAP)
    bottleneck = detect_bottleneck(counts, _V3_MAP)
    orphan_count, orphan_total, orphan_names = detect_orphan_notes(VAULT)
    stale_mocs = check_moc_freshness(VAULT)
    uncategorized = count_uncategorized_notes()
    knowledge_count = 0  # 300 제거됨 — 인플레이스 성숙 모델
    return DiagnosisResult(
        counts=counts, bottleneck=bottleneck,
        orphan_count=orphan_count, orphan_total=orphan_total,
        orphan_names=orphan_names, stale_mocs=stale_mocs,
        uncategorized=uncategorized, knowledge_count=knowledge_count,
    )


# ── Phase 2: 카테고리 분류 ─────────────────────────────────────

def _safe_move(src: Path, dest_dir: Path) -> Path | None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    c = 1
    while dest.exists():
        dest = dest_dir / f"{src.stem}_{c}.md"
        c += 1
    try:
        shutil.move(str(src), str(dest))
        return dest
    except OSError as e:
        log(f"이동 실패: {src.name} -> {dest_dir.name}: {e}", level="ERROR")
        return None


def phase_categorize(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    stats = PhaseStats()
    classification = load_classification()

    candidates: list[Path] = []
    if ATOMIC_NOTES.exists():
        candidates.extend(sorted(ATOMIC_NOTES.glob("*.md")))
    if NOTES.exists():
        for f in sorted(NOTES.glob("*.md")):
            if "INDEX" not in f.stem:
                candidates.append(f)

    processed = 0
    for filepath in candidates:
        if processed >= batch_size:
            break

        meta, body = parse_frontmatter(filepath)
        if not body.strip():
            continue
        if meta.get("categorized_by") == "vault_architect":
            continue

        category = meta.get("category", "")

        if not category or category == "UNCLASSIFIED":
            if classification:
                result = classify_by_text(body, meta.get("source_url", ""), classification)
                category = result.get("category", "")
                confidence = result.get("confidence", 0.0)
                if confidence < 0.5:
                    continue
            else:
                continue

        dest_dir = CATEGORY_FOLDER_MAP.get(category)
        if not dest_dir:
            continue

        if dry_run:
            log(f"  [DRY] 분류: {filepath.name} -> {dest_dir.name}")
            stats.categorized += 1
            stats.categorized_detail[dest_dir.name] = stats.categorized_detail.get(dest_dir.name, 0) + 1
            processed += 1
            continue

        meta["category"] = category
        meta["categorized_by"] = "vault_architect"
        meta["categorized_at"] = datetime.now().strftime("%Y-%m-%d")
        write_note(filepath, meta, body)

        moved = _safe_move(filepath, dest_dir)
        if moved:
            log(f"  분류: {filepath.name} -> {dest_dir.name}")
            stats.categorized += 1
            stats.categorized_detail[dest_dir.name] = stats.categorized_detail.get(dest_dir.name, 0) + 1
            record_action(state, "categorized", filepath.stem, {"to": dest_dir.name})
            processed += 1

    return stats


# ── Phase 3: 지식 합성 ──────────────────────────────────────────

def _compute_synthesis_score(meta: dict, body: str) -> int:
    score = 0
    lines = [l for l in body.split("\n") if l.strip()]

    if len(lines) > 5:
        score += 20
    cat = meta.get("category", "")
    if cat and cat != "UNCLASSIFIED":
        score += 15
    tags = meta.get("tags", [])
    if isinstance(tags, list) and len(tags) >= 3:
        score += 15
    wikilinks = re.findall(r"\[\[([^\]|]+)", body)
    if len(wikilinks) >= 2:
        score += 10
    if re.search(r"##\s*관련\s*노트", body):
        score += 10
    source_type = meta.get("source_type", "raw")
    if source_type and source_type != "raw":
        score += 15
    maturity = meta.get("maturity", "")
    if maturity in ("growing", "evergreen"):
        score += 15

    return min(score, 100)


def phase_synthesize(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    """200 정리 노트 인플레이스 maturity 업그레이드. 폴더 이동 없음."""
    stats = PhaseStats()

    scan_dirs = [ATOMIC_NOTES, CAT_COMPANY, CAT_MARKET, CAT_INDUSTRY, CAT_PROG, CAT_INSIGHT]
    candidates: list[Path] = []
    for d in scan_dirs:
        if d.exists():
            candidates.extend(sorted(d.glob("*.md")))

    processed = 0
    for filepath in candidates:
        if processed >= batch_size:
            break

        meta, body = parse_frontmatter(filepath)
        if not body.strip():
            continue
        if meta.get("synthesized_by") == "vault_architect":
            continue
        if meta.get("maturity") == "evergreen":
            continue

        score = _compute_synthesis_score(meta, body)
        if score < 50:
            continue

        if score >= 70:
            promote = True
        else:
            title = meta.get("title", filepath.stem)
            prompt = (
                f"다음 노트가 독립적 지식으로 성숙했는지 판단해주세요.\n"
                f"제목: {title}\n스코어: {score}/100\n"
                f"본문 미리보기:\n{body[:500]}\n\n"
                f"'YES' 또는 'NO'로만 답하세요."
            )
            answer, _, _ = llm_chat_direct(
                [{"role": "user", "content": prompt}],
                DIRECT_PREMIUM_CHAIN, max_tokens=10,
            )
            promote = "YES" in answer.upper() if answer else False

        if not promote:
            continue

        if dry_run:
            log(f"  [DRY] 성숙: {filepath.name} (score={score})")
            stats.synthesized += 1
            processed += 1
            continue

        meta["maturity"] = "evergreen"
        meta["synthesized_at"] = datetime.now().strftime("%Y-%m-%d")
        meta["synthesized_by"] = "vault_architect"
        write_note(filepath, meta, body)
        log(f"  성숙: {filepath.name} (score={score})")
        stats.synthesized += 1
        record_action(state, "synthesized", filepath.stem, {"score": score})
        processed += 1

    return stats


# ── Phase 4: 고아 연결 ──────────────────────────────────────────

def _extract_keywords(meta: dict, body: str) -> set[str]:
    keywords: set[str] = set()
    tags = meta.get("tags", [])
    if isinstance(tags, list):
        keywords.update(t.lower() for t in tags)
    title = meta.get("title", "")
    if title:
        keywords.update(w.lower() for w in re.findall(r'[\w가-힣]+', title) if len(w) >= 2)
    return keywords


def _extract_moc_keywords(moc_path: Path) -> set[str]:
    meta, body = parse_frontmatter(moc_path)
    keywords: set[str] = set()
    tags = meta.get("tags", [])
    if isinstance(tags, list):
        keywords.update(t.lower() for t in tags)
    name = moc_path.stem.replace("MOC-", "").replace("MOC ", "")
    keywords.add(name.lower())
    for link in _WIKILINK_RE.findall(body):
        keywords.update(w.lower() for w in re.findall(r'[\w가-힣]+', link) if len(w) >= 2)
    return keywords


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _append_to_moc(moc_path: Path, note_stem: str) -> bool:
    try:
        text = moc_path.read_text(encoding="utf-8")
    except OSError:
        return False

    if f"[[{note_stem}]]" in text:
        return False

    link = f"- [[{note_stem}]]"
    match = re.search(r"(##\s*관련\s*노트[^\n]*\n)", text)
    if match:
        pos = match.end()
        text = text[:pos] + link + "\n" + text[pos:]
    else:
        text = text.rstrip() + "\n\n## 관련 노트\n" + link + "\n"

    moc_path.write_text(text, encoding="utf-8")
    return True


def phase_connect(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    stats = PhaseStats()

    _, _, orphan_names = detect_orphan_notes(VAULT)
    if not orphan_names:
        return stats

    # MOC 파일 수집
    moc_files: list[Path] = []
    if MOC_DIR.exists():
        for f in MOC_DIR.rglob("*.md"):
            if f.stem.startswith("MOC-") or f.stem.startswith("MOC "):
                if LEGACY_MOC_DIR not in f.parents:
                    moc_files.append(f)
    if not moc_files:
        return stats

    moc_keywords = {moc: _extract_moc_keywords(moc) for moc in moc_files}

    # 고아 노트 파일 인덱스
    orphan_files: dict[str, Path] = {}
    for f in VAULT.rglob("*.md"):
        if f.stem in orphan_names:
            orphan_files[f.stem] = f

    processed = 0
    for name in orphan_names:
        if processed >= batch_size:
            break

        filepath = orphan_files.get(name)
        if not filepath:
            continue

        meta, body = parse_frontmatter(filepath)
        note_kw = _extract_keywords(meta, body)
        if not note_kw:
            continue

        best_moc, best_sim = None, 0.0
        for moc, mkw in moc_keywords.items():
            sim = _jaccard(note_kw, mkw)
            if sim > best_sim:
                best_sim = sim
                best_moc = moc

        if best_sim < 0.15 or not best_moc:
            continue

        if dry_run:
            log(f"  [DRY] 연결: {name} -> {best_moc.stem} (sim={best_sim:.2f})")
            stats.connected += 1
            processed += 1
            continue

        if _append_to_moc(best_moc, name):
            log(f"  연결: {name} -> {best_moc.stem} (sim={best_sim:.2f})")
            stats.connected += 1
            record_action(state, "connected", name,
                          {"moc": best_moc.stem, "similarity": round(best_sim, 3)})
            processed += 1

    return stats


# ── Phase 5: MOC 통합 ──────────────────────────────────────────

def phase_consolidate(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    stats = PhaseStats()

    if not LEGACY_MOC_DIR.exists():
        return stats

    legacy_mocs = list(LEGACY_MOC_DIR.glob("*.md"))
    if not legacy_mocs:
        return stats

    # 활성 MOC 수집 (레거시 폴더 제외)
    active_mocs: dict[str, Path] = {}
    if MOC_DIR.exists():
        for f in MOC_DIR.rglob("*.md"):
            if (f.stem.startswith("MOC-") or f.stem.startswith("MOC ")):
                if LEGACY_MOC_DIR not in f.parents:
                    active_mocs[f.stem.lower()] = f

    if not active_mocs:
        return stats

    processed = 0
    for legacy in legacy_mocs:
        if processed >= batch_size:
            break

        meta, body = parse_frontmatter(legacy)
        if meta.get("consolidated_into"):
            continue

        # 이름 매칭
        target = active_mocs.get(legacy.stem.lower())

        # 키워드 매칭 fallback
        if not target:
            legacy_kw = _extract_moc_keywords(legacy)
            best_match, best_sim = None, 0.0
            for _, active in active_mocs.items():
                sim = _jaccard(legacy_kw, _extract_moc_keywords(active))
                if sim > best_sim:
                    best_sim = sim
                    best_match = active
            if best_sim >= 0.3 and best_match:
                target = best_match
            else:
                continue

        # 레거시 링크 추출
        legacy_links = set(_WIKILINK_RE.findall(body))
        if not legacy_links:
            continue

        try:
            active_text = target.read_text(encoding="utf-8")
        except OSError:
            continue
        existing_links = set(_WIKILINK_RE.findall(active_text))
        new_links = legacy_links - existing_links

        if not new_links:
            continue

        if dry_run:
            log(f"  [DRY] 통합: {legacy.stem} -> {target.stem} ({len(new_links)}개 링크)")
            stats.consolidated += 1
            processed += 1
            continue

        additions = "\n".join(f"- [[{link}]]" for link in sorted(new_links))
        match = re.search(r"(##\s*관련\s*노트[^\n]*\n)", active_text)
        if match:
            pos = match.end()
            active_text = active_text[:pos] + additions + "\n" + active_text[pos:]
        else:
            active_text = active_text.rstrip() + "\n\n## 관련 노트\n" + additions + "\n"
        target.write_text(active_text, encoding="utf-8")

        update_frontmatter(legacy, {
            "consolidated_into": target.stem,
            "consolidated_at": datetime.now().strftime("%Y-%m-%d"),
        })

        log(f"  통합: {legacy.stem} -> {target.stem} ({len(new_links)}개 링크)")
        stats.consolidated += 1
        record_action(state, "consolidated", legacy.stem,
                      {"into": target.stem, "links": len(new_links)})
        processed += 1

    return stats


# ── Phase 6: 보강 (nurture) ──────────────────────────────────────

def phase_nurture(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    """200 정리 노트 프론트매터 제자리 개선. 이동 없음."""
    stats = PhaseStats()
    classification = load_classification()

    scan_dirs = [ATOMIC_NOTES, NOTES, CAT_COMPANY, CAT_MARKET, CAT_INDUSTRY, CAT_PROG, CAT_INSIGHT]
    candidates: list[Path] = []
    for d in scan_dirs:
        if d and d.exists():
            for f in d.rglob("*.md"):
                if "archives" not in f.parts and ".obsidian" not in f.parts:
                    candidates.append(f)

    processed = 0
    for filepath in candidates:
        if processed >= batch_size:
            break

        meta, body = parse_frontmatter(filepath)
        if not body.strip():
            continue
        if meta.get("nurtured_by") == "vault_architect":
            continue

        changes: list[str] = []

        # tags < 3 → 키워드 매칭으로 태그 추가
        tags = meta.get("tags", [])
        if not isinstance(tags, list):
            tags = []
        if len(tags) < 3 and classification:
            result = classify_by_text(body, meta.get("source_url", ""), classification)
            new_tags = result.get("tags", [])
            if isinstance(new_tags, list):
                for t in new_tags:
                    if t not in tags:
                        tags.append(t)
            if len(tags) > len(meta.get("tags", [])):
                meta["tags"] = tags
                changes.append("태그")

        # category 없음/UNCLASSIFIED → 재분류
        cat = meta.get("category", "")
        if (not cat or cat == "UNCLASSIFIED") and classification:
            result = classify_by_text(body, meta.get("source_url", ""), classification)
            new_cat = result.get("category", "")
            conf = result.get("confidence", 0.0)
            if new_cat and new_cat != "UNCLASSIFIED" and conf >= 0.5:
                meta["category"] = new_cat
                changes.append("분류")

        # maturity 미설정 → seedling
        if not meta.get("maturity"):
            meta["maturity"] = "seedling"
            changes.append("성숙도")

        # zk_type 미설정 → fleeting
        if not meta.get("zk_type"):
            meta["zk_type"] = "fleeting"
            changes.append("유형")

        if not changes:
            continue

        if dry_run:
            log(f"  [DRY] 보강: {filepath.name} ({', '.join(changes)})")
            stats.nurtured += 1
            for c in changes:
                stats.nurtured_detail[c] = stats.nurtured_detail.get(c, 0) + 1
            processed += 1
            continue

        meta["nurtured_by"] = "vault_architect"
        meta["nurtured_at"] = datetime.now().strftime("%Y-%m-%d")
        write_note(filepath, meta, body)
        log(f"  보강: {filepath.name} ({', '.join(changes)})")
        stats.nurtured += 1
        for c in changes:
            stats.nurtured_detail[c] = stats.nurtured_detail.get(c, 0) + 1
        record_action(state, "nurtured", filepath.stem, {"changes": changes})
        processed += 1

    return stats


# ── Phase 7: 교차 교정 (correct) ────────────────────────────────

def phase_correct(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    """잘못 분류된 노트 감지 + 이동. 보수적 기준."""
    stats = PhaseStats()

    misplaced = detect_misplaced_notes(VAULT, limit=batch_size)
    if not misplaced:
        return stats

    # stem → Path 인덱스 (대상 노트만)
    target_stems = {m["note"] for m in misplaced}
    stem_to_path: dict[str, Path] = {}
    for f in VAULT.rglob("*.md"):
        if f.stem in target_stems:
            stem_to_path[f.stem] = f

    # 이동 대상 디렉토리 매핑
    suggestion_dirs = {
        "200": NOTES,
    }

    processed = 0
    for m in misplaced:
        if processed >= batch_size:
            break

        filepath = stem_to_path.get(m["note"])
        if not filepath or not filepath.exists():
            continue

        dest_dir = suggestion_dirs.get(m["suggested"])
        if not dest_dir:
            continue

        key = f"{m['current']}→{m['suggested']}"

        if dry_run:
            log(f"  [DRY] 교정: {m['note']} {key} ({m['reason']})")
            stats.corrected += 1
            stats.corrected_detail[key] = stats.corrected_detail.get(key, 0) + 1
            processed += 1
            continue

        meta, body = parse_frontmatter(filepath)
        meta["corrected_by"] = "vault_architect"
        meta["corrected_from"] = m["current"]
        meta["corrected_reason"] = m["reason"]
        meta["corrected_at"] = datetime.now().strftime("%Y-%m-%d")
        write_note(filepath, meta, body)

        moved = _safe_move(filepath, dest_dir)
        if moved:
            log(f"  교정: {m['note']} {key} ({m['reason']})")
            stats.corrected += 1
            stats.corrected_detail[key] = stats.corrected_detail.get(key, 0) + 1
            record_action(state, "corrected", m["note"], {
                "from": m["current"], "to": m["suggested"], "reason": m["reason"],
            })
            processed += 1

    return stats


# ── Phase 8: 운영 정리 (ops-cleanup) ────────────────────────────

def phase_ops_cleanup(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    """800 운영 리포트 적체 해소. 삭제 없음, 아카이브 이동만."""
    stats = PhaseStats()
    now = time.time()

    # 840 리포트 90일+ → 841 아카이브 이동
    if REPORTS.exists():
        cutoff_90d = now - 90 * 86400
        processed = 0
        for f in sorted(REPORTS.glob("*.md")):
            if processed >= batch_size:
                break
            try:
                if f.stat().st_mtime < cutoff_90d:
                    if dry_run:
                        log(f"  [DRY] 아카이브: {f.name}")
                        stats.ops_cleaned += 1
                        stats.ops_cleaned_detail["아카이브"] = stats.ops_cleaned_detail.get("아카이브", 0) + 1
                        processed += 1
                        continue

                    meta, body = parse_frontmatter(f)
                    meta["archived_by"] = "vault_architect"
                    meta["archived_at"] = datetime.now().strftime("%Y-%m-%d")
                    write_note(f, meta, body)
                    moved = _safe_move(f, REPORTS_ARCHIVE)
                    if moved:
                        log(f"  아카이브: {f.name}")
                        stats.ops_cleaned += 1
                        stats.ops_cleaned_detail["아카이브"] = stats.ops_cleaned_detail.get("아카이브", 0) + 1
                        record_action(state, "archived", f.stem, {"to": "841 아카이브"})
                        processed += 1
            except OSError:
                continue

    # 820 플레이북 60일+ 미갱신 → needs_review 표시
    if PLAYBOOK.exists():
        cutoff_60d = now - 60 * 86400
        for f in sorted(PLAYBOOK.rglob("*.md")):
            if "archives" in f.parts:
                continue
            try:
                if f.stat().st_mtime < cutoff_60d:
                    meta, body = parse_frontmatter(f)
                    if meta.get("needs_review"):
                        continue

                    if dry_run:
                        log(f"  [DRY] 리뷰표시: {f.name}")
                        stats.ops_cleaned += 1
                        stats.ops_cleaned_detail["리뷰표시"] = stats.ops_cleaned_detail.get("리뷰표시", 0) + 1
                        continue

                    meta["needs_review"] = True
                    meta["review_flagged_at"] = datetime.now().strftime("%Y-%m-%d")
                    write_note(f, meta, body)
                    log(f"  리뷰표시: {f.name}")
                    stats.ops_cleaned += 1
                    stats.ops_cleaned_detail["리뷰표시"] = stats.ops_cleaned_detail.get("리뷰표시", 0) + 1
                    record_action(state, "review_flagged", f.stem, {})
            except OSError:
                continue

    return stats


# ── Phase 9: 리소스 정리 (resources) ────────────────────────────

RESOURCE_CATEGORY_MAP = {
    "참조": RESOURCES_REF,
    "도구": RESOURCES_TOOLKIT,
    "학습": RESOURCES_LEARNING,
}

# 리소스 분류용 간단 키워드 매핑
_RESOURCE_KEYWORDS = {
    "참조": ["API", "문서", "doc", "reference", "논문", "paper", "레포트", "report", "북마크", "bookmark"],
    "도구": ["템플릿", "template", "체크리스트", "checklist", "스니펫", "snippet", "도구", "tool"],
    "학습": ["강의", "lecture", "튜토리얼", "tutorial", "책", "book", "학습", "course", "노트"],
}


def _classify_resource(meta: dict, body: str) -> str | None:
    """리소스를 609 내에서 610/620/630으로 분류. 키워드 매칭."""
    text = (meta.get("title", "") + " " + body[:500]).lower()
    best_cat = None
    best_score = 0
    for cat, keywords in _RESOURCE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw.lower() in text)
        if score > best_score:
            best_score = score
            best_cat = cat
    return best_cat if best_score >= 1 else None


def phase_resources(batch_size: int, dry_run: bool, state: dict) -> PhaseStats:
    """600 리소스 미분류 항목 정리."""
    stats = PhaseStats()

    uncategorized_dir = RESOURCES / "609 비넘버 통합"
    if not uncategorized_dir.exists():
        return stats

    processed = 0
    for f in sorted(uncategorized_dir.glob("*.md")):
        if processed >= batch_size:
            break

        meta, body = parse_frontmatter(f)
        if not body.strip():
            continue

        cat = _classify_resource(meta, body)
        if not cat:
            continue

        dest_dir = RESOURCE_CATEGORY_MAP.get(cat)
        if not dest_dir:
            continue

        key = f"609→{dest_dir.name}"

        if dry_run:
            log(f"  [DRY] 리소스분류: {f.name} → {dest_dir.name}")
            stats.resources_sorted += 1
            stats.resources_detail[key] = stats.resources_detail.get(key, 0) + 1
            processed += 1
            continue

        meta["resource_category"] = cat
        meta["categorized_by"] = "vault_architect"
        meta["categorized_at"] = datetime.now().strftime("%Y-%m-%d")
        write_note(f, meta, body)

        moved = _safe_move(f, dest_dir)
        if moved:
            log(f"  리소스분류: {f.name} → {dest_dir.name}")
            stats.resources_sorted += 1
            stats.resources_detail[key] = stats.resources_detail.get(key, 0) + 1
            record_action(state, "resource_sorted", f.stem, {"to": dest_dir.name})
            processed += 1

    return stats


# ── 텔레그램 ────────────────────────────────────────────────────

def format_report(diag: DiagnosisResult, stats: PhaseStats) -> str:
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"\U0001f3d7 <b>볼트 아키텍트</b> | {today}", ""]

    lines.append("<b>진단:</b>")
    stage_nums = {"캡처": "100", "정리": "200", "연결": "400", "판단": "500"}
    for stage in ["캡처", "정리", "연결", "판단"]:
        cnt = diag.counts.get(stage, 0)
        lines.append(f"  {stage_nums[stage]} {stage}: {cnt}")

    if diag.orphan_total > 0:
        ratio = diag.orphan_count / diag.orphan_total
        lines.append(f"  고아: {diag.orphan_count}/{diag.orphan_total} ({ratio:.1%})")
    if diag.stale_mocs:
        lines.append(f"  MOC 갱신 필요: {len(diag.stale_mocs)}개")
    if diag.uncategorized > 0:
        lines.append(f"  미분류 원자노트: {diag.uncategorized}건")

    any_action = (stats.categorized + stats.synthesized
                  + stats.connected + stats.consolidated
                  + stats.nurtured + stats.corrected
                  + stats.ops_cleaned + stats.resources_sorted) > 0
    if any_action:
        lines.append("")
        lines.append("<b>개선:</b>")
        if stats.categorized > 0:
            detail = ", ".join(f"->{k}:{v}" for k, v in stats.categorized_detail.items())
            lines.append(f"  v 분류: {stats.categorized}건 ({detail})")
        if stats.synthesized > 0:
            lines.append(f"  v 성숙: {stats.synthesized}건 (evergreen)")
        if stats.connected > 0:
            lines.append(f"  v 연결: {stats.connected}건 (->MOC)")
        if stats.consolidated > 0:
            lines.append(f"  v 통합: {stats.consolidated}건")
        if stats.nurtured > 0:
            detail = ", ".join(f"{k}:{v}" for k, v in stats.nurtured_detail.items())
            lines.append(f"  v 보강: {stats.nurtured}건 ({detail})")
        if stats.corrected > 0:
            detail = ", ".join(f"{k}:{v}" for k, v in stats.corrected_detail.items())
            lines.append(f"  v 교정: {stats.corrected}건 ({detail})")
        if stats.ops_cleaned > 0:
            detail = ", ".join(f"{k}:{v}" for k, v in stats.ops_cleaned_detail.items())
            lines.append(f"  v 운영정리: {stats.ops_cleaned}건 ({detail})")
        if stats.resources_sorted > 0:
            detail = ", ".join(f"{k}:{v}" for k, v in stats.resources_detail.items())
            lines.append(f"  v 리소스: {stats.resources_sorted}건 ({detail})")

    return "\n".join(lines)


# ── 메인 ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="볼트 v3 자율 구조 개선")
    parser.add_argument("--diagnose", action="store_true", help="Phase 1: 진단")
    parser.add_argument("--categorize", action="store_true", help="Phase 2: 카테고리 분류")
    parser.add_argument("--synthesize", action="store_true", help="Phase 3: 지식 합성")
    parser.add_argument("--connect", action="store_true", help="Phase 4: 고아 연결")
    parser.add_argument("--consolidate", action="store_true", help="Phase 5: MOC 통합")
    parser.add_argument("--nurture", action="store_true", help="Phase 6: 보강")
    parser.add_argument("--correct", action="store_true", help="Phase 7: 교차 교정")
    parser.add_argument("--ops-cleanup", action="store_true", help="Phase 8: 운영 정리")
    parser.add_argument("--resources", action="store_true", help="Phase 9: 리소스 정리")
    parser.add_argument("--full", action="store_true", help="전체 9단계")
    parser.add_argument("--batch-size", type=int, default=20, help="하루 처리량 제한")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    parser.add_argument("--notify", action="store_true", help="텔레그램 리포트")
    args = parser.parse_args()

    all_flags = [
        args.diagnose, args.categorize, args.synthesize,
        args.connect, args.consolidate, args.nurture,
        args.correct, args.ops_cleanup, args.resources, args.full,
    ]
    if not any(all_flags):
        args.diagnose = True

    state = load_state()
    state["last_run"] = datetime.now().isoformat()

    run_diagnose = args.diagnose or args.full
    run_categorize = args.categorize or args.full
    run_synthesize = args.synthesize or args.full
    run_connect = args.connect or args.full
    run_consolidate = args.consolidate or args.full
    run_nurture = args.nurture or args.full
    run_correct = args.correct or args.full
    run_ops_cleanup = args.ops_cleanup or args.full
    run_resources = args.resources or args.full

    stats = PhaseStats()

    # Phase 1
    if run_diagnose:
        log("Phase 1: 진단")
        diag = phase_diagnose()
        log(f"  단계별: {diag.counts}")
        log(f"  성숙 모델: 인플레이스 (300 제거됨)")
        log(f"  고아: {diag.orphan_count}/{diag.orphan_total}")
        log(f"  MOC 갱신 필요: {len(diag.stale_mocs)}개")
        log(f"  미분류 원자노트: {diag.uncategorized}건")

    # Phase 2
    if run_categorize:
        log("Phase 2: 카테고리 분류")
        cat_stats = phase_categorize(args.batch_size, args.dry_run, state)
        stats.categorized = cat_stats.categorized
        stats.categorized_detail = cat_stats.categorized_detail
        log(f"  분류 완료: {stats.categorized}건")

    # Phase 3
    if run_synthesize:
        log("Phase 3: 지식 합성")
        syn_stats = phase_synthesize(args.batch_size, args.dry_run, state)
        stats.synthesized = syn_stats.synthesized
        log(f"  승격 완료: {stats.synthesized}건")

    # Phase 4
    if run_connect:
        log("Phase 4: 고아 연결")
        con_stats = phase_connect(args.batch_size, args.dry_run, state)
        stats.connected = con_stats.connected
        log(f"  연결 완료: {stats.connected}건")

    # Phase 5
    if run_consolidate:
        log("Phase 5: MOC 통합")
        csl_stats = phase_consolidate(args.batch_size, args.dry_run, state)
        stats.consolidated = csl_stats.consolidated
        log(f"  통합 완료: {stats.consolidated}건")

    # Phase 6
    if run_nurture:
        log("Phase 6: 보강")
        nur_stats = phase_nurture(args.batch_size, args.dry_run, state)
        stats.nurtured = nur_stats.nurtured
        stats.nurtured_detail = nur_stats.nurtured_detail
        log(f"  보강 완료: {stats.nurtured}건")

    # Phase 7
    if run_correct:
        log("Phase 7: 교차 교정")
        cor_stats = phase_correct(args.batch_size, args.dry_run, state)
        stats.corrected = cor_stats.corrected
        stats.corrected_detail = cor_stats.corrected_detail
        log(f"  교정 완료: {stats.corrected}건")

    # Phase 8
    if run_ops_cleanup:
        log("Phase 8: 운영 정리")
        ops_stats = phase_ops_cleanup(args.batch_size, args.dry_run, state)
        stats.ops_cleaned = ops_stats.ops_cleaned
        stats.ops_cleaned_detail = ops_stats.ops_cleaned_detail
        log(f"  운영정리 완료: {stats.ops_cleaned}건")

    # Phase 9
    if run_resources:
        log("Phase 9: 리소스 정리")
        res_stats = phase_resources(args.batch_size, args.dry_run, state)
        stats.resources_sorted = res_stats.resources_sorted
        stats.resources_detail = res_stats.resources_detail
        log(f"  리소스정리 완료: {stats.resources_sorted}건")

    if not args.dry_run:
        save_state(state)

    # 리포트 (진단 결과 필요 — 아직 없으면 실행)
    if not run_diagnose:
        diag = phase_diagnose()

    report = format_report(diag, stats)
    print(report.replace("<b>", "").replace("</b>", ""))

    if args.notify and not args.dry_run:
        if send_dm(report):
            log("Telegram 리포트 전송 완료")
        else:
            log("Telegram 전송 실패", level="ERROR")


if __name__ == "__main__":
    main()
