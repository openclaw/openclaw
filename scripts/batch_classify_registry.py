#!/usr/bin/env python3
"""batch_classify_registry.py — note_registry 571건 배치 GICS 분류 + 원자노트화

Usage:
  python3 batch_classify_registry.py --dry-run          # 분류 결과만 출력
  python3 batch_classify_registry.py                    # 실제 노트 생성
  python3 batch_classify_registry.py --backfill-inbox   # 기존 수신함 미분류 노트 GICS 보충

Rollback:
  find ~/knowledge/100\ 지식/110\ 수신함/ -name "reg-*.md" -delete
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from ingest_topic_media import (
    classify_by_text,
    load_classification,
    sanitize_filename,
    update_sector_moc,
    update_category_moc,
)
from shared.classify import _is_v3

from shared.vault_paths import VAULT, INBOX

REGISTRY_PATH = Path(os.path.expanduser(
    "~/.openclaw/backups/registry/note_registry_20260214-212234.json"
))
INBOX_DIR = INBOX
MOC_DIR = VAULT / "100 지식" / "150 구조노트"


# ── helpers ──────────────────────────────────────────────────────────────────

def load_registry(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("notes", [])


def scan_existing_inbox():
    """수신함의 external_key/title/stem 수집 → 중복 방지용."""
    keys, titles, stems = set(), set(), set()
    for md in INBOX_DIR.glob("*.md"):
        stems.add(md.stem)
        try:
            content = md.read_text(encoding="utf-8")
        except OSError:
            continue
        if not content.startswith("---"):
            continue
        end = content.find("---", 3)
        if end < 0:
            continue
        for line in content[3:end].splitlines():
            if line.startswith("title:"):
                t = line.split(":", 1)[1].strip().strip('"').strip("'")
                if t:
                    titles.add(t.lower())
            for prefix in ("external_key:", "registry_id:", "source_msgid:"):
                if line.startswith(prefix):
                    v = line.split(":", 1)[1].strip().strip('"').strip("'")
                    if v and v != "0":
                        keys.add(v)
    return keys, titles, stems


def build_frontmatter(entry, gics):
    """registry 엔트리 + GICS 결과 → YAML frontmatter dict."""
    title = entry.get("title", "Untitled")
    tags = list(entry.get("tags", []))
    topic = entry.get("topic", "")

    # topic 태그 추가
    if topic:
        topic_tag = f"topic/{topic}"
        if topic_tag not in tags:
            tags.insert(0, topic_tag)
    for extra in ("status/seed", "source/registry"):
        if extra not in tags:
            tags.append(extra)

    date_str = entry.get("created_at", "")[:10] or datetime.now().strftime("%Y-%m-%d")

    fm = {
        "title": title.replace('"', "'")[:80],
        "date": date_str,
        "tags": tags,
        "zk_type": "fleeting",
        "maturity": entry.get("maturity", "seedling"),
        "para_bucket": "inbox",
        "source_type": "capture",
        "source": entry.get("source", ""),
        "registry_id": entry.get("id", ""),
    }

    # v3: category/subcategory, v2 fallback: sector/industry_group/industry
    if "category" in gics:
        fm["category"] = gics["category"]
        fm["subcategory"] = gics.get("subcategory", "")
    else:
        fm["sector"] = gics["sector"]
        fm["industry_group"] = gics.get("industry_group", "")
        fm["industry"] = gics.get("industry", "")
        fm["domain"] = gics.get("domain", "general")

    return fm


def render_note(fm, title):
    """frontmatter dict → markdown string."""
    lines = ["---"]
    for k, v in fm.items():
        if isinstance(v, list):
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
        elif isinstance(v, str):
            lines.append(f'{k}: "{v}"')
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {title}")
    lines.append("")
    lines.append("(registry에서 생성된 시드 노트)")
    lines.append("")
    return "\n".join(lines)


def unique_filepath(slug, date_str=""):
    """날짜 접두사 포함 파일명 고유성 보장."""
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    name = f"{date_str}_{slug}.md"
    path = INBOX_DIR / name
    c = 1
    while path.exists():
        name = f"{date_str}_{slug}-{c}.md"
        path = INBOX_DIR / name
        c += 1
    return path, name


# ── main modes ───────────────────────────────────────────────────────────────

def run_batch(registry_path, classification, dry_run=False):
    notes = load_registry(registry_path)
    print(f"레지스트리 로드: {len(notes)}건")

    keys, titles, stems = scan_existing_inbox()
    print(f"기존 수신함: 파일 {len(stems)}개, 키 {len(keys)}개, 타이틀 {len(titles)}개")

    stats = {"created": 0, "classified": 0, "unclassified": 0,
             "skipped_dup": 0, "moc_updated": 0}
    sector_counts = {}

    for i, entry in enumerate(notes, 1):
        eid = entry.get("id", "")
        title = entry.get("title", "")
        ext_key = entry.get("external_key", "")

        # 중복 체크
        if ext_key and ext_key in keys:
            stats["skipped_dup"] += 1
            continue
        if eid and eid in keys:
            stats["skipped_dup"] += 1
            continue
        if title and title.lower() in titles:
            stats["skipped_dup"] += 1
            continue

        # GICS 분류
        tag_text = " ".join(entry.get("tags", []))
        text = f"{title} {tag_text}"
        gics = classify_by_text(text, classification=classification)
        sector = gics.get("category", gics.get("sector", "UNCLASSIFIED"))

        sector_counts[sector] = sector_counts.get(sector, 0) + 1

        if sector == "UNCLASSIFIED":
            stats["unclassified"] += 1
        else:
            stats["classified"] += 1

        # 노트 생성
        slug = sanitize_filename(title)
        date_str = entry.get("created_at", "")[:10] or datetime.now().strftime("%Y-%m-%d")
        filepath, filename = unique_filepath(slug, date_str)
        fm = build_frontmatter(entry, gics)
        content = render_note(fm, title)

        if not dry_run:
            filepath.write_text(content, encoding="utf-8")
        stats["created"] += 1

        # MOC 갱신
        category = gics.get("category", gics.get("sector", "UNCLASSIFIED"))
        if category != "UNCLASSIFIED":
            subcategory = gics.get("subcategory", gics.get("sector_label", ""))
            if not dry_run:
                update_category_moc(category, subcategory, filename, title)
            stats["moc_updated"] += 1

        # 자기 중복 방지
        titles.add(title.lower())
        if ext_key:
            keys.add(ext_key)
        if eid:
            keys.add(eid)

        # 진행률 (100건마다)
        if i % 100 == 0:
            print(f"  진행: {i}/{len(notes)}")

    # 리포트
    print(f"\n{'=== 결과 리포트 (드라이런) ===' if dry_run else '=== 결과 리포트 ==='}")
    print(f"총 레지스트리:  {len(notes)}건")
    print(f"생성:           {stats['created']}건")
    print(f"  분류 성공:    {stats['classified']}건")
    print(f"  미분류:       {stats['unclassified']}건")
    print(f"중복 스킵:      {stats['skipped_dup']}건")
    print(f"MOC 갱신:       {stats['moc_updated']}건")
    print(f"\n--- 섹터별 분포 ---")
    for s in sorted(sector_counts.keys()):
        print(f"  {s}: {sector_counts[s]}건")
    return stats


def run_backfill(classification, dry_run=False):
    print("=== 수신함 GICS 백필 ===")
    updated, skipped, already = 0, 0, 0

    for md in sorted(INBOX_DIR.glob("*.md")):
        try:
            content = md.read_text(encoding="utf-8")
        except OSError:
            skipped += 1
            continue
        if not content.startswith("---"):
            skipped += 1
            continue
        end = content.find("---", 3)
        if end < 0:
            skipped += 1
            continue

        fm_text = content[3:end]

        # 이미 분류됨?
        has_valid_class = False
        title, tags_raw = "", ""
        for line in fm_text.splitlines():
            if line.startswith("category:"):
                val = line.split(":", 1)[1].strip().strip('"').strip("'")
                if val and val != "UNCLASSIFIED":
                    has_valid_class = True
            if line.startswith("sector:"):
                val = line.split(":", 1)[1].strip().strip('"').strip("'")
                if val and val != "UNCLASSIFIED":
                    has_valid_class = True
            if line.startswith("title:"):
                title = line.split(":", 1)[1].strip().strip('"').strip("'")
            if line.startswith("tags:"):
                tags_raw = line.split(":", 1)[1].strip()

        if has_valid_class:
            already += 1
            continue

        # 분류 시도
        text = f"{title} {tags_raw}"
        gics = classify_by_text(text, classification=classification)
        cat = gics.get("category", gics.get("sector", "UNCLASSIFIED"))
        if cat == "UNCLASSIFIED":
            skipped += 1
            continue

        # frontmatter에 분류 필드 삽입 (v3: category/subcategory)
        if "category" in gics:
            insert = f'category: "{gics["category"]}"\nsubcategory: "{gics.get("subcategory", "")}"'
        else:
            insert = f'sector: "{gics["sector"]}"\nindustry_group: "{gics["industry_group"]}"\nindustry: "{gics["industry"]}"'
            if "domain:" not in fm_text:
                insert += f'\ndomain: "{gics["domain"]}"'

        new_fm = fm_text.rstrip() + "\n" + insert + "\n"
        new_content = "---\n" + new_fm + "---" + content[end + 3:]

        if not dry_run:
            md.write_text(new_content, encoding="utf-8")
        updated += 1
        print(f"  backfill: {md.name} → {cat}")

    print(f"\n완료: {updated}건 분류 추가, {already}건 이미 분류, {skipped}건 스킵")
    if dry_run:
        print("(드라이런: 실제 변경 없음)")
    return updated, skipped


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="note_registry 배치 GICS 분류 + 원자노트화")
    parser.add_argument("--dry-run", action="store_true", help="실제 파일 생성 없이 분류 결과만 출력")
    parser.add_argument("--backfill-inbox", action="store_true", help="기존 수신함 미분류 노트에 GICS 보충")
    parser.add_argument("--registry", type=str, default=str(REGISTRY_PATH))
    args = parser.parse_args()

    classification = load_classification()
    if not classification:
        print("ERROR: classification.json 로드 실패")
        sys.exit(1)

    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    MOC_DIR.mkdir(parents=True, exist_ok=True)

    if args.backfill_inbox:
        run_backfill(classification, dry_run=args.dry_run)
    else:
        run_batch(Path(args.registry), classification, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
