#!/usr/bin/env python3
"""
keyword_tuner.py — 실험 결과 기반 idea_sources.json 키워드 자동 갱신

experiment_tracker.py의 평가 결과(positive/negative)를 분석하여
idea_sources.json의 키워드와 병목을 자동 업데이트한다.

- positive 가설의 키워드 → 해당 area에 추가/강화
- negative 가설의 병목 → 재정의 또는 해결됨 표시
- 해결된 병목 → current_bottlenecks에서 제거

Usage:
  python3 keyword_tuner.py              # 갱신 실행
  python3 keyword_tuner.py --dry-run    # 미리보기

Cron: 매주 월요일 (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
IDEA_SOURCES = Path(os.path.expanduser("~/.openclaw/idea_sources.json"))
EVAL_DIR = WORKSPACE / "memory" / "experiment-results"
TUNER_STATE = WORKSPACE / "memory" / ".keyword_tuner_state.json"


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def load_tuner_state():
    if TUNER_STATE.exists():
        try:
            return json.loads(TUNER_STATE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"last_run": "", "processed_eval_files": []}


def save_tuner_state(state):
    state["last_run"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    TUNER_STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def load_evaluations(state):
    """미처리 평가 결과 로드."""
    processed = set(state.get("processed_eval_files", []))
    evals = []
    if not EVAL_DIR.exists():
        return evals, []

    new_files = []
    for f in sorted(EVAL_DIR.glob("eval_*.json")):
        if f.name in processed:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            evals.extend(data)
            new_files.append(f.name)
        except Exception:
            continue
    return evals, new_files


def extract_keywords_from_text(text):
    """텍스트에서 의미 있는 키워드 추출."""
    korean = set(re.findall(r"[가-힣]{2,}", text))
    english = set(w.lower() for w in re.findall(r"[a-zA-Z]{3,}", text))
    stopwords = {"the", "and", "for", "from", "with", "this", "that", "are", "was",
                 "have", "has", "been", "will", "can", "not", "but", "all", "you",
                 "하는", "있는", "것을", "것이", "위해", "대한", "통해", "않는"}
    return (korean | english) - stopwords


def apply_tuning(idea_sources, evaluations, dry_run=False):
    """평가 결과를 idea_sources에 반영."""
    changes = []

    for ev in evaluations:
        area = ev.get("area", "")
        verdict = ev.get("verdict", "")
        bottleneck = ev.get("bottleneck", "")

        if area not in idea_sources.get("focus_areas", {}):
            continue

        area_config = idea_sources["focus_areas"][area]

        if verdict == "positive":
            # 성공한 가설의 발견에서 키워드 추출 → area에 추가
            hyp_text = ev.get("bottleneck", "") + " " + ev.get("hypothesis_id", "")
            new_kw = extract_keywords_from_text(hyp_text)
            existing_kw = set(area_config.get("keywords", []))
            to_add = new_kw - existing_kw
            if to_add:
                added = list(to_add)[:3]  # 최대 3개 추가
                area_config["keywords"] = list(existing_kw | set(added))
                changes.append(f"[{area}] 키워드 추가: {', '.join(added)}")

            # 해결된 병목 제거
            current_bn = area_config.get("current_bottlenecks", [])
            if bottleneck in current_bn:
                current_bn.remove(bottleneck)
                area_config["current_bottlenecks"] = current_bn
                changes.append(f"[{area}] 병목 해결됨: {bottleneck[:50]}")

        elif verdict == "negative":
            # 실패한 가설 — 병목 재정의 (메모 추가)
            current_bn = area_config.get("current_bottlenecks", [])
            refined = f"{bottleneck} (가설 실패, 재검토 필요)"
            for i, bn in enumerate(current_bn):
                if bn == bottleneck:
                    current_bn[i] = refined
                    changes.append(f"[{area}] 병목 재정의: {bottleneck[:50]}")
                    break

    if changes and not dry_run:
        idea_sources["updated_at"] = datetime.now().strftime("%Y-%m-%d")
        IDEA_SOURCES.write_text(json.dumps(idea_sources, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"Updated idea_sources.json with {len(changes)} changes")

    return changes


def main():
    parser = argparse.ArgumentParser(description="Tune keywords based on experiment results")
    parser.add_argument("--dry-run", action="store_true", help="Preview without saving")
    args = parser.parse_args()

    state = load_tuner_state()

    # 1. 평가 결과 로드
    evaluations, new_files = load_evaluations(state)
    log(f"New evaluations: {len(evaluations)} from {len(new_files)} files")

    if not evaluations:
        print(json.dumps({"status": "ok", "changes": 0, "reason": "no new evaluations"}))
        return 0

    # 2. idea_sources.json 로드
    if not IDEA_SOURCES.exists():
        log("idea_sources.json not found")
        print(json.dumps({"status": "error", "reason": "idea_sources.json missing"}))
        return 1

    idea_sources = json.loads(IDEA_SOURCES.read_text(encoding="utf-8"))

    # 3. 튜닝 적용
    changes = apply_tuning(idea_sources, evaluations, dry_run=args.dry_run)

    for c in changes:
        log(f"  {c}")

    # 4. 상태 저장
    if not args.dry_run:
        state["processed_eval_files"].extend(new_files)
        state["processed_eval_files"] = state["processed_eval_files"][-500:]
        save_tuner_state(state)

    # 5. 통계
    verdicts = {}
    for ev in evaluations:
        v = ev.get("verdict", "unknown")
        verdicts[v] = verdicts.get(v, 0) + 1

    result = {
        "status": "ok",
        "evaluations_processed": len(evaluations),
        "verdicts": verdicts,
        "changes_applied": len(changes),
        "changes": changes,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
