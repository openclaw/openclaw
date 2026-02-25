#!/usr/bin/env python3
"""
knowledge_connector.py — 발견(discovery)을 기존 ZK 노트 및 볼트와 매칭

필터된 발견과 기존 제텔카스텐 노트 사이의 연결고리를 찾아서:
1. 기존 노트의 관련성 매칭 (키워드 겹침)
2. 연결이 없는 고립 노트 탐지
3. 수신함(110) → 노트(120) 승격 후보 식별

Usage:
  python3 knowledge_connector.py                # 기본 연결 분석
  python3 knowledge_connector.py --promote      # 승격 후보를 실제로 이동
  python3 knowledge_connector.py --dry-run      # 미리보기

Cron: 매일 02:40 (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

from shared.vault_paths import VAULT, INBOX

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
INBOX_DIR = INBOX
NOTES_DIR = VAULT / "100 지식" / "120 노트"  # v2 legacy
STRUCT_DIR = VAULT / "100 지식" / "150 구조노트"
FILTERED_DIR = WORKSPACE / "memory" / "filtered-ideas"
REPORT_DIR = WORKSPACE / "memory" / "knowledge-connections"


from shared.log import make_logger
from shared.classify import get_vault_note_dirs
log = make_logger()


def extract_keywords(text):
    """텍스트에서 의미있는 키워드 추출 (간단한 휴리스틱)."""
    if not text:
        return set()
    # 한국어 2자 이상 단어 + 영어 3자 이상 단어
    korean = set(re.findall(r"[가-힣]{2,}", text))
    english = set(w.lower() for w in re.findall(r"[a-zA-Z]{3,}", text))
    # 불용어 제거
    stopwords = {"the", "and", "for", "from", "with", "this", "that", "are", "was",
                 "have", "has", "been", "will", "can", "not", "but", "all", "you",
                 "하는", "있는", "것을", "것이", "위해", "대한", "통해", "않는"}
    return (korean | english) - stopwords


def read_note_metadata(filepath):
    """마크다운 노트에서 frontmatter + 본문 키워드 추출."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except Exception:
        return None

    meta = {"path": str(filepath), "filename": filepath.name}

    # frontmatter 파싱
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    meta[key.strip()] = val.strip().strip('"').strip("'")
            meta["body"] = parts[2].strip()
        else:
            meta["body"] = content
    else:
        meta["body"] = content

    meta["keywords"] = extract_keywords(meta.get("body", "") + " " + meta.get("title", ""))
    return meta


def compute_similarity(kw_a, kw_b):
    """두 키워드 집합의 자카드 유사도."""
    if not kw_a or not kw_b:
        return 0.0
    intersection = kw_a & kw_b
    union = kw_a | kw_b
    return len(intersection) / len(union) if union else 0.0


def scan_vault():
    """볼트 전체 노트 스캔 (v3 카테고리 디렉토리 + inbox + legacy)."""
    notes = []
    for search_dir in get_vault_note_dirs():
        if not search_dir.exists():
            continue
        for md_file in search_dir.glob("*.md"):
            meta = read_note_metadata(md_file)
            if meta:
                meta["location"] = "inbox" if "110" in str(search_dir) else "notes"
                notes.append(meta)
    return notes


def find_connections(notes, filtered_items):
    """노트 간 연결 + 필터 아이템과의 연결 탐색."""
    connections = []

    # 노트 간 연결
    for i, a in enumerate(notes):
        for j, b in enumerate(notes):
            if i >= j:
                continue
            sim = compute_similarity(a["keywords"], b["keywords"])
            if sim >= 0.15:
                connections.append({
                    "type": "note-note",
                    "a": a["filename"],
                    "b": b["filename"],
                    "similarity": round(sim, 3),
                    "shared": sorted(list(a["keywords"] & b["keywords"]))[:10],
                })

    # 필터 아이템 ↔ 노트 연결
    for item in filtered_items:
        item_kw = extract_keywords(item.get("text", ""))
        for note in notes:
            sim = compute_similarity(item_kw, note["keywords"])
            if sim >= 0.1:
                connections.append({
                    "type": "discovery-note",
                    "discovery_id": item.get("id", ""),
                    "note": note["filename"],
                    "similarity": round(sim, 3),
                    "shared": sorted(list(item_kw & note["keywords"]))[:10],
                })

    return sorted(connections, key=lambda x: x["similarity"], reverse=True)


def identify_promotable(inbox_notes):
    """승격 후보 식별: maturity가 seedling이 아닌 것, 또는 키워드 3개 이상인 것."""
    promotable = []
    for note in inbox_notes:
        if note.get("location") != "inbox":
            continue
        kw_count = len(note.get("keywords", set()))
        maturity = note.get("maturity", "seedling")
        if kw_count >= 5 or maturity in ("growing", "evergreen"):
            promotable.append({
                "filename": note["filename"],
                "path": note["path"],
                "keywords": kw_count,
                "maturity": maturity,
                "reason": f"키워드 {kw_count}개" if kw_count >= 5 else f"maturity={maturity}",
            })
    return promotable


def promote_notes(promotable, dry_run=False):
    """수신함 → 노트 디렉토리로 이동."""
    moved = []
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    for p in promotable:
        src = Path(p["path"])
        dst = NOTES_DIR / src.name
        if dst.exists():
            log(f"Skip (already exists): {src.name}")
            continue
        if dry_run:
            log(f"[DRY-RUN] Would promote: {src.name} → 120 노트/")
            moved.append(src.name)
        else:
            shutil.move(str(src), str(dst))
            log(f"Promoted: {src.name} → 120 노트/")
            moved.append(src.name)
    return moved


def main():
    parser = argparse.ArgumentParser(description="Connect discoveries to ZK notes")
    parser.add_argument("--promote", action="store_true", help="Actually promote inbox notes")
    parser.add_argument("--dry-run", action="store_true", help="Preview without changes")
    args = parser.parse_args()

    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. 볼트 스캔
    notes = scan_vault()
    log(f"Scanned {len(notes)} notes (inbox + 120)")

    # 2. 필터 결과 로드
    filtered_items = []
    if FILTERED_DIR.exists():
        for f in sorted(FILTERED_DIR.glob("filtered_*.json")):
            try:
                items = json.loads(f.read_text(encoding="utf-8"))
                filtered_items.extend(items)
            except Exception:
                continue
    log(f"Loaded {len(filtered_items)} filtered items")

    # 3. 연결 탐색
    connections = find_connections(notes, filtered_items)
    log(f"Found {len(connections)} connections")

    # 4. 승격 후보 식별
    promotable = identify_promotable(notes)
    log(f"Promotable: {len(promotable)} inbox notes")

    # 5. 고립 노트 탐지
    connected_notes = set()
    for c in connections:
        if c["type"] == "note-note":
            connected_notes.add(c["a"])
            connected_notes.add(c["b"])
    all_note_names = {n["filename"] for n in notes}
    orphans = all_note_names - connected_notes
    log(f"Orphan notes (no connections): {len(orphans)}")

    # 6. 승격 실행
    moved = []
    if args.promote or args.dry_run:
        moved = promote_notes(promotable, dry_run=args.dry_run)

    # 7. 리포트 저장
    ts = datetime.now().strftime("%Y-%m-%d_%H%M")
    report = {
        "timestamp": ts,
        "total_notes": len(notes),
        "filtered_items": len(filtered_items),
        "connections": connections[:50],
        "promotable": promotable,
        "orphans": sorted(list(orphans)),
        "promoted": moved,
    }
    report_file = REPORT_DIR / f"connections_{ts}.json"
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    result = {
        "status": "ok",
        "notes": len(notes),
        "connections": len(connections),
        "promotable": len(promotable),
        "orphans": len(orphans),
        "promoted": len(moved),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
