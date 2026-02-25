#!/usr/bin/env python3
"""
vault_reeval.py — 주간 볼트 구조 재평가 및 확장/축소 제안

classification.json 기반으로 노트 분포를 분석하고,
구조 변경(신규 industry 추가, 빈 카테고리 제거, 클러스터 분할)을 제안한다.

Usage:
  python3 vault_reeval.py              # 재평가 + 리포트 생성
  python3 vault_reeval.py --dry-run    # 리포트만 (파일 미생성)
  python3 vault_reeval.py --apply      # 제안 자동 적용 (디렉토리 생성 등)

Cron: 매주 월요일 (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from shared.vault_paths import VAULT, CLASSIFICATION_FILE, REPORTS

CLASSIFICATION = CLASSIFICATION_FILE
REPORT_DIR = REPORTS
MOC_DIR = VAULT / "100 지식" / "150 구조노트"
REGISTRY_DIR = Path(os.path.expanduser("~/.openclaw/backups/registry"))

# 과밀/과소 임계치
OVERCROWDED_THRESHOLD = 50
EMPTY_GRACE_WEEKS = 4  # 빈 카테고리 n주 연속이면 삭제 후보


from shared.log import make_logger
from shared.classify import (
    classify_by_tags, classify_by_text, load_classification,
    get_vault_note_dirs, _is_v3,
)
from shared.frontmatter import update_frontmatter

log = make_logger()


def load_vault_notes():
    """볼트 내 모든 .md 노트 로드 (frontmatter 파싱)."""
    notes = []
    for d in get_vault_note_dirs():
        if not d.exists():
            continue
        for f in d.glob("*.md"):
            note = parse_note(f)
            if note:
                notes.append(note)
    return notes


def parse_note(path):
    """마크다운 파일에서 frontmatter 태그 추출.

    v3 우선 (category/subcategory), v2 fallback (sector/industry_group/industry).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    note = {
        "path": str(path),
        "filename": path.name,
        "tags": [],
        "category": "",
        "subcategory": "",
        "zk_type": "",
        "domain": "",
        "links": [],
    }

    # YAML frontmatter 파싱
    _sector = ""
    _ig = ""
    if text.startswith("---"):
        end = text.find("---", 3)
        if end > 0:
            fm = text[3:end]
            for line in fm.split("\n"):
                line = line.strip()
                if line.startswith("tags:"):
                    m = re.search(r"\[(.+)\]", line)
                    if m:
                        note["tags"] = [t.strip().strip('"').strip("'")
                                        for t in m.group(1).split(",")]
                elif line.startswith("- ") and note["tags"] is not None:
                    note["tags"].append(line[2:].strip().strip('"').strip("'"))
                elif line.startswith("category:"):
                    note["category"] = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("subcategory:"):
                    note["subcategory"] = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("sector:"):
                    _sector = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("industry_group:"):
                    _ig = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("zk_type:"):
                    note["zk_type"] = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("domain:"):
                    note["domain"] = line.split(":", 1)[1].strip().strip('"')

    # v2 fallback: sector → category, industry_group → subcategory
    if not note["category"] or note["category"] == "UNCLASSIFIED":
        if _sector and _sector != "UNCLASSIFIED":
            note["category"] = _sector
    if not note["subcategory"] and _ig:
        note["subcategory"] = _ig

    # wikilinks 추출
    note["links"] = re.findall(r"\[\[(.+?)\]\]", text)

    return note


def load_registry_notes():
    """note_registry JSON에서 노트 메타데이터 로드."""
    notes = []
    if not REGISTRY_DIR.exists():
        return notes
    for f in sorted(REGISTRY_DIR.glob("note_registry_*.json"), reverse=True)[:1]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            notes = data.get("notes", [])
        except Exception:
            pass
    return notes





def analyze_distribution(notes, classification):
    """노트 분포 분석 (v3: category/subcategory)."""
    is_v3 = _is_v3(classification) if classification else False
    stats = {
        "total_notes": len(notes),
        "classified": 0,
        "unclassified": 0,
        "by_category": defaultdict(int),
        "by_subcategory": defaultdict(int),
        "by_domain": defaultdict(int),
        "unlinked": 0,
        "tag_clusters": defaultdict(int),
    }

    for note in notes:
        tags = note.get("tags", [])
        for t in tags:
            stats["tag_clusters"][t] += 1

        cat = note.get("category", "")
        subcat = note.get("subcategory", "")

        if cat and cat != "UNCLASSIFIED":
            stats["classified"] += 1
            stats["by_category"][cat] += 1
            if subcat:
                stats["by_subcategory"][subcat] += 1
        else:
            # Fallback: try tag-based classification
            matches = classify_by_tags(tags, classification)
            if matches:
                best = matches[0]
                stats["classified"] += 1
                if is_v3:
                    stats["by_category"][best.get("category", "")] += 1
                    stats["by_subcategory"][best.get("subcategory", "")] += 1
                else:
                    stats["by_category"][best.get("sector", "")] += 1
                    stats["by_subcategory"][best.get("industry_group", "")] += 1
            else:
                stats["unclassified"] += 1

        domain = note.get("domain", "") or note.get("topic", "")
        stats["by_domain"][domain] += 1

        if not note.get("links"):
            stats["unlinked"] += 1

    return stats


def generate_suggestions(stats, classification):
    """구조 변경 제안 생성 (v3 categories)."""
    suggestions = []
    is_v3 = _is_v3(classification) if classification else False

    # 1. 빈 subcategory 감지
    if is_v3:
        categories = classification.get("categories", {})
        for cat_name, cat_def in categories.items():
            for subcat_name, subcat_def in cat_def.get("subcategories", {}).items():
                if stats["by_subcategory"].get(subcat_name, 0) == 0:
                    suggestions.append({
                        "type": "empty_category",
                        "severity": "low",
                        "target": f"{cat_name}/{subcat_name}",
                        "label": f"{cat_name} > {subcat_name}",
                        "suggestion": f"노트 0개 — {EMPTY_GRACE_WEEKS}주 연속이면 삭제 후보",
                    })
    else:
        sectors = classification.get("sectors", {})
        for s_code, sector in sectors.items():
            for ig_code, ig in sector.get("industry_groups", {}).items():
                for i_code, industry in ig.get("industries", {}).items():
                    if stats["by_subcategory"].get(i_code, 0) == 0:
                        suggestions.append({
                            "type": "empty_category",
                            "severity": "low",
                            "target": f"{s_code}/{ig_code}/{i_code}",
                            "label": f"{sector['label']} > {ig['label']} > {industry['label']}",
                            "suggestion": f"노트 0개 — {EMPTY_GRACE_WEEKS}주 연속이면 삭제 후보",
                        })

    # 2. 과밀 subcategory 감지
    for subcat, count in stats["by_subcategory"].items():
        if count >= OVERCROWDED_THRESHOLD:
            suggestions.append({
                "type": "overcrowded",
                "severity": "high",
                "target": subcat,
                "count": count,
                "suggestion": f"노트 {count}개 — 하위 카테고리 분할 필요",
            })

    # 3. 미분류 노트
    if stats["unclassified"] > 0:
        ratio = stats["unclassified"] / max(stats["total_notes"], 1) * 100
        suggestions.append({
            "type": "unclassified",
            "severity": "medium" if ratio > 20 else "low",
            "count": stats["unclassified"],
            "ratio": round(ratio, 1),
            "suggestion": f"미분류 {stats['unclassified']}건 ({ratio:.1f}%) — 태그 매핑 확인 필요",
        })

    # 4. 새 태그 클러스터 (분류에 없는 빈출 태그)
    all_known_tags = set()
    if is_v3:
        categories = classification.get("categories", {})
        for cat_def in categories.values():
            for subcat_def in cat_def.get("subcategories", {}).values():
                all_known_tags.update(t.lower() for t in subcat_def.get("tags", []))
    else:
        for sector in classification.get("sectors", {}).values():
            for ig in sector.get("industry_groups", {}).values():
                for industry in ig.get("industries", {}).values():
                    all_known_tags.update(t.lower() for t in industry.get("tags", []))

    for tag, count in sorted(stats["tag_clusters"].items(), key=lambda x: -x[1]):
        if tag.lower() not in all_known_tags and count >= 5:
            suggestions.append({
                "type": "new_cluster",
                "severity": "medium",
                "tag": tag,
                "count": count,
                "suggestion": f"태그 '{tag}' {count}회 출현 — 신규 카테고리 추가 검토",
            })

    # 5. 연결도 낮은 노트
    if stats["unlinked"] > 0:
        ratio = stats["unlinked"] / max(stats["total_notes"], 1) * 100
        if ratio > 50:
            suggestions.append({
                "type": "low_connectivity",
                "severity": "medium",
                "count": stats["unlinked"],
                "ratio": round(ratio, 1),
                "suggestion": f"링크 없는 노트 {stats['unlinked']}건 ({ratio:.1f}%) — 연결 강화 필요",
            })

    return suggestions


AUTO_APPLY_CAP = 50  # Maximum notes to auto-classify per run
AUTO_APPLY_MIN_CONFIDENCE = 0.7  # Minimum confidence for auto-apply


def apply_safe_changes(notes, classification, dry_run=False):
    """Auto-apply classification to UNCLASSIFIED notes with high confidence.

    Safety rules:
      - Only UNCLASSIFIED → classified (confidence ≥ 0.7)
      - Maximum AUTO_APPLY_CAP notes per run
      - Cross-domain reclassification forbidden
      - Tags with auto_classified: true for rollback tracking
      - Returns list of applied changes

    Args:
        notes: list of note dicts from load_vault_notes()
        classification: loaded classification dict
        dry_run: if True, compute changes but don't write files

    Returns:
        list of dicts describing each change made
    """
    changes = []
    applied = 0
    date_str = datetime.now().strftime("%Y-%m-%d")

    is_v3 = _is_v3(classification) if classification else False

    for note in notes:
        if applied >= AUTO_APPLY_CAP:
            break

        # Only process UNCLASSIFIED notes
        cat = note.get("category", "")
        if cat and cat != "UNCLASSIFIED":
            continue

        # Try text-based classification from note content
        path = Path(note.get("path", ""))
        if not path.exists():
            continue

        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        result = classify_by_text(text, classification=classification)

        if is_v3:
            if result.get("category", "UNCLASSIFIED") == "UNCLASSIFIED":
                continue
            if result.get("confidence", 0) < AUTO_APPLY_MIN_CONFIDENCE:
                continue

            change = {
                "file": note.get("filename", ""),
                "path": str(path),
                "new_category": result["category"],
                "new_subcategory": result["subcategory"],
                "confidence": result["confidence"],
                "matched_tags": result["matched_tags"],
            }

            if not dry_run:
                update_frontmatter(path, {
                    "category": result["category"],
                    "subcategory": result["subcategory"],
                    "auto_classified": True,
                    "auto_classified_at": date_str,
                })
        else:
            if result.get("sector", "UNCLASSIFIED") == "UNCLASSIFIED":
                continue
            if result.get("confidence", 0) < AUTO_APPLY_MIN_CONFIDENCE:
                continue

            change = {
                "file": note.get("filename", ""),
                "path": str(path),
                "new_category": result["sector"],
                "new_subcategory": result.get("industry", ""),
                "confidence": result["confidence"],
                "matched_tags": result["matched_tags"],
            }

            if not dry_run:
                update_frontmatter(path, {
                    "sector": result["sector"],
                    "industry_group": result["industry_group"],
                    "industry": result["industry"],
                    "domain": result.get("domain", ""),
                    "auto_classified": True,
                    "auto_classified_at": date_str,
                })

        changes.append(change)
        applied += 1

    return changes


def propose_structure_changes(stats, suggestions, classification):
    """Generate structured change proposals based on analysis.

    Returns dict with additive proposals only — no destructive changes.
    """
    proposals = {
        "add_industries": [],
        "merge_industries": [],
        "add_synonyms": [],
        "add_tags": [],
    }

    # Propose new industries from high-frequency unknown tag clusters
    for s in suggestions:
        if s["type"] == "new_cluster" and s.get("count", 0) >= 10:
            proposals["add_industries"].append({
                "tag": s["tag"],
                "count": s["count"],
                "suggested_action": f"태그 '{s['tag']}'로 신규 industry 생성 검토",
            })

    # Propose tag additions for overcrowded industries
    for s in suggestions:
        if s["type"] == "overcrowded" and s.get("count", 0) >= 80:
            proposals["merge_industries"].append({
                "industry": s["target"],
                "count": s["count"],
                "suggested_action": "하위 industry 분할 검토",
            })

    return proposals


def generate_report(stats, suggestions, classification):
    """마크다운 리포트 생성."""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")

    lines = [
        "---",
        f"date: {date_str}",
        "type: vault-review",
        "zk_type: reference",
        "domain: operations",
        "para_bucket: areas",
        "---",
        "",
        f"# 볼트 구조 주간 재평가 — {date_str}",
        "",
        "## 요약",
        f"- 총 노트: **{stats['total_notes']}**건",
        f"- 분류됨: **{stats['classified']}**건 ({stats['classified']/max(stats['total_notes'],1)*100:.0f}%)",
        f"- 미분류: **{stats['unclassified']}**건",
        f"- 링크 없음: **{stats['unlinked']}**건",
        "",
        "## 카테고리별 분포",
        "",
        "| 카테고리 | 노트 수 |",
        "|----------|---------|",
    ]

    for cat in sorted(stats["by_category"].keys()):
        count = stats["by_category"][cat]
        lines.append(f"| {cat} | {count} |")

    lines.extend(["", "## 서브카테고리별 분포", "", "| 서브카테고리 | 노트 수 |", "|--------------|---------|"])
    for subcat in sorted(stats["by_subcategory"].keys()):
        count = stats["by_subcategory"][subcat]
        lines.append(f"| {subcat} | {count} |")

    lines.extend(["", "## 제안 사항", ""])
    if not suggestions:
        lines.append("제안 없음 — 구조 안정적.")
    else:
        for i, s in enumerate(suggestions, 1):
            severity_icon = {"high": "🔴", "medium": "🟡", "low": "⚪"}.get(s["severity"], "⚪")
            lines.append(f"{i}. {severity_icon} **[{s['type']}]** {s['suggestion']}")

    # 다음 리뷰 날짜 계산 (다음 월요일)
    from datetime import timedelta
    days_ahead = 7 - now.weekday()  # 0=Mon
    if days_ahead <= 0:
        days_ahead += 7
    next_monday = (now + timedelta(days=days_ahead)).strftime("%Y-%m-%d")

    lines.extend([
        "",
        "## 다음 리뷰",
        f"- 예정일: **{next_monday}**",
        f"- 자동 생성: `vault_reeval.py`",
    ])

    return "\n".join(lines)


def update_classification_next_review(classification):
    """classification.json의 next_review 갱신."""
    from datetime import timedelta
    now = datetime.now()
    days_ahead = 7 - now.weekday()
    if days_ahead <= 0:
        days_ahead += 7
    next_monday = (now + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    classification["next_review"] = next_monday
    classification["updated_at"] = now.strftime("%Y-%m-%d")
    CLASSIFICATION.write_text(
        json.dumps(classification, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description="Weekly vault structure re-evaluation")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    parser.add_argument("--apply", action="store_true", help="Auto-apply suggestions")
    parser.add_argument("--propose-changes", action="store_true",
                        help="Generate structured change proposals")
    parser.add_argument("--auto-apply", action="store_true",
                        help="Auto-classify UNCLASSIFIED notes (confidence >= 0.7)")
    args = parser.parse_args()

    classification = load_classification()
    if not classification:
        print(json.dumps({"status": "error", "reason": "classification.json missing"}))
        return 1

    # 1. 볼트 노트 로드 (파일 기반 + 레지스트리 기반)
    vault_notes = load_vault_notes()
    registry_notes = load_registry_notes()

    # 통합: 볼트 파일이 적으면 레지스트리 데이터 사용
    if len(vault_notes) < 10 and registry_notes:
        log(f"Vault notes ({len(vault_notes)}) < 10, using registry ({len(registry_notes)}) as primary")
        all_notes = []
        for rn in registry_notes:
            all_notes.append({
                "path": rn.get("path", ""),
                "filename": rn.get("title", ""),
                "tags": rn.get("tags", []),
                "sector": "",
                "industry_group": "",
                "industry": "",
                "zk_type": "",
                "domain": rn.get("topic", ""),
                "links": [l.get("to_id", "") for l in rn.get("links", [])],
            })
        notes = all_notes
    else:
        notes = vault_notes

    log(f"Analyzing {len(notes)} notes")

    # 2. 분포 분석
    stats = analyze_distribution(notes, classification)
    log(f"Classified: {stats['classified']}, Unclassified: {stats['unclassified']}")

    # 3. 제안 생성
    suggestions = generate_suggestions(stats, classification)
    log(f"Suggestions: {len(suggestions)}")

    # 4. 리포트 생성
    report = generate_report(stats, suggestions, classification)

    if not args.dry_run:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        report_file = REPORT_DIR / f"vault-review-{date_str}.md"
        report_file.write_text(report, encoding="utf-8")
        log(f"Report saved: {report_file.name}")

        update_classification_next_review(classification)
        log("Updated next_review in classification.json")

    # 5. 자동 분류 (옵션)
    auto_changes = None
    if args.auto_apply:
        auto_changes = apply_safe_changes(notes, classification, dry_run=args.dry_run)
        log(f"Auto-applied: {len(auto_changes)} notes")

    # 6. 구조 변경 제안 (옵션)
    proposals = None
    if args.propose_changes:
        proposals = propose_structure_changes(stats, suggestions, classification)
        log(f"Proposals: {sum(len(v) for v in proposals.values())} items")

    # 6. 결과 JSON
    result = {
        "status": "ok",
        "total_notes": stats["total_notes"],
        "classified": stats["classified"],
        "unclassified": stats["unclassified"],
        "suggestions": len(suggestions),
        "suggestion_types": [s["type"] for s in suggestions],
        "top_categories": dict(sorted(stats["by_category"].items(), key=lambda x: -x[1])[:5]),
    }
    if proposals is not None:
        result["proposals"] = proposals
    if auto_changes is not None:
        result["auto_applied"] = len(auto_changes)
        result["auto_applied_details"] = auto_changes[:10]
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
