#!/usr/bin/env python3
"""
experiment_tracker.py — 가설 실험 추적 및 평가

hypothesis_engine.py가 생성한 가설의 실행 결과를 추적하고,
최소 2일 경과 후 성공/실패를 판정한다.

평가 방식:
  - 엔지니어링 가설: 해당 에이전트 KPI 전후 비교
  - 투자 가설: 태스크 완료 여부 + 근거 노트 연결 성장

Usage:
  python3 experiment_tracker.py              # 평가 실행
  python3 experiment_tracker.py --dry-run    # 미리보기
  python3 experiment_tracker.py --force      # 2일 제한 무시

Cron: */12h, 매일 03:05 (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.classify import get_vault_note_dirs  # noqa: E402

from shared.vault_paths import VAULT

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))


def _get_evidence_dirs():
    """Vault dirs for evidence note search."""
    return get_vault_note_dirs()
HYPOTHESIS_DIR = WORKSPACE / "memory" / "hypotheses"
EVAL_DIR = WORKSPACE / "memory" / "experiment-results"
DB_PATH = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
MIN_EVAL_DAYS = 2


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def load_all_hypotheses():
    """모든 가설 로드."""
    hypotheses = []
    if not HYPOTHESIS_DIR.exists():
        return hypotheses
    for f in sorted(HYPOTHESIS_DIR.glob("hypothesis_*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            for h in data:
                h["_file"] = str(f)
                hypotheses.append(h)
        except Exception:
            continue
    return hypotheses


def load_evaluated_ids():
    """이미 평가된 가설 ID."""
    ids = set()
    if not EVAL_DIR.exists():
        return ids
    for f in EVAL_DIR.glob("eval_*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            for e in data:
                ids.add(e.get("hypothesis_id", ""))
        except Exception:
            continue
    return ids


def _agent_for_hypothesis(hyp):
    """가설의 도메인에 따라 담당 에이전트 반환."""
    domain = hyp.get("domain", "engineering")
    return "data-analyst" if domain == "investment" else "codex"


def get_kpi_around_date(date_str, agent="codex", window_days=2):
    """특정 날짜 전후의 KPI 점수 조회."""
    if not DB_PATH.exists():
        return None, None

    try:
        conn = sqlite3.connect(str(DB_PATH))
        before_date = (
            datetime.strptime(date_str[:10], "%Y-%m-%d") - timedelta(days=1)
        ).strftime("%Y-%m-%d")
        row_before = conn.execute(
            "SELECT total FROM agent_kpi_daily "
            "WHERE agent=? AND date<=? ORDER BY date DESC LIMIT 1",
            (agent, before_date),
        ).fetchone()

        after_date = (
            datetime.strptime(date_str[:10], "%Y-%m-%d") + timedelta(days=window_days)
        ).strftime("%Y-%m-%d")
        row_after = conn.execute(
            "SELECT total FROM agent_kpi_daily "
            "WHERE agent=? AND date>=? ORDER BY date ASC LIMIT 1",
            (agent, after_date),
        ).fetchone()

        conn.close()
        before = row_before[0] if row_before else None
        after = row_after[0] if row_after else None
        return before, after
    except Exception:
        return None, None


def get_task_status(hyp):
    """가설 관련 에이전트 태스크 완료 여부."""
    if not DB_PATH.exists():
        return "unknown"
    agent = _agent_for_hypothesis(hyp)
    domain = hyp.get("domain", "engineering")
    keyword = "투자가설" if domain == "investment" else "가설실험"

    try:
        conn = sqlite3.connect(str(DB_PATH))
        row = conn.execute(
            "SELECT status FROM bus_commands "
            "WHERE target_agent=? AND title LIKE ? "
            "ORDER BY created_at DESC LIMIT 1",
            (agent, f"%{keyword}%{hyp.get('area', '')[:20]}%"),
        ).fetchone()
        conn.close()
        return row[0] if row else "not_found"
    except Exception:
        return "error"


def count_evidence_links(hyp):
    """근거 노트의 현재 크로스링크 수 확인 (투자가설용)."""
    evidence = hyp.get("evidence_notes", [])
    if not evidence:
        return 0
    total_links = 0
    for note_name in evidence[:5]:
        for search_dir in _get_evidence_dirs():
            path = search_dir / note_name
            if path.exists():
                try:
                    text = path.read_text(encoding="utf-8")
                    import re
                    links = re.findall(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]", text)
                    total_links += len(links)
                except Exception:
                    pass
                break
    return total_links


def evaluate_hypothesis(hyp, force=False):
    """가설 평가."""
    created = hyp.get("created_at", "")
    if not created:
        return None

    try:
        created_dt = datetime.strptime(created[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None

    elapsed = (datetime.now() - created_dt).days
    if elapsed < MIN_EVAL_DAYS and not force:
        return None

    domain = hyp.get("domain", "engineering")
    agent = _agent_for_hypothesis(hyp)
    task_status = get_task_status(hyp)

    evaluation = {
        "hypothesis_id": hyp.get("id", ""),
        "area": hyp.get("area", ""),
        "domain": domain,
        "bottleneck": hyp.get("bottleneck", ""),
        "type": hyp.get("type", ""),
        "created_at": created,
        "evaluated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_days": elapsed,
        "task_agent": agent,
        "task_status": task_status,
    }

    if domain == "investment":
        # 투자 가설: 태스크 완료 + 근거 노트 연결 성장
        link_count = count_evidence_links(hyp)
        evaluation["evidence_links"] = link_count
        evaluation["kpi_before"] = None
        evaluation["kpi_after"] = None
        evaluation["kpi_delta"] = None

        if task_status == "done" and link_count >= 3:
            verdict = "positive"
        elif task_status == "done":
            verdict = "neutral"
        elif task_status in ("queued", "claimed"):
            verdict = "pending"
        else:
            verdict = "insufficient_data"
    else:
        # 엔지니어링 가설: KPI 전후 비교
        before, after = get_kpi_around_date(created, agent=agent)
        evaluation["kpi_before"] = before
        evaluation["kpi_after"] = after
        evaluation["evidence_links"] = None

        if before is not None and after is not None:
            delta = after - before
            evaluation["kpi_delta"] = round(delta, 1)
            if delta > 2:
                verdict = "positive"
            elif delta < -2:
                verdict = "negative"
            else:
                verdict = "neutral"
        else:
            evaluation["kpi_delta"] = None
            verdict = "insufficient_data"

    evaluation["verdict"] = verdict
    return evaluation


def main():
    parser = argparse.ArgumentParser(
        description="Track and evaluate hypothesis experiments"
    )
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    parser.add_argument("--force", action="store_true",
                        help="최소 평가 기간(2일) 무시")
    args = parser.parse_args()

    EVAL_DIR.mkdir(parents=True, exist_ok=True)

    hypotheses = load_all_hypotheses()
    evaluated_ids = load_evaluated_ids()

    log(f"Total hypotheses: {len(hypotheses)}, "
        f"Already evaluated: {len(evaluated_ids)}")

    pending = [h for h in hypotheses if h.get("id") not in evaluated_ids]
    log(f"Pending evaluation: {len(pending)}")

    evaluations = []
    for hyp in pending:
        ev = evaluate_hypothesis(hyp, force=args.force)
        if ev is None:
            continue
        evaluations.append(ev)
        log(f"Evaluated: {ev['hypothesis_id']} [{ev['domain']}] "
            f"→ {ev['verdict']} (task={ev['task_status']}, "
            f"kpi_delta={ev['kpi_delta']}, links={ev.get('evidence_links')})")

    if evaluations and not args.dry_run:
        ts = datetime.now().strftime("%Y-%m-%d_%H%M")
        out_file = EVAL_DIR / f"eval_{ts}.json"
        out_file.write_text(
            json.dumps(evaluations, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log(f"Saved {len(evaluations)} evaluations to {out_file.name}")

    verdicts = {}
    for ev in evaluations:
        v = ev["verdict"]
        verdicts[v] = verdicts.get(v, 0) + 1

    result = {
        "status": "ok",
        "total_hypotheses": len(hypotheses),
        "evaluated_this_run": len(evaluations),
        "verdicts": verdicts,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
