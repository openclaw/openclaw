#!/usr/bin/env python3
"""
ingest_topic_media.py — 지식사랑방 토픽 메시지를 제텔카스텐 수신함에 저장

Gateway가 학습 토픽 메시지를 수신하면, systemPrompt가 이 스크립트를 exec 도구로 호출한다.
메시지 텍스트/URL/첨부파일을 JSON으로 저장하고, 원자노트 후보를 110 수신함에 생성한다.
GICS 3계층 자동분류 + 섹터 MOC 자동생성/갱신.

Usage:
  python3 ingest_topic_media.py --topic nepcon --author harry --date 2026-02-19 \
    --msgid 12345 --text "본문" --url "https://..." --file "/path/to/img.jpg"
"""

import argparse
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
INBOX_DIR = Path(os.path.expanduser("~/knowledge/100 지식/110 수신함"))
MOC_DIR = Path(os.path.expanduser("~/knowledge/100 지식/130 구조노트"))
TELEGRAM_DATA_DIR = WORKSPACE / "memory" / "telegram-topics"
OCR_SCRIPT = WORKSPACE / "scripts" / "ocr_inbound_worker.py"
LOG_DIR = WORKSPACE / "logs"


from shared.log import make_logger
log = make_logger()


def ensure_dirs():
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    MOC_DIR.mkdir(parents=True, exist_ok=True)
    TELEGRAM_DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)



# Classification functions delegated to shared.classify:
# load_classification, classify_by_text, extract_keyword_tags


def save_raw_json(topic, author, date, msgid, text, url, file_path):
    """원본 메시지를 JSON으로 저장 (reports/ideas/telegram/)."""
    entry = {
        "topic": topic,
        "author": author,
        "date": date,
        "message_id": msgid,
        "text": text or "",
        "url": url or "",
        "file": file_path or "",
        "ingested_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_dir = TELEGRAM_DATA_DIR / topic
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date}_{msgid}.json"
    out_file.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Saved raw JSON: {out_file}")
    return entry


def sanitize_filename(text, max_len=40):
    """텍스트에서 파일명 안전한 부분 추출."""
    clean = re.sub(r"[^\w가-힣\s-]", "", text)
    clean = re.sub(r"\s+", "_", clean.strip())
    return clean[:max_len] if clean else "untitled"


def create_inbox_note(topic, author, date, msgid, text, url, classification=None):
    """110 수신함에 원자노트 후보 생성 (GICS 자동분류 포함)."""
    if not text and not url:
        log("No text or URL — skipping note creation")
        return None, None

    title_source = text[:60] if text else url[:60]
    slug = sanitize_filename(title_source)
    filename = f"{date}_topic_{topic}_{slug}.md"
    filepath = INBOX_DIR / filename

    # 중복 검사
    if filepath.exists():
        log(f"Note already exists: {filepath.name}")
        return filepath, None

    # GICS 분류
    gics = classify_by_text(text, url, classification)

    # 도메인: GICS 분류 결과 우선, 없으면 토픽 기반 폴백
    domain_map = {
        "nepcon": "engineering",
        "report": "investment",
        "articles": "general",
        "x_twitter": "general",
        "llm": "engineering",
        "thesis_ideas": "philosophy",
        "analysis": "investment",
        "insights": "intelligence",
        "book_papers": "philosophy",
        "youtube": "general",
        "mentality": "philosophy",
        "food": "general",
        "fitness": "general",
        "travel": "general",
        "culture": "general",
        "acct": "investment",
        "hermi": "investment",
    }
    domain = gics["domain"] if gics["sector"] != "UNCLASSIFIED" else domain_map.get(topic, "general")

    # 태그 정규화: '#' 제거 + 키워드 태그 추가
    tags = [f"topic/{topic}", "status/seed"]
    keyword_tags = extract_keyword_tags(text, url, classification)
    for kt in keyword_tags:
        if kt not in tags:
            tags.append(kt)

    frontmatter = {
        "title": title_source.replace('"', "'")[:80],
        "date": date,
        "tags": tags,
        "sector": gics["sector"],
        "industry_group": gics["industry_group"],
        "industry": gics["industry"],
        "zk_type": "fleeting",
        "maturity": "seedling",
        "para_bucket": "inbox",
        "domain": domain,
        "source_type": "capture",
        "purpose": f"지식사랑방 {topic} 토픽에서 수집",
        "source_msgid": msgid,
        "source_author": author,
    }

    # Low-confidence flagging
    confidence = gics.get("confidence", 0.0)
    if confidence > 0 and confidence < 0.4:
        frontmatter["classification_confidence"] = "low"
        frontmatter["needs_review"] = True

    body_parts = []
    if text:
        body_parts.append(text)
    if url:
        body_parts.append(f"\n출처: {url}")

    content = "---\n"
    for k, v in frontmatter.items():
        if isinstance(v, list):
            content += f'{k}: {json.dumps(v, ensure_ascii=False)}\n'
        else:
            content += f'{k}: "{v}"\n' if isinstance(v, str) else f"{k}: {v}\n"
    content += "---\n\n"
    content += "\n".join(body_parts) + "\n"

    filepath.write_text(content, encoding="utf-8")
    log(f"Created inbox note: {filepath.name} (sector={gics['sector']})")
    return filepath, gics


def update_sector_moc(sector_code, sector_label, note_filename, note_title):
    """130 구조노트/에 섹터 MOC 생성/갱신.

    MOC 파일이 없으면 생성, 있으면 [[wikilink]] 추가 (중복 방지).
    """
    if not sector_code or sector_code == "UNCLASSIFIED":
        return None

    safe_label = re.sub(r"[·/\\]", "-", sector_label)
    moc_filename = f"MOC-{sector_code}-{safe_label}.md"
    moc_path = MOC_DIR / moc_filename

    # wikilink용 노트명 (확장자 제거)
    note_stem = Path(note_filename).stem if note_filename else ""
    if not note_stem:
        return None

    link_line = f"- [[{note_stem}]]"
    display_title = note_title[:60] if note_title else note_stem
    link_line_with_title = f"- [[{note_stem}|{display_title}]]"

    if moc_path.exists():
        existing = moc_path.read_text(encoding="utf-8")
        # 중복 방지: 이미 링크가 있으면 스킵
        if f"[[{note_stem}" in existing:
            log(f"MOC already contains link: {note_stem}")
            return moc_path

        # '## 노트 목록' 섹션 뒤에 추가
        if "## 노트 목록" in existing:
            existing = existing.replace(
                "## 노트 목록\n",
                f"## 노트 목록\n{link_line_with_title}\n",
                1,
            )
        else:
            existing += f"\n{link_line_with_title}\n"

        moc_path.write_text(existing, encoding="utf-8")
        log(f"Updated MOC: {moc_filename}")
    else:
        # 신규 MOC 생성
        moc_content = f"""---
title: "MOC — {sector_code} {sector_label}"
tags: [moc, sector/{sector_code}]
zk_type: structure
sector: "{sector_code}"
---

# {sector_code} {sector_label}

이 노트는 **{sector_label}** 섹터의 구조 노트(MOC)입니다.
하위 노트가 자동으로 추가됩니다.

## 노트 목록
{link_line_with_title}
"""
        moc_path.write_text(moc_content, encoding="utf-8")
        log(f"Created MOC: {moc_filename}")

    return moc_path


def main():
    parser = argparse.ArgumentParser(description="Ingest topic media to Zettelkasten inbox")
    parser.add_argument("--topic", required=True, help="Topic name (e.g. nepcon, report)")
    parser.add_argument("--author", default="unknown", help="Message author")
    parser.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"), help="Message date")
    parser.add_argument("--msgid", default="0", help="Telegram message ID")
    parser.add_argument("--text", default="", help="Message text content")
    parser.add_argument("--url", default="", help="URL if present")
    parser.add_argument("--file", default="", help="Attached file path")
    args = parser.parse_args()

    ensure_dirs()

    # 0. classification.json 로드
    classification = load_classification()

    # 1. 원본 JSON 저장
    entry = save_raw_json(args.topic, args.author, args.date, args.msgid,
                          args.text, args.url, args.file)

    # 2. 원자노트 생성 (GICS 분류 + 트레이서빌리티 라벨링)
    note_path, gics = create_inbox_note(args.topic, args.author, args.date, args.msgid,
                                        args.text, args.url, classification,
                                        file_path=args.file)

    # 3. MOC 갱신
    moc_path = None
    if note_path and gics and gics.get("sector") != "UNCLASSIFIED":
        title_source = args.text[:60] if args.text else (args.url[:60] if args.url else "")
        moc_path = update_sector_moc(
            gics["sector"], gics["sector_label"],
            note_path.name, title_source,
        )

    # 4. 결과 출력
    result = {
        "status": "ok",
        "topic": args.topic,
        "msgid": args.msgid,
        "note_created": str(note_path) if note_path else None,
        "raw_json": str(TELEGRAM_DATA_DIR / args.topic / f"{args.date}_{args.msgid}.json"),
        "sector": gics["sector"] if gics else None,
        "moc_updated": str(moc_path) if moc_path else None,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
