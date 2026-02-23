#!/usr/bin/env python3
"""
health_check.py — 시스템 헬스 체크 (하트비트 에이전트용)
HEARTBEAT.md의 자동조치 규칙을 지원하는 종합 점검 스크립트.

Usage:
    python3 health_check.py              # 전체 점검 (JSON 출력)
    python3 health_check.py --brief      # 요약만 출력 (텍스트)
    python3 health_check.py --fix        # 자동 복구 시도 포함
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

BASE = Path("/Users/ron/.openclaw/workspace")
TTL_PATH = BASE / "knowledge" / "ontology" / "knowledge.ttl"
ETF_DATA = BASE / "knowledge" / "03-Portfolio" / "etf_data"
CONFIG_PATH = Path("/Users/ron/.openclaw/openclaw.json")
CRON_PATH = Path("/Users/ron/.openclaw/cron/jobs.json")
ATTACH_DIR = BASE / "knowledge" / "attachments"


def check_ontology():
    """Check ontology health: file exists, recent update, triple count."""
    issues = []
    info = {}

    if not TTL_PATH.exists():
        issues.append("knowledge.ttl 파일 없음")
        return {"status": "error", "issues": issues}

    # File age
    mtime = datetime.fromtimestamp(TTL_PATH.stat().st_mtime)
    age_hours = (datetime.now() - mtime).total_seconds() / 3600
    info["ttl_last_modified"] = mtime.strftime("%Y-%m-%d %H:%M")
    info["ttl_age_hours"] = round(age_hours, 1)
    info["ttl_size_kb"] = round(TTL_PATH.stat().st_size / 1024, 1)

    if age_hours > 48:
        issues.append(f"TTL 파일 {age_hours:.0f}시간 미갱신 (48시간 초과)")

    # Triple count via ontology_core
    try:
        result = subprocess.run(
            [sys.executable, str(BASE / "scripts" / "ontology_core.py"),
             "--action", "stats"],
            capture_output=True, text=True, timeout=30,
            cwd=str(BASE / "scripts"))
        if result.returncode == 0:
            stats = json.loads(result.stdout)
            info["triples"] = stats.get("total_triples", 0)
            if info["triples"] < 3000:
                issues.append(f"트리플 수 급감: {info['triples']} (정상: 4000+)")
        else:
            issues.append("ontology stats 실행 실패")
    except Exception as e:
        issues.append(f"ontology stats 오류: {str(e)[:50]}")

    # Integrity check
    try:
        result = subprocess.run(
            [sys.executable, str(BASE / "scripts" / "ontology_core.py"),
             "--action", "check_integrity"],
            capture_output=True, text=True, timeout=30,
            cwd=str(BASE / "scripts"))
        if result.returncode == 0:
            integrity = json.loads(result.stdout)
            info["integrity_issues"] = integrity.get("total_issues", 0)
    except Exception:
        pass

    return {
        "status": "error" if issues else "ok",
        "issues": issues,
        "info": info,
    }


def check_etf_data():
    """Check ETF data freshness."""
    issues = []
    info = {}

    if not ETF_DATA.exists():
        issues.append("ETF 데이터 디렉토리 없음")
        return {"status": "error", "issues": issues}

    json_files = list(ETF_DATA.glob("*.json"))
    info["etf_files"] = len(json_files)

    if not json_files:
        issues.append("ETF JSON 파일 없음")
    else:
        newest = max(json_files, key=lambda f: f.stat().st_mtime)
        mtime = datetime.fromtimestamp(newest.stat().st_mtime)
        age_hours = (datetime.now() - mtime).total_seconds() / 3600
        info["newest_etf_file"] = newest.name
        info["newest_age_hours"] = round(age_hours, 1)

        if age_hours > 72:
            issues.append(f"ETF 데이터 {age_hours:.0f}시간 미갱신")

    return {
        "status": "error" if issues else "ok",
        "issues": issues,
        "info": info,
    }


def check_cron_jobs():
    """Check cron job health."""
    issues = []
    info = {}

    if not CRON_PATH.exists():
        issues.append("cron/jobs.json 없음")
        return {"status": "error", "issues": issues}

    try:
        data = json.loads(CRON_PATH.read_text(encoding="utf-8"))
        jobs = data.get("jobs", [])
        info["total_jobs"] = len(jobs)
        info["enabled_jobs"] = sum(1 for j in jobs if j.get("enabled", True))

        error_jobs = []
        for j in jobs:
            if not j.get("enabled", True):
                continue
            state = j.get("state", {})
            if state.get("lastStatus") == "error":
                err = state.get("lastError", "unknown")[:60]
                error_jobs.append({"name": j["name"], "error": err})
            # Check consecutive errors
            consec = state.get("consecutiveErrors", 0)
            if consec >= 3:
                issues.append(f"크론 '{j['name']}' 연속 {consec}회 에러")

        if error_jobs:
            info["error_jobs"] = error_jobs

    except Exception as e:
        issues.append(f"cron 설정 읽기 실패: {str(e)[:50]}")

    return {
        "status": "warning" if issues else "ok",
        "issues": issues,
        "info": info,
    }


def check_gateway():
    """Check if OpenClaw gateway is responding."""
    issues = []
    info = {}

    try:
        import urllib.request
        req = urllib.request.Request("http://localhost:18789/",
                                     method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            info["gateway_status"] = resp.status
            info["gateway_ok"] = True
    except Exception as e:
        issues.append(f"게이트웨이 응답 없음: {str(e)[:50]}")
        info["gateway_ok"] = False

    return {
        "status": "error" if issues else "ok",
        "issues": issues,
        "info": info,
    }


def check_disk():
    """Check disk space."""
    issues = []
    info = {}

    try:
        stat = os.statvfs("/Users/ron")
        free_gb = (stat.f_frsize * stat.f_bavail) / (1024 ** 3)
        total_gb = (stat.f_frsize * stat.f_blocks) / (1024 ** 3)
        info["disk_free_gb"] = round(free_gb, 1)
        info["disk_total_gb"] = round(total_gb, 1)
        info["disk_usage_pct"] = round((1 - free_gb / total_gb) * 100, 1)

        if free_gb < 5:
            issues.append(f"디스크 여유 공간 부족: {free_gb:.1f}GB")
    except Exception:
        pass

    return {
        "status": "warning" if issues else "ok",
        "issues": issues,
        "info": info,
    }


def run_fix(results):
    """Attempt automatic fixes for detected issues."""
    fixes = []

    # Fix: re-sync ontology if stale
    ontology = results.get("ontology", {})
    if any("미갱신" in i for i in ontology.get("issues", [])):
        try:
            sync_result = subprocess.run(
                [sys.executable, str(BASE / "scripts" / "sync_ontology.py")],
                capture_output=True, text=True, timeout=120,
                cwd=str(BASE / "scripts"))
            if sync_result.returncode == 0:
                fixes.append("온톨로지 자동 동기화 성공")
            else:
                fixes.append(f"온톨로지 동기화 실패: {sync_result.stderr[:100]}")
        except Exception as e:
            fixes.append(f"동기화 오류: {str(e)[:50]}")

    # Fix: regenerate CONTEXT.md if missing
    ctx_path = BASE / "knowledge" / "CONTEXT.md"
    if not ctx_path.exists() or ctx_path.stat().st_size < 100:
        try:
            subprocess.run(
                [sys.executable, str(BASE / "scripts" / "gen_knowledge_context.py")],
                capture_output=True, text=True, timeout=30,
                cwd=str(BASE / "scripts"))
            fixes.append("CONTEXT.md 재생성")
        except Exception:
            pass

    return fixes


def save_issue_log(results):
    """Save detailed issue log to attachments."""
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = ATTACH_DIR / f"heartbeat_issue_{timestamp}.md"

    lines = [f"# Heartbeat Issue Log ({datetime.now().strftime('%Y-%m-%d %H:%M')})", ""]
    for section, data in results.items():
        if data.get("issues"):
            lines.append(f"## {section}")
            for issue in data["issues"]:
                lines.append(f"- {issue}")
            lines.append("")

    log_path.write_text("\n".join(lines), encoding="utf-8")
    return str(log_path)


def main():
    brief = "--brief" in sys.argv
    fix = "--fix" in sys.argv

    results = {
        "ontology": check_ontology(),
        "etf_data": check_etf_data(),
        "cron": check_cron_jobs(),
        "gateway": check_gateway(),
        "disk": check_disk(),
    }

    # Overall status
    all_issues = []
    for section, data in results.items():
        for issue in data.get("issues", []):
            all_issues.append(f"[{section}] {issue}")

    overall = "ok" if not all_issues else "issues_found"

    if fix and all_issues:
        fixes = run_fix(results)
        results["auto_fixes"] = fixes

    if all_issues:
        log_path = save_issue_log(results)
        results["issue_log"] = log_path

    results["overall_status"] = overall
    results["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    results["total_issues"] = len(all_issues)

    if brief:
        if overall == "ok":
            print("✅ 시스템 정상")
        else:
            print(f"⚠️ {len(all_issues)}건 이상 감지:")
            for issue in all_issues:
                print(f"  {issue}")
            if fix and results.get("auto_fixes"):
                print("자동 복구:")
                for f in results["auto_fixes"]:
                    print(f"  {f}")
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
