#!/usr/bin/env python3
"""
system_digest.py — 전체 시스템 진단 결과를 하나의 JSON으로 집계.

Cowork 예약작업이 이 파일 하나만 읽으면 전체 상황 파악 가능.
각 파이프라인 상태 파일 + 실시간 체크를 결합.

Usage:
  python3 system_digest.py              # JSON 출력
  python3 system_digest.py --pretty     # 읽기 좋은 포맷
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
CRON_FILE = Path(os.path.expanduser("~/.openclaw/cron/jobs.json"))
VAULT = Path(os.path.expanduser("~/knowledge"))
DIGEST_FILE = WORKSPACE / "memory" / "system-digest" / "latest.json"
LEDGER_FILE = WORKSPACE / "memory" / "error-ledger" / "ledger.json"


def _read_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _count_md(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(1 for f in d.rglob("*.md")
               if "archives" not in f.parts and ".obsidian" not in f.parts)


def collect_vault_status() -> dict:
    """볼트 단계별 현황."""
    stages = {
        "100 캡처": VAULT / "100 캡처" / "110 수신함",
        "200 정리": VAULT / "200 정리",
        "210 원자노트": VAULT / "200 정리" / "210 원자노트",
        "220 기업": VAULT / "200 정리" / "220 기업",
        "225 시장": VAULT / "200 정리" / "225 시장",
        "230 산업분석": VAULT / "200 정리" / "230 산업분석",
        "235 프로그래밍": VAULT / "200 정리" / "235 프로그래밍",
        "300 지식화": VAULT / "300 지식화",
        "400 연결": VAULT / "400 연결",
        "500 판단": VAULT / "500 판단",
        "600 리소스": VAULT / "600 리소스",
        "700 활동": VAULT / "700 활동",
        "800 운영": VAULT / "800 운영",
        "900 시스템": VAULT / "900 시스템",
    }
    return {name: _count_md(path) for name, path in stages.items()}


def collect_cron_status() -> dict:
    """크론 작업 상태 요약."""
    data = _read_json(CRON_FILE)
    if not data:
        return {"error": "jobs.json not found"}

    jobs = data.get("jobs", [])
    enabled = [j for j in jobs if j.get("enabled")]
    errors = []
    for j in enabled:
        state = j.get("state", {})
        consec = state.get("consecutiveErrors", 0)
        if consec > 0:
            errors.append({
                "id": j.get("id"),
                "name": j.get("name"),
                "consecutive_errors": consec,
                "last_status": state.get("lastStatus"),
            })

    return {
        "total": len(jobs),
        "enabled": len(enabled),
        "with_errors": errors,
    }


def collect_pipeline_states() -> dict:
    """각 파이프라인 상태 파일 수집."""
    memory_dir = WORKSPACE / "memory"
    pipelines = {}

    state_dirs = [
        "vault-architect",
        "vault-flow-health",
    ]
    for name in state_dirs:
        state_file = memory_dir / name / "state.json"
        data = _read_json(state_file)
        if data:
            pipelines[name] = {
                "last_updated": _file_age_str(state_file),
                "summary": _summarize_state(name, data),
            }

    return pipelines


def collect_recent_logs() -> dict:
    """최근 로그에서 에러 추출."""
    log_dir = WORKSPACE / "logs"
    if not log_dir.exists():
        return {}

    errors = {}
    for log_file in sorted(log_dir.glob("*.log")):
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").split("\n")
            recent_errors = [l for l in lines[-50:] if "[ERROR]" in l]
            if recent_errors:
                errors[log_file.stem] = recent_errors[-5:]
        except OSError:
            continue

    return errors


def collect_test_status() -> dict:
    """테스트 결과 요약 (최근 실행 기준)."""
    # pytest 캐시에서 마지막 실패 확인
    cache_dir = WORKSPACE / ".pytest_cache" / "v" / "cache" / "lastfailed"
    if cache_dir.exists():
        data = _read_json(cache_dir)
        if data:
            return {"last_failed": list(data.keys())[:10]}
    return {"last_failed": []}


def _file_age_str(path: Path) -> str:
    try:
        age_sec = time.time() - path.stat().st_mtime
        if age_sec < 3600:
            return f"{int(age_sec / 60)}분 전"
        elif age_sec < 86400:
            return f"{int(age_sec / 3600)}시간 전"
        else:
            return f"{int(age_sec / 86400)}일 전"
    except OSError:
        return "unknown"


def _summarize_state(name: str, data: dict) -> dict:
    if name == "vault-architect":
        daily = data.get("daily_stats", {})
        today = datetime.now().strftime("%Y-%m-%d")
        return {
            "last_run": data.get("last_run", "never"),
            "today": daily.get(today, {}),
        }
    elif name == "vault-flow-health":
        today = datetime.now().strftime("%Y-%m-%d")
        counts = data.get(today, {})
        return {"today_counts": counts} if counts else {"latest": "no data today"}
    return {"raw_keys": list(data.keys())[:10]}


def collect_vault_quality() -> dict:
    """볼트 9단계 품질 + 교차교정 + 3시스템 통합 진단."""
    try:
        from pipeline.vault_flow_health import (
            compute_stage_quality, detect_misplaced_notes,
            check_integration_health, compute_quality_trend, load_state,
            count_stage_notes,
        )
        counts = count_stage_notes()
        quality = compute_stage_quality(counts)
        scores = {k: v["score"] for k, v in quality.items()}

        state = load_state()
        trend = compute_quality_trend(state)

        misplaced = detect_misplaced_notes(limit=50)
        integration = check_integration_health()

        return {
            "scores": scores,
            "7d_trend": trend,
            "misplaced": len(misplaced),
            "misplaced_detail": misplaced[:10],
            "integration": integration,
        }
    except Exception as e:
        return {"error": str(e)}


def update_error_ledger(digest: dict) -> None:
    """digest의 에러를 ledger.json에 누적."""
    today = datetime.now().strftime("%Y-%m-%d")

    # 기존 레저 로드
    ledger = _read_json(LEDGER_FILE) or {"updated_at": None, "errors": []}
    existing = {e["id"]: e for e in ledger.get("errors", [])}

    # digest에서 현재 에러 ID 수집
    seen_ids: set[str] = set()

    # 1) 크론 에러
    cron = digest.get("cron", {})
    for err in cron.get("with_errors", []):
        eid = f"cron__{err['id']}"
        seen_ids.add(eid)
        if eid in existing:
            entry = existing[eid]
            if entry.get("last_seen") != today:
                entry["occurrences"] = entry.get("occurrences", 1) + 1
                entry["last_seen"] = today
            entry["detail"] = f"consecutiveErrors: {err['consecutive_errors']}"
            if entry.get("status") in ("resolved", "fixed"):
                entry["status"] = "open"
        else:
            existing[eid] = {
                "id": eid,
                "source": "cron",
                "title": f"{err['id']} 크론 실패",
                "detail": f"consecutiveErrors: {err['consecutive_errors']}",
                "severity": "medium",
                "first_seen": today,
                "last_seen": today,
                "occurrences": 1,
                "status": "open",
                "fix_history": [],
            }

    # 2) 로그 에러
    recent_errors = digest.get("recent_errors", {})
    for log_name, lines in recent_errors.items():
        for line in lines:
            err_hash = hashlib.md5(line.encode()).hexdigest()[:8]
            eid = f"log__{log_name}__{err_hash}"
            seen_ids.add(eid)
            if eid in existing:
                entry = existing[eid]
                if entry.get("last_seen") != today:
                    entry["occurrences"] = entry.get("occurrences", 1) + 1
                    entry["last_seen"] = today
                if entry.get("status") in ("resolved", "fixed"):
                    entry["status"] = "open"
            else:
                # 로그 라인에서 간결한 제목 추출
                title_part = line.strip()[-80:] if len(line.strip()) > 80 else line.strip()
                existing[eid] = {
                    "id": eid,
                    "source": "log",
                    "title": f"{log_name}: {title_part}",
                    "detail": line.strip(),
                    "severity": "low",
                    "first_seen": today,
                    "last_seen": today,
                    "occurrences": 1,
                    "status": "open",
                    "fix_history": [],
                }

    # 3) 테스트 실패
    tests = digest.get("tests", {})
    for test_name in tests.get("last_failed", []):
        simplified = test_name.replace("::", "__").replace("/", "_").replace(" ", "_")[:60]
        eid = f"test__{simplified}"
        seen_ids.add(eid)
        if eid in existing:
            entry = existing[eid]
            if entry.get("last_seen") != today:
                entry["occurrences"] = entry.get("occurrences", 1) + 1
                entry["last_seen"] = today
            if entry.get("status") in ("resolved", "fixed"):
                entry["status"] = "open"
        else:
            existing[eid] = {
                "id": eid,
                "source": "test",
                "title": f"테스트 실패: {test_name}",
                "detail": test_name,
                "severity": "medium",
                "first_seen": today,
                "last_seen": today,
                "occurrences": 1,
                "status": "open",
                "fix_history": [],
            }

    # 자동 규칙 적용
    cutoff_resolved = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    cutoff_auto_resolve = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    to_delete = []
    for eid, entry in existing.items():
        # 3회+ → severity high 승격
        if entry.get("occurrences", 1) >= 3 and entry.get("severity") != "high":
            entry["severity"] = "high"

        # 7일 미출현 open → resolved
        if (entry.get("status") == "open"
                and eid not in seen_ids
                and entry.get("last_seen", today) < cutoff_auto_resolve):
            entry["status"] = "resolved"

        # 30일+ resolved/fixed → 삭제
        if entry.get("status") in ("resolved", "fixed"):
            if entry.get("last_seen", today) < cutoff_resolved:
                to_delete.append(eid)

    for eid in to_delete:
        del existing[eid]

    # severity 기준 정렬: high > medium > low
    severity_order = {"high": 0, "medium": 1, "low": 2}
    sorted_errors = sorted(
        existing.values(),
        key=lambda e: (severity_order.get(e.get("severity", "low"), 3), -e.get("occurrences", 1)),
    )

    ledger = {
        "updated_at": datetime.now().isoformat(),
        "errors": sorted_errors,
    }

    LEDGER_FILE.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_FILE.write_text(
        json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def _summarize_ledger() -> dict:
    """레저 요약 — digest에 포함."""
    ledger = _read_json(LEDGER_FILE)
    if not ledger:
        return {"total_open": 0, "high_severity": 0, "recurring_3plus": 0, "top_errors": []}

    errors = ledger.get("errors", [])
    open_errors = [e for e in errors if e.get("status") == "open"]
    high = [e for e in open_errors if e.get("severity") == "high"]
    recurring = [e for e in open_errors if e.get("occurrences", 1) >= 3]

    top = []
    for e in open_errors[:5]:
        top.append({
            "id": e["id"],
            "title": e.get("title", ""),
            "occurrences": e.get("occurrences", 1),
            "severity": e.get("severity", "low"),
        })

    return {
        "total_open": len(open_errors),
        "high_severity": len(high),
        "recurring_3plus": len(recurring),
        "top_errors": top,
    }


def build_digest() -> dict:
    return {
        "generated_at": datetime.now().isoformat(),
        "vault": collect_vault_status(),
        "vault_quality": collect_vault_quality(),
        "cron": collect_cron_status(),
        "pipelines": collect_pipeline_states(),
        "recent_errors": collect_recent_logs(),
        "tests": collect_test_status(),
        "error_ledger_summary": _summarize_ledger(),
        "action_hints": _generate_hints(),
    }


def _generate_hints() -> list[str]:
    """자동 생성 힌트 — Cowork가 우선순위 잡는 데 도움."""
    hints = []
    vault = collect_vault_status()

    if vault.get("300 지식화", 0) == 0:
        hints.append("[지식화] 품질 위험 (0/100) — 즉시 승격 필요")
    if vault.get("210 원자노트", 0) > 100:
        hints.append(f"미분류 원자노트 {vault['210 원자노트']}건 — 카테고리 분류 필요")

    judge = vault.get("500 판단", 0)
    notes = vault.get("200 정리", 0)
    if judge > notes:
        hints.append(f"역깔때기: 500 판단({judge}) > 200 정리({notes}) — 교정 필요")

    # 품질 기반 힌트
    quality = collect_vault_quality()
    if not quality.get("error"):
        scores = quality.get("scores", {})
        for stage, score in scores.items():
            if score < 30:
                hints.append(f"[{stage}] 품질 위험 ({score}/100) — 즉시 개선 필요")
            elif score < 60:
                hints.append(f"[{stage}] 품질 경고 ({score}/100) — 보강 필요")

        misplaced_count = quality.get("misplaced", 0)
        if misplaced_count > 0:
            hints.append(f"교차 교정 대상 {misplaced_count}건 발견")

        integration = quality.get("integration", {})
        int_score = integration.get("score", 100)
        if int_score < 70:
            issues = integration.get("issues", [])
            for issue in issues[:3]:
                hints.append(f"통합 경고: {issue}")

        # 7일 품질 하락 알림
        trend = quality.get("7d_trend", {})
        for stage, delta in trend.items():
            if delta < -10:
                hints.append(f"[{stage}] 7일간 품질 {delta}점 하락")

    # 운영 리포트 적체
    report_count = vault.get("800 운영", 0)
    if report_count > 100:
        hints.append(f"[운영] 문서 {report_count}건 — 아카이브 필요")

    # 리소스 힌트
    res_count = vault.get("600 리소스", 0)
    if res_count > 0:
        res_scores = quality.get("scores", {})
        if res_scores.get("리소스", 100) < 50:
            hints.append(f"[리소스] 참조율 낮음 — 고아 리소스 정리")

    cron = collect_cron_status()
    if cron.get("with_errors"):
        for e in cron["with_errors"]:
            hints.append(f"크론 에러: {e['id']} ({e['consecutive_errors']}회 연속)")

    errors = collect_recent_logs()
    if errors:
        hints.append(f"최근 로그 에러: {', '.join(errors.keys())}")

    # 레저 기반 힌트
    ledger_summary = _summarize_ledger()
    recurring = ledger_summary.get("recurring_3plus", 0)
    if recurring > 0:
        hints.append(f"반복 에러 {recurring}건 (3일+) — 근본 원인 분석 필요")
    high_sev = ledger_summary.get("high_severity", 0)
    if high_sev > 0:
        hints.append(f"심각 에러 {high_sev}건 — 우선 처리")

    return hints


def main():
    parser = argparse.ArgumentParser(description="시스템 진단 집계")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    digest = build_digest()

    # 에러 레저 누적
    update_error_ledger(digest)

    # 파일로도 저장
    DIGEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    DIGEST_FILE.write_text(
        json.dumps(digest, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    if args.pretty:
        print(json.dumps(digest, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(digest, ensure_ascii=False))


if __name__ == "__main__":
    main()
