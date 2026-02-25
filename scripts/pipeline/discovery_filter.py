#!/usr/bin/env python3
"""
discovery_filter.py — 수집된 아이디어/인사이트를 스코어링+필터링

idea_collector.py가 수집한 GitHub Issues + ingest_topic_media.py가 수집한
토픽 메시지를 읽어서 LLM 없이 휴리스틱 점수를 매기고, score≥6인 것만 통과시킨다.

Usage:
  python3 discovery_filter.py              # 기본 필터링
  python3 discovery_filter.py --min-score 7 # 고품질만
  python3 discovery_filter.py --dry-run     # 변경 없이 결과만 출력

Output: reports/ideas/filtered/ 디렉토리에 JSON 저장

Cron: */6h (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path

from shared.vault_paths import VAULT, INBOX

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
GITHUB_IDEAS_DIR = WORKSPACE / "memory" / "github-ideas"
TELEGRAM_TOPICS_DIR = WORKSPACE / "memory" / "telegram-topics"
BLOG_INSIGHTS_DIR = WORKSPACE / "memory" / "blog-insights"
VAULT_INBOX_DIR = INBOX
VAULT_NOTES_DIR = VAULT / "100 지식" / "120 노트"  # v2 legacy
FILTERED_DIR = WORKSPACE / "memory" / "filtered-ideas"
PROCESSED_FILE = FILTERED_DIR / ".processed_filter.json"

# 가치 키워드 (도메인별 가중치)
KEYWORD_SCORES = {
    # 투자/ETF
    "etf": 2, "conviction": 2, "섹터": 1, "편입": 2, "리밸런싱": 2,
    "수익률": 1, "포트폴리오": 1, "배당": 1, "실적": 1,
    # 엔지니어링
    "아키텍처": 2, "파이프라인": 1, "자동화": 1, "리팩토링": 1,
    "성능": 1, "병목": 2, "최적화": 1, "mcp": 1, "온톨로지": 2,
    # 지식/인사이트
    "인사이트": 2, "가설": 2, "실험": 2, "패턴": 1, "원칙": 2,
    "제텔카스텐": 2, "원자노트": 2,
    # 일반 품질
    "해결": 1, "구현": 1, "분석": 1, "연구": 1, "발견": 2,
}


from shared.log import make_logger
from shared.classify import get_vault_note_dirs
log = make_logger()


def load_processed():
    if PROCESSED_FILE.exists():
        try:
            return json.loads(PROCESSED_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"processed_ids": []}


def save_processed(state):
    FILTERED_DIR.mkdir(parents=True, exist_ok=True)
    # 최근 2000건만 유지
    state["processed_ids"] = state["processed_ids"][-2000:]
    PROCESSED_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def score_text(text):
    """휴리스틱 스코어링 (0-10)."""
    if not text:
        return 0, []
    text_lower = text.lower()
    score = 0
    matched = []

    for kw, weight in KEYWORD_SCORES.items():
        if kw in text_lower:
            score += weight
            matched.append(kw)

    # 길이 보너스: 100자 이상이면 +1, 300자 이상이면 +2
    if len(text) >= 300:
        score += 2
    elif len(text) >= 100:
        score += 1

    # URL 포함 시 +1 (소스 신뢰도)
    if re.search(r"https?://", text):
        score += 1

    # 10점 상한
    return min(10, score), matched


def collect_candidates():
    """GitHub Ideas + Telegram Topics에서 후보 수집."""
    candidates = []

    # GitHub Ideas (.md 파일)
    if GITHUB_IDEAS_DIR.exists():
        for md_file in GITHUB_IDEAS_DIR.glob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
                candidates.append({
                    "id": f"gh:{md_file.stem}",
                    "source": "github",
                    "text": content,
                    "file": str(md_file),
                    "date": md_file.stat().st_mtime,
                })
            except Exception:
                continue

    # Telegram Topics (.json 파일)
    if TELEGRAM_TOPICS_DIR.exists():
        for topic_dir in TELEGRAM_TOPICS_DIR.iterdir():
            if not topic_dir.is_dir():
                continue
            for json_file in topic_dir.glob("*.json"):
                try:
                    data = json.loads(json_file.read_text(encoding="utf-8"))
                    text = data.get("text", "") + " " + data.get("url", "")
                    candidates.append({
                        "id": f"tg:{topic_dir.name}:{json_file.stem}",
                        "source": f"telegram/{topic_dir.name}",
                        "text": text.strip(),
                        "file": str(json_file),
                        "date": json_file.stat().st_mtime,
                        "topic": topic_dir.name,
                    })
                except Exception:
                    continue

    # Blog Insights (.md 파일)
    if BLOG_INSIGHTS_DIR.exists():
        for md_file in BLOG_INSIGHTS_DIR.glob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
                candidates.append({
                    "id": f"blog:{md_file.stem}",
                    "source": "blog/ranto28",
                    "text": content,
                    "file": str(md_file),
                    "date": md_file.stat().st_mtime,
                })
            except Exception:
                continue

    # Vault 보강 노트 (enriched notes with body content) — v3 전체 디렉토리
    for search_dir in get_vault_note_dirs():
        if not search_dir.exists():
            continue
        for md_file in search_dir.glob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
                # frontmatter 이후 body만 추출
                body = content
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        body = parts[2]
                # 본문 50자 미만은 스킵 (빈 스텁)
                if len(body.strip()) < 50:
                    continue
                candidates.append({
                    "id": f"vault:{md_file.stem}",
                    "source": "vault/note",
                    "text": body.strip()[:1000],
                    "file": str(md_file),
                    "date": md_file.stat().st_mtime,
                })
            except Exception:
                continue

    return candidates


def main():
    parser = argparse.ArgumentParser(description="Filter and score collected ideas")
    parser.add_argument("--min-score", type=int, default=6, help="Minimum score to pass")
    parser.add_argument("--dry-run", action="store_true", help="Print results without saving")
    args = parser.parse_args()

    FILTERED_DIR.mkdir(parents=True, exist_ok=True)
    state = load_processed()
    candidates = collect_candidates()

    passed = []
    skipped = 0
    for c in candidates:
        if c["id"] in state["processed_ids"]:
            skipped += 1
            continue

        score, matched = score_text(c["text"])
        c["score"] = score
        c["matched_keywords"] = matched
        c["reason"] = f"점수 {score}/10: {', '.join(matched[:5])}" if matched else f"점수 {score}/10"

        state["processed_ids"].append(c["id"])

        if score >= args.min_score:
            passed.append(c)

    log(f"Candidates: {len(candidates)}, Skipped: {skipped}, New: {len(candidates)-skipped}, Passed(≥{args.min_score}): {len(passed)}")

    if not args.dry_run and passed:
        # 결과 저장
        ts = datetime.now().strftime("%Y-%m-%d_%H%M")
        out_file = FILTERED_DIR / f"filtered_{ts}.json"
        out_file.write_text(json.dumps(passed, ensure_ascii=False, indent=2), encoding="utf-8")
        save_processed(state)
        log(f"Saved {len(passed)} items to {out_file.name}")
    elif args.dry_run:
        for p in passed:
            print(f"  [{p['score']}] {p['source']}: {p['text'][:80]}...")
    else:
        save_processed(state)
        log("No items passed filter")

    result = {
        "status": "ok",
        "total_candidates": len(candidates),
        "passed": len(passed),
        "min_score": args.min_score,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
