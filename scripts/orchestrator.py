#!/usr/bin/env python3
"""
orchestrator.py — 5-Agent 통합 오케스트레이터 v3

=== 제1원칙 ===
"변화가 없으면 행동하지 않는다."
- 시간이 됐다고 무조건 작업을 투입하지 않는다
- 상태 변화/이벤트가 있을 때만 반응한다
- 불필요한 API 호출을 제거한다

=== 아키텍처 변경 (v3, 2026-02-12) ===
Ron 중앙 지휘자 전환:
- Ron LLM(Chat API)이 시스템 컨텍스트를 분석하여 지능적 태스크 생성
- 기존 하드코딩 루틴은 fallback으로만 유지
- Observational Memory (memory_manager.py) 통합
- CoT 검증 파이프라인 (cot_verifier.py) 연동
- 완료 태스크에 대한 Ron LLM 후속 판단

v2 대비 변경:
- check_idle_and_assign() → Ron LLM 호출 우선, 실패 시 hardcoded fallback
- check_completions_and_follow_up() → Ron LLM 후속 판단 추가
- 새 함수: gather_system_context(), call_ron_for_decisions(), parse_ron_response()
- 새 함수: log_observation_if_significant(), run_memory_command()
- 안전장치: 60초 쿨다운, 3회 연속 실패 → 5분 fallback, 큐 상한 6/에이전트 2
"""

import hashlib
import json
import os
import re
import sys
import time
import datetime
import subprocess
import fcntl
import sqlite3
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

try:
    from agent_registry import AGENT_NAMES as _AGENT_NAMES, valid_agents_set, valid_agents_pipe_str
except ImportError:
    sys.path.insert(0, os.path.join(HOME, ".openclaw/workspace/scripts"))
    from agent_registry import AGENT_NAMES as _AGENT_NAMES, valid_agents_set, valid_agents_pipe_str

try:
    from shared.db import db_connection, db_transaction
except ImportError:
    pass

try:
    from shared.log import make_logger as _make_logger
except ImportError:
    _make_logger = None

def get_model_chain(default_model="openclaw:main", include_default=True):
    return [default_model]

def get_primary_model(default_model="openclaw:main"):
    return default_model

HOME = os.path.expanduser("~")
BASE = "http://127.0.0.1:3344"
_BUS_TOKEN_FILE = os.path.join(HOME, ".openclaw", ".bus-token")
_BUS_TOKEN = ""
if os.path.exists(_BUS_TOKEN_FILE):
    with open(_BUS_TOKEN_FILE) as _f:
        _BUS_TOKEN = _f.read().strip()
BUS_DIR = os.path.join(HOME, ".openclaw/workspace/bus")
BUS_FILE = os.path.join(BUS_DIR, "messages.jsonl")
STATE_FILE = os.path.join(BUS_DIR, "orchestrator_state.json")
LOG_FILE = os.path.join(HOME, ".openclaw/workspace/logs/orchestrator.log")
LOCK_FILE = os.path.join(BUS_DIR, ".orchestrator.lock")
OPS_DB = os.path.join(HOME, ".openclaw/data/ops_multiagent.db")  # Fixed: was scripts/ops/ (0-byte file)

# v3: Ron LLM 및 메모리/검증 경로
RON_CHAT_API = "http://127.0.0.1:18789/v1/chat/completions"
RON_CHAT_MODEL = os.environ.get("RON_MODEL", get_primary_model("openclaw:main"))
RON_CHAT_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
# Auto-load from .env if token empty (LaunchAgent env fix)
if not RON_CHAT_TOKEN:
    _env_file = os.path.join(HOME, ".openclaw/.env")
    if os.path.exists(_env_file):
        with open(_env_file) as _ef:
            for _line in _ef:
                if _line.startswith("OPENCLAW_TOKEN="):
                    RON_CHAT_TOKEN = _line.strip().split("=", 1)[1]
                    break
MEMORY_MANAGER = os.path.join(HOME, ".openclaw/workspace/scripts/memory_manager.py")
SELF_EVOLVE_SCRIPT = os.path.join(HOME, ".openclaw/workspace/scripts/self_evolve.py")
COT_VERIFIER = os.path.join(HOME, ".openclaw/workspace/scripts/cot_verifier.py")
RON_STRUCTURE_BRIEF_JSON = os.path.join(HOME, ".openclaw/workspace/knowledge/system/ron_structure_brief.json")
PHILOSOPHY_STRUCTURE_MD = os.path.join(HOME, ".openclaw/workspace/PHILOSOPHY_STRUCTURE.md")
TRIAD_SYNC_SCRIPT = os.path.join(HOME, ".openclaw/workspace/scripts/triad_directive_sync.py")

# v3: Ron LLM 쿨다운/안전 설정
RON_LLM_COOLDOWN_SEC = int(os.environ.get("ORCH_RON_LLM_COOLDOWN_SEC", "900"))
RON_LLM_FALLBACK_SEC = int(os.environ.get("ORCH_RON_LLM_FALLBACK_SEC", "600"))  # 3회 연속 실패 → 10분 fallback
RON_LLM_MAX_FAILURES = int(os.environ.get("ORCH_RON_LLM_MAX_FAILURES", "3"))
RON_LLM_TIMEOUT_SEC = int(os.environ.get("ORCH_RON_LLM_TIMEOUT_SEC", "900"))  # LLM 호출 타임아웃: 15분
RON_LLM_RETRY_MAX = int(os.environ.get("ORCH_RON_LLM_RETRY_MAX", "3"))  # 최대 재시도 횟수
RON_LLM_RETRY_BACKOFF_BASE = int(os.environ.get("ORCH_RON_LLM_RETRY_BACKOFF_BASE", "5"))  # 백오프 기본값(초)
QUEUE_CAP = 6
AGENT_CAP = 2

# 환각 캐스케이드 차단 상수
_WHITELIST_BLOCK_PATTERNS = (
    "blocked: not in whitelist",
    "refused: payload references system path",
    "화이트리스트 필요",
    "화이트리스트 추가 필요",
    "not in whitelist",
)
# LLM/인프라 실패 결과는 follow-up 평가에서 제외 (에이전트가 해결 불가)
_INFRA_FAIL_PATTERNS = (
    "timed out",
    "timeout",
    "empty_response",
    "cooldown",
    "connection refused",
    "econnrefused",
)
_PHANTOM_KEYWORDS = frozenset([
    "포렌식", "증거수집", "증거 수집", "증거 보존", "증거 확보",
    "whitelist_rollback", "롤백 스크립트", "루트 잠금", "앵커 락",
    "DRIFT", "forensic", "evidence collection", "evidence preservation",
    "무결성 점검 결과 검증",
    # v4: 화이트리스트 관련 전면 차단 (에이전트가 스스로 풀 수 없는 보안 정책)
    "화이트리스트",  # 모든 한글 변형 포괄: 차단/변경/복구/적용/복원/배포/요청/추가/문제/항목 등
    "whitelist", "allowlist",  # 영문 변형 포괄
    "안전 래퍼", "안전 배포", "안전 재기동", "openclaw_safe_run",
    "ocw-whitelist", "root_anchor", "sudoers",
    "/etc/openclaw", "/usr/local/bin/openclaw",
    "정책 엔진", "policy engine", "SOP 문서",
])

# v3.1: Rate limiting caps
DAILY_TASK_CAP = 200
HOURLY_TASK_CAP = 80
CYCLE_INTERVAL_SEC = 120
DATA_DB = os.path.join(HOME, ".openclaw/data/ops_multiagent.db")

# v3.4: Global circuit breaker — 시스템 전체 장애 감지
GLOBAL_CB_FAIL_RATE = float(os.environ.get("ORCH_GLOBAL_CB_FAIL_RATE", "0.7"))  # 70%↑ 실패 → 시스템 장애 (기존 60%→70% 상향)
GLOBAL_CB_MIN_CMDS = int(os.environ.get("ORCH_GLOBAL_CB_MIN_CMDS", "10"))       # 최소 10건 이상이어야 판정 (기존 5→10 상향)
GLOBAL_CB_WINDOW_MIN = int(os.environ.get("ORCH_GLOBAL_CB_WINDOW_MIN", "30"))   # 30분 윈도우

# Cowork stall-rescue autopilot tuning.
COWORK_STALE_SEC = int(os.environ.get("ORCH_COWORK_STALE_SEC", "90"))
COWORK_QUEUE_STUCK_SEC = int(os.environ.get("ORCH_COWORK_QUEUE_STUCK_SEC", "180"))
COWORK_RESCUE_COOLDOWN_SEC = int(os.environ.get("ORCH_COWORK_RESCUE_COOLDOWN_SEC", "1800"))
TRIAD_SYNC_INTERVAL_SEC = int(os.environ.get("ORCH_TRIAD_SYNC_INTERVAL_SEC", "300"))

os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

# v3: Ron LLM 시스템 프롬프트
RON_SYSTEM_PROMPT = """너는 Ron, 5-Agent 시스템의 중앙 지휘자다.

## 네 역할
시스템 상태를 분석하고, 에이전트들에게 의미있는 작업을 할당한다.
단순 반복(health check, MCP check 등)이 아닌 실질적 가치를 창출하는 작업을 우선시한다.

## 에이전트별 전문성과 경계 (반드시 준수)
- **ron**: Knowledge OS 운영, 지식 순환, 시스템 통합 관리, 인사이트 수집, 온톨로지 관리
- **codex**: 코딩 전용 — 스크립트 구현/수정/리팩토링, MCP 검증, 문법 검사, 버그 수정. 코드가 포함되지 않는 작업은 절대 codex에 할당하지 말 것
- **cowork**: 아키텍처/정책 전용 — 설계 리뷰, 정책 검토, 전략 제안, 에이전트 조율, 기술 부채 분석. 코드 작성 없이 제안서(proposal) 형태로 출력
- **guardian**: 시스템 수호 전용 — 프로세스 감시, DB 무결성, 크론 일관성, 큐 점검, 설정 드리프트 감지/복구. 실시간 시스템 헬스만 담당
- **data-analyst**: 데이터 분석 전용 — ETF/주식 분석, 섹터 크로스체크, ZK 지식 공백 탐지, 파이프라인 결과 분석

## 라우팅 규칙 (필수)
- 코딩 키워드(구현, 작성, 수정, fix, implement, script, 코드, code, 리팩토, refactor, 패치, patch, 버그) → **codex**만
- 아키텍처/정책/전략/설계/리뷰/조율 키워드 → **cowork**만
- 시스템 점검/헬스/무결성/프로세스/크론/DB 키워드 → **guardian**
- 분석/수치/ETF/conviction/섹터/데이터/지식공백 키워드 → **data-analyst**
- codex에 비코딩 작업을 할당하면 안 됨. cowork에 코드 작성을 할당하면 안 됨

## 규칙
1. 에이전트당 최대 2개 태스크만 생성
2. 총 태스크 수 6개 상한
3. 이미 큐에 있는 작업과 중복되지 않게 할 것
4. 의미없는 작업(단순 상태 확인 반복)은 생성하지 말 것
5. 에이전트 상태가 OFF이면 해당 에이전트에 태스크 할당하지 말 것
6. priority는 실제 긴급도에 맞게: high=즉시필요, normal=일반, low=여유시


## 연구 태스크 (새로운 유형)
- **research**: 지식 공백 조사, 다각도 탐구, ZK 노트 확장
- 연구 태스크는 priority=low로 설정 (운영 태스크 우선)
- 일일 최대 3개까지

## 응답 형식
반드시 아래 JSON 형식으로만 응답하라 (다른 텍스트 없이):
{"tasks": [{"agent": "%s", "title": "작업 제목", "body": "상세 설명", "priority": "low|normal|high"}]}

태스크가 필요없으면: {"tasks": []}
""" % valid_agents_pipe_str()


# ============================================================
# 유틸리티
# ============================================================

if _make_logger:
    log = _make_logger(log_file=LOG_FILE)
else:
    def log(msg):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = "[{}] {}".format(ts, msg)
        print(line)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")

def now_utc():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

def now_ts():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def now_kst():
    """Mac Mini는 KST timezone이므로 datetime.now()가 KST."""
    return datetime.datetime.now()

def _bus_headers(extra=None):
    h = {}
    if _BUS_TOKEN:
        h["X-Ops-Token"] = _BUS_TOKEN
    if extra:
        h.update(extra)
    return h

def jget(path, timeout=10):
    try:
        req = Request(BASE + path, headers=_bus_headers(), method="GET")
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        log("jget error {}: {}".format(path, str(e)[:100]))
        return {}

def jpost(path, payload, timeout=15):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(BASE + path, data=data, headers=_bus_headers({"Content-Type": "application/json"}), method="POST")
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        log("jpost error {}: {}".format(path, str(e)[:100]))
        return {"error": str(e)}


def chat_completion_with_fallback(messages, temperature=0.3, max_tokens=1000, timeout_sec=None):
    """Call chat API with dynamic model chain fallback.
    
    timeout_sec가 None이면 RON_LLM_TIMEOUT_SEC(기본 900초) 사용.
    900초를 초과하는 값은 강제로 900초로 제한(최대 타임아웃 안전장치).
    """
    # 타임아웃 유효성 검증: None이면 기본값, 900초 초과 시 900초로 클램핑
    effective_timeout = min(timeout_sec or RON_LLM_TIMEOUT_SEC, RON_LLM_TIMEOUT_SEC)
    """Call chat API with dynamic model chain fallback."""
    from shared.llm import llm_chat_with_fallback
    model_chain = get_model_chain(default_model=RON_CHAT_MODEL, include_default=False)
    content, used_model, error = llm_chat_with_fallback(
        messages, model_chain, temperature=temperature,
        max_tokens=max_tokens, timeout=effective_timeout,
    )
    if content:
        return content, used_model, ""
    return None, "", error

def bus_write(to, msg_type, body):
    # DM 노이즈 필터: tool error, 짧은 alert 메시지는 로그에만 기록
    if to == "harry" and msg_type == "alert":
        noise_kw = ["tool error", "tool_error", "ToolError", "subprocess", "traceback",
                     "Errno", "ModuleNotFoundError", "FileNotFoundError",
                     "timed out", "timeout", "cooldown", "econnrefused",
                     "empty_response", "connection refused"]
        if any(kw.lower() in body.lower() for kw in noise_kw):
            msg = {"ts": now_utc(), "from": "orchestrator", "to": "log", "type": "filtered_alert", "body": body}
            with open(BUS_FILE, "a") as f:
                f.write(json.dumps(msg) + "\n")
            return  # 사용자에게 노출하지 않음
    msg = {"ts": now_utc(), "from": "orchestrator", "to": to, "type": msg_type, "body": body}
    with open(BUS_FILE, "a") as f:
        f.write(json.dumps(msg) + "\n")

def ops_db_query(sql, params=()):
    """ops_multiagent.db 직접 조회 (heartbeat의 에러 에스컬레이션 흡수)."""
    if not os.path.exists(OPS_DB):
        return []
    try:
        with db_connection(OPS_DB, row_factory=sqlite3.Row) as conn:
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]
    except Exception as e:
        log("ops_db_query error: {}".format(str(e)[:100]))
        return []


# ============================================================
# v3: Observational Memory 헬퍼
# ============================================================

def run_memory_command(cmd, *args):
    """memory_manager.py를 subprocess로 호출."""
    if not os.path.exists(MEMORY_MANAGER):
        return False
    try:
        full_cmd = ["/usr/bin/python3", MEMORY_MANAGER, cmd] + list(args)
        result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            log("memory_manager {} failed: {}".format(cmd, result.stderr[:100]))
            return False
        return True
    except Exception as e:
        log("memory_manager error: {}".format(str(e)[:80]))
        return False


def get_recent_observations(n=10):
    """memory_manager.py recent N 실행하여 최근 관찰 기록 반환."""
    if not os.path.exists(MEMORY_MANAGER):
        return []
    try:
        result = subprocess.run(
            ["/usr/bin/python3", MEMORY_MANAGER, "recent", str(n)],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
        return lines
    except Exception:
        return []


def _load_json_file(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        return {}
    return {}


def _load_root_statement():
    if not os.path.exists(PHILOSOPHY_STRUCTURE_MD):
        return ""
    try:
        with open(PHILOSOPHY_STRUCTURE_MD, "r", encoding="utf-8") as f:
            lines = [ln.strip() for ln in f.readlines() if ln.strip()]
        for ln in lines:
            low = ln.lower()
            if "root" in low and ("why" in low or "목적" in low or "규율" in low):
                return ln[:160]
        return lines[0][:160] if lines else ""
    except Exception:
        return ""


# ============================================================
# 상태 관리
# ============================================================

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {
        "last_run": "",
        "cycle_count": 0,
        "last_health": "",
        "last_knowledge_cycle": "",
        "last_report": "",
        "tasks_generated": 0,
        "last_cowork_rescue": "",
        "last_error_check": "",
        "last_etf_prewarming": "",
        # v3 새 키
        "last_ron_llm_call": "",
        "ron_llm_consecutive_failures": 0,
        "last_ron_llm_fallback_start": "",
        "last_memory_cleanup": "",
        "last_triad_sync": "",
        "last_research_cycle": "",
        "last_evolve_cycle": "",
    }

def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def parse_dt(raw):
    s = str(raw or "").strip()
    if not s:
        return None
    fmts = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
    )
    for fmt in fmts:
        try:
            dt = datetime.datetime.strptime(s, fmt)
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)
            return dt
        except Exception:
            pass
    if s.endswith("Z"):
        try:
            dt = datetime.datetime.fromisoformat(s[:-1] + "+00:00")
            return dt.astimezone().replace(tzinfo=None)
        except Exception:
            return None
    try:
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt
    except Exception:
        return None


def age_sec_from(raw):
    """UTC 타임스탬프와 비교할 때 utcnow() 사용."""
    dt = parse_dt(raw)
    if not dt:
        return None
    return max(0.0, (datetime.datetime.utcnow() - dt).total_seconds())


# ============================================================
# 작업 정의 — v2 루틴 (fallback용 유지)
# ============================================================

RON_ROUTINES = [
    {
        "title": "지식 순환 (run-cycle)",
        "body": "knowledge_os.py run-cycle 실행 → 인사이트 수집 → Obsidian 갱신",
        "interval_minutes": 60,
        "state_key": "last_knowledge_cycle",
        "priority": "normal"
    },
    {
        "title": "헬스 체크",
        "body": "시스템 전체 상태 점검: DB, MCP, 버스, 대시보드, cron",
        "interval_minutes": 120,
        "state_key": "last_health",
        "priority": "normal"
    },
    {
        "title": "오늘의 지식사랑방 인사이트 생성",
        "body": (
            "지식사랑방 텔레그램 데이터로 인사이트를 생성하라.\n"
            "실행 순서:\n"
            "1. → python3 pipeline/discovery_filter.py (최신 데이터 필터)\n"
            "2. → python3 pipeline/hypothesis_engine.py (가설 생성)\n"
            "3. → python3 ontology_core.py --action sector_insights (섹터 교차분석)\n"
            "4. 결과 종합: 투자 인사이트 TOP 3, 섹터 간 교차 시그널, 후속 액션\n"
            "출력: [데이터] [인사이트] [액션] 형식"
        ),
        "interval_minutes": 360,
        "state_key": "last_insight_gen",
        "priority": "normal"
    },
]

CODEX_ROUTINES = [
    {
        "title": "MCP 서버 상태 검증",
        "body": "MCP 4종 서버 상태 체크 + 스킬 유효성 검증",
        "interval_minutes": 120,
        "state_key": "last_mcp_check",
        "priority": "normal"
    },
    {
        "title": "코드 품질 체크",
        "body": "최근 변경 스크립트 문법 검사 + 주요 스크립트 실행 테스트",
        "interval_minutes": 120,
        "state_key": "last_code_check",
        "priority": "normal"
    },
]

COWORK_ROUTINES = [
    {
        "title": "에이전트 조율 리뷰",
        "body": "3에이전트 작업 현황 분석 → 병목/중복 확인 → 조율 제안",
        "interval_minutes": 120,
        "state_key": "last_coordination",
        "priority": "normal"
    },
]


# ── Phase 2: Data Analyst Routines ──
ANALYST_ROUTINES = [
    {"target_agent": "data-analyst", "workflow_id": "etf-analysis",
     "body": "analyst routine (cron managed). Auto-skip.",
     "interval_minutes": 60, "state_key": "last_analyst_0",
     "title": "ETF 섹터 데이터 분석 및 이상치 탐지", "priority": "normal"},
    {"target_agent": "data-analyst", "workflow_id": "stock-crosscheck",
     "body": "analyst routine (cron managed). Auto-skip.",
     "interval_minutes": 60, "state_key": "last_analyst_stock",
     "title": "주식 데이터 크로스체크 및 ZK 공백 확인", "priority": "normal"},
    {"target_agent": "data-analyst", "workflow_id": "sector-correlation",
     "body": "analyst routine (cron managed). Auto-skip.",
     "interval_minutes": 120, "state_key": "last_analyst_1",
     "title": "섹터 간 상관관계 분석", "priority": "low"},
]

# ── Phase 2: Guardian Routines (consolidated from evidence-sentinel, ops-syncer, drift-recovery) ──
GUARDIAN_ROUTINES = [
    {"target_agent": "guardian", "workflow_id": "system-integrity-check",
     "body": "시스템 무결성 점검: 파일 해시, 프로세스 감시, 로그 크기, 큐 동기화, 드리프트 감지.",
     "interval_minutes": 30, "state_key": "last_guardian_integrity",
     "title": "시스템 무결성 및 드리프트 점검", "priority": "normal"},
    {"target_agent": "guardian", "workflow_id": "db-integrity",
     "body": "DB 무결성 점검: ops_multiagent, antfarm. stale 태스크 정리, 상태 갱신.",
     "interval_minutes": 60, "state_key": "last_guardian_db",
     "title": "DB 무결성 점검 및 큐 정리", "priority": "normal"},
]

# 후속 작업 매핑 (fallback용)
FOLLOW_UP_MAP = {
    "지식 순환": {
        "target": "cowork",
        "title": "인사이트 품질 검토",
        "body": "Ron이 수집한 최신 인사이트의 신뢰도/유용성 검토",
        "priority": "low"
    },
    "헬스 체크": {
        "target": "codex",
        "title": "헬스 이슈 대응",
        "body": "헬스 체크에서 발견된 이슈가 있으면 수정 코드 작성",
        "priority": "normal"
    },
}


# ============================================================
# v3: Ron LLM 호출 — 핵심 신규 함수
# ============================================================

def gather_system_context():
    """시스템 상태를 수집하여 Ron LLM에게 전달할 컨텍스트 생성."""
    context = {}

    # 0. ROOT/구조 브리프 (론의 고정축 컨텍스트)
    brief = _load_json_file(RON_STRUCTURE_BRIEF_JSON)
    root = brief.get("root", {}) if isinstance(brief, dict) else {}
    context["root_anchor"] = {
        "locked": True,
        "why": root.get("why") or "ROOT 선언이 방향과 기준을 정하는 규율선언",
        "how": root.get("how") or "제1원칙으로 문제를 분해하고 검증 가능한 방식으로 실행",
        "what": root.get("what") or "기존 SOUL 규칙은 행동을 안정적으로 반복 실행하게 하는 절차",
        "source_context_hash": brief.get("context_hash", ""),
        "statement": _load_root_statement(),
    }
    context["ron_structure_brief"] = {
        "summary": brief.get("summary", ""),
        "transition_phase": brief.get("transition_phase", ""),
        "transition": brief.get("transition", {}),
        "next_actions": brief.get("next_actions", []),
    }

    # 1. 큐 상태
    commands, counts = get_queue_status()
    context["queue"] = {
        "counts": counts,
        "active_tasks": []
    }
    for c in commands:
        if c.get("status") in ("queued", "claimed"):
            context["queue"]["active_tasks"].append({
                "agent": c.get("target_agent", ""),
                "title": c.get("title", "")[:60],
                "status": c.get("status", ""),
                "priority": c.get("priority", "normal"),
            })

    # 2. 에이전트 상태
    agents = get_agent_status()
    context["agents"] = {}
    for key in _AGENT_NAMES:
        a = agents.get(key, {})
        context["agents"][key] = {
            "alive": a.get("alive", False),
            "current_task": (a.get("current_task") or "-")[:50],
            "last_seen_age_sec": age_sec_from(a.get("last_seen")),
        }

    # 3. 최근 완료 태스크 (최대 5개)
    recent_done = []
    for c in commands:
        if c.get("status") == "done":
            recent_done.append({
                "agent": c.get("target_agent", ""),
                "title": c.get("title", "")[:60],
                "result_note": (c.get("result_note") or "")[:100],
                "completed_at": c.get("completed_at", ""),
            })
    context["recent_completions"] = sorted(
        recent_done, key=lambda x: x.get("completed_at", ""), reverse=True
    )[:5]

    # 4. 최근 버스 메시지 (최대 5개)
    try:
        if os.path.exists(BUS_FILE):
            with open(BUS_FILE, "r") as f:
                lines = f.readlines()
            recent_msgs = []
            for line in lines[-10:]:
                try:
                    msg = json.loads(line.strip())
                    if msg.get("type") not in ("system",):
                        recent_msgs.append({
                            "from": msg.get("from", ""),
                            "to": msg.get("to", ""),
                            "type": msg.get("type", ""),
                            "body": str(msg.get("body", ""))[:80],
                        })
                except Exception:
                    pass
            context["recent_bus_messages"] = recent_msgs[-5:]
    except Exception:
        context["recent_bus_messages"] = []

    # 5. Observational Memory 최근 10개
    observations = get_recent_observations(10)
    context["recent_observations"] = observations

    # 6. 현재 시각 (KST)
    context["current_time_kst"] = now_kst().strftime("%Y-%m-%d %H:%M:%S KST")
    context["weekday"] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][now_kst().weekday()]

    return json.dumps(context, ensure_ascii=False, indent=2)


def call_ron_for_decisions(context_str):
    """Ron Chat API를 호출하여 태스크 할당 결정을 받는다.
    
    - 타임아웃 시 graceful failover: exponential backoff 재시도
    - 최대 RON_LLM_RETRY_MAX회 재시도, 백오프 간격은 5초×2^attempt
    - 타임아웃 vs 일반 에러 구분하여 로깅
    """
    messages = [
        {"role": "system", "content": RON_SYSTEM_PROMPT},
        {"role": "user", "content": "현재 시스템 상태:\n" + context_str + "\n\n이 상태를 분석하고 필요한 태스크를 JSON으로 응답하라."},
    ]
    
    last_error = None
    for attempt in range(RON_LLM_RETRY_MAX):
        content, used_model, err = chat_completion_with_fallback(
            messages=messages,
            temperature=0.3,
            max_tokens=1000,
            timeout_sec=None,  # 기본값 RON_LLM_TIMEOUT_SEC(900초) 사용
        )
        if content:
            if attempt > 0:
                log("Ron LLM recovered after {} retry(s), model={}".format(attempt, used_model))
            else:
                log("Ron LLM response received ({} chars, model={})".format(len(content), used_model))
            return content
        
        last_error = err
        # 타임아웃 vs 일반 에러 구분
        is_timeout = err and any(kw in str(err).lower() for kw in ["timeout", "timed out", "_ssl.c", "ssl"])
        error_type = "TIMEOUT" if is_timeout else "ERROR"
        
        if attempt < RON_LLM_RETRY_MAX - 1:
            backoff_sec = RON_LLM_RETRY_BACKOFF_BASE * (2 ** attempt)  # 5s, 10s, 20s
            log("Ron LLM {} (attempt {}/{}), retrying in {}s: {}".format(
                error_type, attempt + 1, RON_LLM_RETRY_MAX, backoff_sec, str(err)[:80]))
            time.sleep(backoff_sec)
        else:
            log("Ron LLM {} exhausted all {} attempts".format(error_type, RON_LLM_RETRY_MAX))
    
    # 모든 재시도 실패
    log("Ron LLM call failed after {} retries: {}".format(RON_LLM_RETRY_MAX, last_error or "no_response"))
    return None


def parse_ron_response(response_text):
    """Ron LLM 응답을 파싱하여 태스크 리스트로 변환."""
    if not response_text:
        return []

    text = response_text.strip()

    # markdown code block 처리
    code_block = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if code_block:
        text = code_block.group(1).strip()

    # JSON 파싱 시도
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # JSON 객체 추출 시도
        json_match = re.search(r'\{[\s\S]*"tasks"[\s\S]*\}', text)
        if json_match:
            try:
                parsed = json.loads(json_match.group(0))
            except json.JSONDecodeError:
                log("Ron LLM response parse failed (regex fallback)")
                return []
        else:
            log("Ron LLM response parse failed (no JSON found)")
            return []

    tasks = parsed.get("tasks", [])
    if not isinstance(tasks, list):
        log("Ron LLM: 'tasks' is not a list")
        return []

    # 유효성 검증 + 안전 캡
    valid_agents = valid_agents_set()
    valid_priorities = {"low", "normal", "high"}
    validated = []
    agent_counts = {}

    for t in tasks:
        if not isinstance(t, dict):
            continue
        agent = t.get("agent", "")
        title = t.get("title", "")
        body = t.get("body", "")
        priority = t.get("priority", "normal")

        if agent not in valid_agents:
            log("Ron LLM: invalid agent '{}', skipping".format(agent))
            continue
        if not title or not body:
            continue
        if priority not in valid_priorities:
            priority = "normal"

        # Layer 2: 환각 키워드 차단
        title_body = (title + " " + body).lower()
        if any(kw.lower() in title_body for kw in _PHANTOM_KEYWORDS):
            log("HALLUCINATION_BLOCKED: '{}' → agent={}".format(title[:50], agent))
            continue

        # 에이전트당 2개 상한
        agent_counts[agent] = agent_counts.get(agent, 0) + 1
        if agent_counts[agent] > AGENT_CAP:
            log("Ron LLM: agent '{}' cap reached, skipping '{}'".format(agent, title[:30]))
            continue

        validated.append({
            "agent": agent,
            "title": title[:80],
            "body": body[:500],
            "priority": priority,
        })

    # 총 6개 상한
    if len(validated) > QUEUE_CAP:
        validated = validated[:QUEUE_CAP]

    return validated


def _call_ron_for_followup(completed_tasks):
    """완료된 태스크의 결과를 Ron에게 보내 후속 작업 필요 여부 판단."""
    if not completed_tasks:
        return []

    # Layer 1: whitelist block / system path refusal / infra failure 결과를 Ron LLM에 보여주지 않음
    completed_tasks = [
        t for t in completed_tasks
        if not any(p in (t.get("result_note") or "").lower() for p in _WHITELIST_BLOCK_PATTERNS)
        and not any(p in (t.get("result_note") or "").lower() for p in _INFRA_FAIL_PATTERNS)
    ]
    if not completed_tasks:
        return []

    summaries = []
    for t in completed_tasks[:5]:
        summaries.append("- [{}] {}: {} → 결과: {}".format(
            t.get("agent", ""),
            t.get("title", "")[:50],
            t.get("body", "")[:60],
            (t.get("result_note") or "완료")[:80],
        ))

    agents_str = valid_agents_pipe_str()
    prompt = (
        "다음은 최근 완료된 태스크들이다. 후속 작업이 필요한지 판단하라.\n\n"
        "완료 태스크:\n{}\n\n"
        '후속 작업이 필요하면 JSON으로 응답:\n'
        '{{"tasks": [{{"agent": "' + agents_str + '", "title": "...", "body": "...", "priority": "low|normal|high"}}]}}\n'
        '필요없으면: {{"tasks": []}}'
    ).format("\n".join(summaries))

    messages = [
        {"role": "system", "content": "너는 Ron, 태스크 완료 후 후속 판단을 하는 지휘자다. 불필요한 후속은 만들지 마라.\n"
         "절대 금지: 포렌식/증거수집/증거보존, whitelist 롤백/예외 추가, "
         "루트 잠금/앵커 락/DRIFT 관련 태스크 생성 금지. "
         "'blocked: not in whitelist'는 정상 보안 동작이다."},
        {"role": "user", "content": prompt},
    ]
    # 재시도/백오프 전략 적용 (graceful failover)
    last_error = None
    for attempt in range(RON_LLM_RETRY_MAX):
        content, used_model, err = chat_completion_with_fallback(
            messages=messages,
            temperature=0.2,
            max_tokens=600,
            timeout_sec=None,  # 기본값 RON_LLM_TIMEOUT_SEC(900초) 사용
        )
        if content:
            if attempt > 0:
                log("Ron followup recovered after {} retry(s), model={}".format(attempt, used_model))
            else:
                log("Ron followup model used: {}".format(used_model))
            return parse_ron_response(content)
        
        last_error = err
        is_timeout = err and any(kw in str(err).lower() for kw in ["timeout", "timed out", "_ssl.c", "ssl"])
        error_type = "TIMEOUT" if is_timeout else "ERROR"
        
        if attempt < RON_LLM_RETRY_MAX - 1:
            backoff_sec = RON_LLM_RETRY_BACKOFF_BASE * (2 ** attempt)
            log("Ron followup {} (attempt {}/{}), retrying in {}s: {}".format(
                error_type, attempt + 1, RON_LLM_RETRY_MAX, backoff_sec, str(err)[:80]))
            time.sleep(backoff_sec)
        else:
            log("Ron followup {} exhausted all {} attempts".format(error_type, RON_LLM_RETRY_MAX))
    
    log("Ron followup LLM call failed after {} retries: {}".format(RON_LLM_RETRY_MAX, last_error or "no_response"))
    return []


# ============================================================
# v3: CoT 검증 연동
# ============================================================

def verify_tasks_with_cot(tasks, context_str):
    """high priority 태스크에 대해 CoT 검증 수행."""
    if not os.path.exists(COT_VERIFIER):
        return tasks  # 검증기 없으면 그대로 통과

    verified = []
    for task in tasks:
        if task.get("priority") != "high":
            verified.append(task)
            continue

        # high priority 태스크만 검증
        try:
            response_text = json.dumps(task, ensure_ascii=False)
            result = subprocess.run(
                ["/usr/bin/python3", COT_VERIFIER, "--verify", response_text, "--json"],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0:
                try:
                    verification = json.loads(result.stdout.strip())
                    confidence = verification.get("confidence_score", 1.0)
                    if confidence >= 0.4:
                        verified.append(task)
                        if confidence < 0.7:
                            log("CoT: task '{}' passed with low confidence {:.2f}".format(
                                task["title"][:30], confidence))
                            run_memory_command("add-medium",
                                "CoT verification low confidence ({:.0f}%) on: {}".format(
                                    confidence * 100, task["title"][:40]))
                    else:
                        log("CoT: task '{}' REJECTED (confidence {:.2f})".format(
                            task["title"][:30], confidence))
                        run_memory_command("add-medium",
                            "CoT verification rejected task: {} (confidence {:.0f}%)".format(
                                task["title"][:40], confidence * 100))
                except json.JSONDecodeError:
                    verified.append(task)  # 파싱 실패 → 통과
            else:
                verified.append(task)  # 검증기 실패 → 통과
        except Exception as e:
            log("CoT verification error: {}".format(str(e)[:200]))
            verified.append(task)  # 오류 → 통과 (안전)

    return verified


# ============================================================
# heartbeat.py에서 흡수한 기능
# ============================================================

def check_error_escalation(state):
    """
    [heartbeat 흡수] 에러 에스컬레이션 모니터링.
    ops_multiagent.db에서 최근 1시간 에러 3회 이상 시 ron에게 자가치유 지시.
    """
    if not is_interval_passed(state, "last_error_check", 30):
        return 0

    state["last_error_check"] = now_ts()
    rows = ops_db_query(
        "SELECT count(*) as cnt FROM ops_agent_events "
        "WHERE event_type='error' "
        "AND created_at > datetime('now','localtime','-1 hour')"
    )
    if not rows or rows[0].get("cnt", 0) < 3:
        return 0

    error_count = rows[0]["cnt"]
    log("Error escalation triggered: {} errors in last hour".format(error_count))

    commands, _ = get_queue_status()
    if queue_has_title(commands, "에러 에스컬레이션"):
        return 0

    if create_task(
        "ron",
        "에러 에스컬레이션 대응",
        "최근 1시간 내 에러 {}회 발생. ops_agent_events에서 에러를 분석하고 자가 치유 수행.".format(error_count),
        "high"
    ):
        bus_write("harry", "alert",
                  "[오케스트레이터] 에러 에스컬레이션: 최근 1시간 에러 {}회 → ron 자가치유 투입".format(error_count))
        run_memory_command("add-critical",
            "Error escalation: {} errors in 1h, auto-healing triggered".format(error_count))
        return 1
    return 0


def check_etf_prewarming(state):
    """
    [heartbeat 흡수] ETF 데이터 예열.
    gateway cron ETF 리포트 실행 전에 ron에게 데이터 수집 지시.

    실행 조건:
    - 국내: Mon-Fri 16:50 (gateway etf-domestic-daily 17:00 전)
    - 해외: Tue-Sat 07:50 (gateway etf-global 22:30에 대비)
    """
    n = now_kst()
    weekday = n.weekday()  # 0=Mon, 6=Sun
    hour, minute = n.hour, n.minute

    trigger_name = None
    prompt = None

    # 국내 ETF: Mon-Fri 16:50
    if weekday < 5 and hour == 16 and 45 <= minute <= 55:
        trigger_name = "etf_domestic_prewarming"
        prompt = "ETF 국내 시장 데이터 프리워밍을 시작해줘. 오늘의 국내 ETF 시세와 변동률을 수집해."

    # 해외 ETF: Tue-Sat 07:50 (weekday 1-5 → Tue-Sat)
    elif weekday in (1, 2, 3, 4, 5) and hour == 7 and 45 <= minute <= 55:
        trigger_name = "etf_global_prewarming"
        prompt = "ETF 해외 시장 데이터 프리워밍을 시작해줘. 해외 ETF 배분과 테마 데이터를 수집해."

    if not trigger_name:
        return 0

    # 중복 방지: 같은 trigger가 10분 내 실행됐으면 스킵
    last = state.get("last_etf_prewarming", "")
    if last:
        try:
            last_dt = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
            if (datetime.datetime.now() - last_dt).total_seconds() < 600:
                return 0
        except Exception:
            pass

    commands, _ = get_queue_status()
    if queue_has_title(commands, "ETF"):
        return 0

    if create_task(
        "ron",
        "ETF 데이터 예열 ({})".format(trigger_name),
        prompt,
        "normal"
    ):
        state["last_etf_prewarming"] = now_ts()
        log("ETF prewarming triggered: {}".format(trigger_name))
        return 1
    return 0


# ============================================================
# 핵심 로직
# ============================================================

def get_queue_status():
    data = jget("/api/bus/command-queue?limit=200")
    commands = data.get("commands", [])
    counts = data.get("counts", {})
    return commands, counts

def get_agent_status():
    data = jget("/api/bus/agents")
    agents = {}
    for a in data.get("agents", []):
        agents[a.get("agent", "")] = a
    return agents

def is_interval_passed(state, key, minutes):
    last = state.get(key, "")
    if not last:
        return True
    try:
        last_dt = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
        return (datetime.datetime.now() - last_dt).total_seconds() > minutes * 60
    except (ValueError, TypeError):
        return True


def is_interval_passed_sec(state, key, seconds):
    last = state.get(key, "")
    if not last:
        return True
    try:
        last_dt = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
        return (datetime.datetime.now() - last_dt).total_seconds() > float(seconds)
    except Exception:
        return True


def run_triad_directive_sync(state):
    """Harry 직접 지시를 triad 공통 컨텍스트로 동기화."""
    if not os.path.exists(TRIAD_SYNC_SCRIPT):
        return 0
    if not is_interval_passed_sec(state, "last_triad_sync", TRIAD_SYNC_INTERVAL_SEC):
        return 0

    state["last_triad_sync"] = now_ts()
    try:
        r = subprocess.run(
            [
                "/usr/bin/python3",
                TRIAD_SYNC_SCRIPT,
                "--source", "orchestrator",
                "--emit-queue",
                "--stale-sec", str(COWORK_STALE_SEC),
            ],
            capture_output=True,
            text=True,
            timeout=35,
        )
        if r.returncode != 0:
            log("triad-sync failed rc={} err={}".format(r.returncode, (r.stderr or "")[:140]))
            return 0
        raw = (r.stdout or "").strip()
        if not raw:
            return 0

        try:
            info = json.loads(raw)
        except Exception:
            try:
                info = json.loads(raw.splitlines()[-1])
            except Exception:
                log("triad-sync output parse failed: {}".format(raw[:140]))
                return 0

        fanout = int(info.get("fanout_created", 0))
        changed = bool(info.get("changed", False))
        dm_sent = bool(info.get("dm_sent", False))
        digest = str(info.get("digest_short", ""))
        if changed or fanout > 0 or dm_sent:
            log("triad-sync digest={} changed={} fanout={} dm={}".format(
                digest, int(changed), fanout, int(dm_sent)
            ))
            run_memory_command(
                "add-low",
                "Triad sync digest={} changed={} fanout={} dm={}".format(
                    digest, int(changed), fanout, int(dm_sent)
                ),
            )
        return fanout
    except Exception as e:
        log("triad-sync exception: {}".format(str(e)[:140]))
        return 0

def create_task(target, title, body, priority="normal"):
    # Rate limit: daily/hourly caps
    try:
        _throttle_db = DATA_DB if os.path.exists(DATA_DB) else OPS_DB
        with db_connection(_throttle_db, row_factory=sqlite3.Row) as _tconn:
            hourly = [dict(r) for r in _tconn.execute(
                "SELECT COUNT(*) as cnt FROM bus_commands "
                "WHERE created_at > datetime('now','localtime','-1 hour') "
                "AND status NOT IN ('failed','cancelled')"
            ).fetchall()]
            if hourly and int(hourly[0].get("cnt", 0)) >= HOURLY_TASK_CAP:
                log("THROTTLE: hourly cap {} reached, skip: {}".format(HOURLY_TASK_CAP, str(title)[:40]))
                return False
            daily = [dict(r) for r in _tconn.execute(
                "SELECT COUNT(*) as cnt FROM bus_commands "
                "WHERE created_at > date('now','start of day','localtime')"
            ).fetchall()]
            if daily and int(daily[0].get("cnt", 0)) >= DAILY_TASK_CAP:
                log("THROTTLE: daily cap {} reached, skip: {}".format(DAILY_TASK_CAP, str(title)[:40]))
                return False
    except Exception:
        pass
    result = jpost("/api/bus/command-queue/create", {
        "title": title,
        "body": body,
        "target_agent": target,
        "requested_by": "orchestrator",
        "priority": priority
    })
    if result.get("error"):
        log("FAIL create task: {} → {}".format(target, title))
        return False
    log("QUEUED: {} → {} [{}]".format(target, title, priority))
    return True

def queue_has_title(commands, title_prefix):
    for c in commands:
        if c.get("status") not in ("queued", "claimed"):
            continue
        t = str(c.get("title") or "")
        if t.startswith(title_prefix[:15]):
            return True
    # Also check recently completed tasks (within 60 min) to avoid rapid re-creation
    try:
        _qdb = DATA_DB if os.path.exists(DATA_DB) else OPS_DB
        with db_connection(_qdb, row_factory=sqlite3.Row) as _qconn:
            prefix_like = str(title_prefix[:15]).replace("'", "''") + "%"
            recent_done = _qconn.execute(
                "SELECT COUNT(*) as cnt FROM bus_commands WHERE status='done' "
                "AND title LIKE ? AND completed_at > datetime('now','localtime','-60 minutes')",
                (prefix_like,)
            ).fetchone()
            if recent_done and int(dict(recent_done).get("cnt", 0)) > 0:
                return True
    except Exception:
        pass
    return False


# ============================================================
# Cowork 정체 감지 + 자동 복구
# ============================================================

def check_cowork_stall_and_rescue(state):
    agents = get_agent_status()
    commands, _ = get_queue_status()
    cowork = agents.get("cowork", {})

    stale_reason = None
    if not cowork.get("alive"):
        stale_reason = "cowork alive=false"
    else:
        last_seen_age = age_sec_from(cowork.get("last_seen"))
        if last_seen_age is not None and last_seen_age > COWORK_STALE_SEC:
            stale_reason = "cowork last_seen stale {:.0f}s".format(last_seen_age)

    cowork_pending = [
        c for c in commands
        if c.get("target_agent") == "cowork" and c.get("status") in ("queued", "claimed")
    ]
    stuck_reason = None
    if cowork_pending:
        oldest = 0.0
        for row in cowork_pending:
            stamp = row.get("claimed_at") or row.get("updated_at") or row.get("created_at")
            age = age_sec_from(stamp)
            if age is None:
                continue
            oldest = max(oldest, age)
        if oldest > COWORK_QUEUE_STUCK_SEC:
            stuck_reason = "cowork queue stuck {:.0f}s ({} pending)".format(oldest, len(cowork_pending))

    reason = stale_reason or stuck_reason
    if not reason:
        return 0

    # 쿨다운: 30분
    if not is_interval_passed(state, "last_cowork_rescue", COWORK_RESCUE_COOLDOWN_SEC / 60):
        return 0

    codex_title = "코워크 정지 대응 (자동 대체 실행)"
    ron_title = "코워크 정지 대응 (운영 안정화)"
    if queue_has_title(commands, codex_title) or queue_has_title(commands, ron_title):
        return 0

    created = 0
    if create_task("codex", codex_title,
                   "원인: {}. 코워크 담당 작업을 codex가 임시 대행하여 계획/조율안 생성 후 버스에 보고".format(reason), "high"):
        created += 1
    if create_task("ron", ron_title,
                   "원인: {}. 큐 정리/상태 스냅샷/지식 동기화를 실행해 시스템 연속성 유지".format(reason), "high"):
        created += 1

    if created > 0:
        state["last_cowork_rescue"] = now_ts()
        bus_write("harry", "report",
                  "[오토파일럿] 코워크 정체 감지({}) → codex/ron 대체 실행 투입".format(reason))
        log("Cowork rescue triggered: {}".format(reason))
        run_memory_command("add-critical",
            "Cowork stall detected ({}), rescue triggered".format(reason[:60]))
    return created


# ============================================================
# v3: Ron LLM 기반 지능적 태스크 배정
# ============================================================


def _cleanup_old_commands():
    """Archive completed bus_commands older than 2 hours."""
    try:
        _db = DATA_DB if os.path.exists(DATA_DB) else OPS_DB
        if not os.path.exists(_db):
            return 0
        with db_transaction(_db) as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS bus_commands_archive ("
                "id INTEGER PRIMARY KEY, title TEXT, body TEXT, "
                "requested_by TEXT, target_agent TEXT, "
                "status TEXT, priority TEXT, "
                "claimed_by TEXT, result_note TEXT, "
                "created_at TEXT, updated_at TEXT, "
                "claimed_at TEXT, completed_at TEXT, "
                "archived_at TEXT DEFAULT CURRENT_TIMESTAMP)"
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON bus_commands_archive(archived_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_archive_status_target ON bus_commands_archive(status, target_agent)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_type_created ON ops_agent_memory(memory_type, created_at)")
            conn.execute(
                "INSERT OR IGNORE INTO bus_commands_archive "
                "(id,title,body,requested_by,target_agent,status,priority,"
                "claimed_by,result_note,created_at,updated_at,claimed_at,completed_at) "
                "SELECT id,title,body,requested_by,target_agent,status,priority,"
                "claimed_by,result_note,created_at,updated_at,claimed_at,completed_at "
                "FROM bus_commands "
                "WHERE status IN ('done','cancelled','failed') "
                "AND created_at < datetime('now','localtime','-2 hours')"
            )
            deleted = conn.execute(
                "DELETE FROM bus_commands "
                "WHERE status IN ('done','cancelled','failed') "
                "AND created_at < datetime('now','localtime','-2 hours')"
            ).rowcount

            # Prune archive older than 30 days
            pruned_archive = conn.execute(
                "DELETE FROM bus_commands_archive "
                "WHERE archived_at < datetime('now','localtime','-30 days')"
            ).rowcount

            # Prune events older than 30 days
            try:
                pruned_events = conn.execute(
                    "DELETE FROM ops_agent_events "
                    "WHERE created_at < datetime('now','localtime','-30 days')"
                ).rowcount
            except Exception:
                pruned_events = 0  # table may not exist

            # Prune ops_agent_memory older than 14 days
            try:
                pruned_mem = conn.execute(
                    "DELETE FROM ops_agent_memory "
                    "WHERE created_at < datetime('now','localtime','-14 days')"
                ).rowcount
            except Exception:
                pruned_mem = 0

        if deleted > 0:
            log("Cleanup: archived {} old completed commands".format(deleted))
        if pruned_archive > 0:
            log("Cleanup: pruned {} old archive entries (>30d)".format(pruned_archive))
        if pruned_events > 0:
            log("Cleanup: pruned {} old events (>30d)".format(pruned_events))
        if pruned_mem > 0:
            log("Cleanup: pruned {} old agent_memory entries (>14d)".format(pruned_mem))
        return deleted
    except Exception as e:
        log("Cleanup error: {}".format(str(e)[:80]))
        return 0


def _tasks_at_cap():
    """Pre-check: daily/hourly task caps BEFORE calling Ron LLM.
    
    Returns (at_cap: bool, reason: str).
    This prevents wasting LLM quota when caps are already reached.
    The existing cap check in create_task() remains as a safety net.
    """
    try:
        _db = DATA_DB if os.path.exists(DATA_DB) else OPS_DB
        if not os.path.exists(_db):
            return False, ""
        with db_connection(_db, row_factory=sqlite3.Row) as conn:
            # Hourly cap check
            hourly_row = conn.execute(
                "SELECT COUNT(*) as cnt FROM bus_commands "
                "WHERE created_at > datetime('now','localtime','-1 hour') "
                "AND status NOT IN ('failed','cancelled')"
            ).fetchone()
            hourly_count = int(dict(hourly_row).get("cnt", 0)) if hourly_row else 0
            if hourly_count >= HOURLY_TASK_CAP:
                return True, "hourly cap {}/{}".format(hourly_count, HOURLY_TASK_CAP)

            # Daily cap check
            daily_row = conn.execute(
                "SELECT COUNT(*) as cnt FROM bus_commands "
                "WHERE created_at > date('now','start of day','localtime')"
            ).fetchone()
            daily_count = int(dict(daily_row).get("cnt", 0)) if daily_row else 0
            if daily_count >= DAILY_TASK_CAP:
                return True, "daily cap {}/{}".format(daily_count, DAILY_TASK_CAP)

        return False, ""
    except Exception as e:
        log("_tasks_at_cap check error: {}".format(str(e)[:80]))
        return False, ""


def _is_ron_llm_available(state):
    """Ron LLM 호출 가능 여부 (쿨다운, 연속 실패 체크)."""
    # 쿨다운 체크
    last_call = state.get("last_ron_llm_call", "")
    if last_call:
        try:
            last_dt = datetime.datetime.strptime(last_call, "%Y-%m-%d %H:%M:%S")
            elapsed = (datetime.datetime.now() - last_dt).total_seconds()
            if elapsed < RON_LLM_COOLDOWN_SEC:
                return False
        except Exception:
            pass

    # 연속 실패 fallback 체크
    failures = state.get("ron_llm_consecutive_failures", 0)
    if failures >= RON_LLM_MAX_FAILURES:
        fallback_start = state.get("last_ron_llm_fallback_start", "")
        if fallback_start:
            try:
                fb_dt = datetime.datetime.strptime(fallback_start, "%Y-%m-%d %H:%M:%S")
                if (datetime.datetime.now() - fb_dt).total_seconds() < RON_LLM_FALLBACK_SEC:
                    return False
                else:
                    # fallback 시간 만료 → 재시도
                    state["ron_llm_consecutive_failures"] = 0
                    state["last_ron_llm_fallback_start"] = ""
            except Exception:
                state["ron_llm_consecutive_failures"] = 0

    return True


def _check_idle_hardcoded(state):
    """기존 v2 하드코딩 루틴 (Ron LLM fallback용)."""
    commands, counts = get_queue_status()
    queued = counts.get("queued", 0)

    if queued >= QUEUE_CAP:
        log("Queue has {} queued tasks, skipping (hardcoded fallback)".format(queued))
        return 0

    generated = 0
    agent_routines = [
        ("ron", RON_ROUTINES),
        ("codex", CODEX_ROUTINES),
        ("cowork", COWORK_ROUTINES),
        ("guardian", GUARDIAN_ROUTINES),
        ("data-analyst", ANALYST_ROUTINES),
    ]

    for agent, routines in agent_routines:
        agent_queued = len([c for c in commands
                           if c.get("target_agent") == agent
                           and c.get("status") in ("queued", "claimed")])
        if agent_queued >= AGENT_CAP:
            continue

        for routine in routines:
            if agent_queued >= AGENT_CAP:
                break
            if is_interval_passed(state, routine["state_key"], routine["interval_minutes"]):
                existing = [c for c in commands
                           if c.get("title", "").startswith(routine["title"][:15])
                           and c.get("status") in ("queued", "claimed")]
                if not existing:
                    if create_task(agent, routine["title"], routine["body"], routine["priority"]):
                        state[routine["state_key"]] = now_ts()
                        generated += 1
                        agent_queued += 1

    if generated > 0:
        log("Using fallback hardcoded routines: {} tasks".format(generated))

    return generated


def check_idle_and_assign(state):
    """v3: Ron LLM으로 태스크 생성, 실패 시 hardcoded fallback."""
    commands, counts = get_queue_status()
    queued = counts.get("queued", 0)

    if queued >= QUEUE_CAP:
        log("Queue has {} queued tasks, skipping".format(queued))
        return 0

    # 시스템 장애 구간에서는 추가 LLM 태스크 생성을 멈춰 사용자 응답 lane을 우선 확보
    if _is_system_degraded():
        log("SKIP LLM: system degraded")
        return 0

    # Pre-check: daily/hourly cap BEFORE calling Ron LLM (avoid wasting quota)
    at_cap, cap_reason = _tasks_at_cap()
    if at_cap:
        log("SKIP LLM: {} -- no tasks can be created".format(cap_reason))
        return 0

    # Ron LLM 호출 가능 여부 체크
    if not _is_ron_llm_available(state):
        return _check_idle_hardcoded(state)

    # Ron LLM 호출
    state["last_ron_llm_call"] = now_ts()
    context_str = gather_system_context()
    response = call_ron_for_decisions(context_str)

    if response is None:
        # 실패 처리
        failures = state.get("ron_llm_consecutive_failures", 0) + 1
        state["ron_llm_consecutive_failures"] = failures
        if failures >= RON_LLM_MAX_FAILURES:
            state["last_ron_llm_fallback_start"] = now_ts()
            log("Ron LLM: {} consecutive failures, entering {}s fallback mode".format(
                failures, RON_LLM_FALLBACK_SEC))
            run_memory_command("add-medium",
                "Ron LLM entered fallback mode after {} consecutive failures".format(failures))
        return _check_idle_hardcoded(state)

    # 성공 → 연속 실패 카운터 리셋
    state["ron_llm_consecutive_failures"] = 0
    state["last_ron_llm_fallback_start"] = ""

    # 응답 파싱
    tasks = parse_ron_response(response)
    if not tasks:
        log("Ron LLM: no tasks needed (or parse failed)")
        return 0

    # CoT 검증 (high priority만)
    tasks = verify_tasks_with_cot(tasks, context_str)

    # 중복 체크 + 태스크 생성
    generated = 0
    for task in tasks:
        agent = task["agent"]

        # 현재 큐에서 에이전트별 태스크 수 체크
        agent_queued = len([c for c in commands
                           if c.get("target_agent") == agent
                           and c.get("status") in ("queued", "claimed")])
        if agent_queued >= AGENT_CAP:
            log("Ron LLM: agent '{}' already has {} tasks, skipping".format(agent, agent_queued))
            continue

        # 중복 방지 (title prefix 15자 매칭)
        if queue_has_title(commands, task["title"]):
            log("Ron LLM: duplicate title '{}', skipping".format(task["title"][:30]))
            continue

        if create_task(agent, task["title"], task["body"], task["priority"]):
            generated += 1

    if generated > 0:
        log("Ron LLM generated {} tasks".format(generated))
        # 에이전트별 카운트
        agent_summary = {}
        for t in tasks:
            agent_summary[t["agent"]] = agent_summary.get(t["agent"], 0) + 1
        summary_str = ", ".join("{}={}".format(k, v) for k, v in agent_summary.items())
        run_memory_command("add-medium",
            "Ron LLM generated {} tasks ({})".format(generated, summary_str))

    return generated


def check_completions_and_follow_up(state):
    """v3: 완료 태스크를 Ron LLM에게 보내 후속 판단, 실패 시 FOLLOW_UP_MAP fallback."""
    commands, counts = get_queue_status()
    generated = 0
    last_check = state.get("last_completion_check", "")

    # 새로 완료된 태스크 수집
    new_completions = []
    for cmd in commands:
        if cmd.get("status") != "done":
            continue
        completed_at = cmd.get("completed_at") or ""
        if completed_at <= last_check:
            continue
        new_completions.append(cmd)

    if not new_completions:
        done_times = [cmd.get("completed_at") or "" for cmd in commands if cmd.get("status") == "done"]
        if done_times:
            state["last_completion_check"] = max(done_times)
        return 0

    # 시스템 장애 구간에서는 후속 LLM 호출을 멈춰 lane 혼잡을 방지
    if _is_system_degraded():
        done_times = [cmd.get("completed_at") or "" for cmd in commands if cmd.get("status") == "done"]
        if done_times:
            state["last_completion_check"] = max(done_times)
        log("SKIP follow-up LLM: system degraded")
        return 0

    # Pre-check: daily/hourly cap BEFORE calling follow-up LLM (avoid wasting quota)
    at_cap, cap_reason = _tasks_at_cap()
    if at_cap:
        log("SKIP follow-up LLM: {} -- no tasks can be created".format(cap_reason))
        done_times = [cmd.get("completed_at") or "" for cmd in commands if cmd.get("status") == "done"]
        if done_times:
            state["last_completion_check"] = max(done_times)
        return 0


    # Ron LLM으로 후속 판단 시도
    if _is_ron_llm_available(state):
        followup_tasks = _call_ron_for_followup(new_completions)
        if followup_tasks:
            for task in followup_tasks:
                agent_queued = len([c for c in commands
                                   if c.get("target_agent") == task["agent"]
                                   and c.get("status") in ("queued", "claimed")])
                if agent_queued >= AGENT_CAP:
                    continue
                if not queue_has_title(commands, task["title"]):
                    if create_task(task["agent"], task["title"], task["body"], task["priority"]):
                        generated += 1
            if generated > 0:
                log("Ron LLM follow-up: {} tasks from {} completions".format(
                    generated, len(new_completions)))
                done_times = [cmd.get("completed_at") or "" for cmd in commands if cmd.get("status") == "done"]
                if done_times:
                    state["last_completion_check"] = max(done_times)
                return generated

    # Fallback: 기존 FOLLOW_UP_MAP 사용
    for cmd in new_completions:
        title = cmd.get("title", "")
        for keyword, follow_up in FOLLOW_UP_MAP.items():
            if keyword in title:
                existing = [c for c in commands
                           if c.get("title", "").startswith(follow_up["title"][:15])
                           and c.get("status") in ("queued", "claimed")]
                if not existing:
                    if create_task(follow_up["target"], follow_up["title"],
                                  follow_up["body"], follow_up["priority"]):
                        generated += 1
                break

    done_times = [cmd.get("completed_at", "") for cmd in commands if cmd.get("status") == "done"]
    if done_times:
        state["last_completion_check"] = max(done_times)

    return generated


# ============================================================
# v3.2: self_evolve 제안 → 태스크 생성 루프
# ============================================================

EVOLVE_AGENT_MAP = {
    "insight_quality": "cowork",
    "workflow_reliability": "codex",
    "self_development": "ron",
    "communication": "cowork",
    "general": "ron",
}

def run_self_evolve_cycle(state):
    """self_evolve.py의 개선 제안을 읽고 high/medium을 태스크로 변환."""
    if not os.path.exists(SELF_EVOLVE_SCRIPT):
        return 0
    if not is_interval_passed(state, "last_evolve_cycle", 120):  # 2시간 간격
        return 0

    state["last_evolve_cycle"] = now_ts()
    try:
        r = subprocess.run(
            ["/usr/bin/python3", SELF_EVOLVE_SCRIPT, "suggest"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            log("self_evolve suggest failed: {}".format((r.stderr or "")[:100]))
            return 0
        suggestions = json.loads(r.stdout.strip())
    except Exception as e:
        log("self_evolve cycle error: {}".format(str(e)[:80]))
        return 0

    created = 0
    for s in suggestions:
        prio = s.get("priority", "low")
        if prio not in ("high", "medium"):
            continue
        area = s.get("area", "general")
        agent = EVOLVE_AGENT_MAP.get(area, "ron")
        suggestion_text = s.get("suggestion", "")
        metric = s.get("metric")
        title = "자기진화: {}".format(suggestion_text[:60])
        body = (
            "자기진화 엔진(self_evolve.py)이 감지한 개선 필요 항목:\n"
            "영역: {}\n우선순위: {}\n제안: {}\n현재 메트릭: {}\n\n"
            "제1원칙에 따라 근본 원인을 분석하고, 구체적 실행 계획과 검증 방법을 포함하여 해결하라."
        ).format(area, prio, suggestion_text, metric)
        task_prio = "high" if prio == "high" else "normal"
        if create_task(agent, title, body, priority=task_prio):
            created += 1
            log("EVOLVE: {} → {} [{}]".format(area, agent, task_prio))

    if created > 0:
        run_memory_command("add-low",
            "Self-evolve cycle: {} improvement tasks created".format(created))
    return created


# ============================================================
# v3: 관찰 기록 (Observational Memory)
# ============================================================

def log_observation_if_significant(state, cycle_stats):
    """매 사이클마다 유의미한 이벤트가 있으면 Observational Memory에 기록."""
    total = sum(cycle_stats.values())

    # 태스크가 생성됐을 때만 기록 (노이즈 방지)
    if total == 0:
        return

    parts = []
    if cycle_stats.get("follow_ups", 0) > 0:
        parts.append("follow-up={}".format(cycle_stats["follow_ups"]))
    if cycle_stats.get("rescues", 0) > 0:
        parts.append("rescue={}".format(cycle_stats["rescues"]))
    if cycle_stats.get("ron_llm", 0) > 0:
        parts.append("ron-llm={}".format(cycle_stats["ron_llm"]))
    if cycle_stats.get("errors", 0) > 0:
        parts.append("error-esc={}".format(cycle_stats["errors"]))
    if cycle_stats.get("reactive", 0) > 0:
        parts.append("reactive={}".format(cycle_stats["reactive"]))
    if cycle_stats.get("etf", 0) > 0:
        parts.append("etf={}".format(cycle_stats["etf"]))
    if cycle_stats.get("triad", 0) > 0:
        parts.append("triad={}".format(cycle_stats["triad"]))

    if parts:
        detail = ", ".join(parts)
        run_memory_command("add-low",
            "Cycle #{}: {} tasks generated ({})".format(
                state.get("cycle_count", 0), total, detail))

    # 매 20 사이클마다 메모리 정리
    cycle = state.get("cycle_count", 0)
    if cycle > 0 and cycle % 20 == 0:
        if is_interval_passed(state, "last_memory_cleanup", 30):
            run_memory_command("cleanup")
            state["last_memory_cleanup"] = now_ts()
            log("Memory cleanup executed (cycle #{})".format(cycle))


# ============================================================
# 보고서
# ============================================================



# ============================================================
# v3.3: Reactive Feedback Loop (ALERT + Failed Retry + Reports)
# ============================================================

def _is_system_degraded():
    """글로벌 서킷브레이커: 최근 N분 커맨드 실패율이 임계치 이상이면 True."""
    try:
        with db_connection(DATA_DB) as conn:
            c = conn.cursor()
            c.execute("""SELECT
                            COUNT(*) AS total,
                            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                         FROM bus_commands
                         WHERE created_at > datetime('now', ? || ' minutes')""",
                      (f"-{GLOBAL_CB_WINDOW_MIN}",))
            row = c.fetchone()
            total, failed = row[0] or 0, row[1] or 0
        if total >= GLOBAL_CB_MIN_CMDS and (failed / total) >= GLOBAL_CB_FAIL_RATE:
            log(f"[GLOBAL-CB] System degraded: {failed}/{total} failed in {GLOBAL_CB_WINDOW_MIN}min")
            return True
    except Exception as e:
        log(f"[GLOBAL-CB] Check error: {e}")
    return False


def _check_and_react(state):
    """Ron's reactive feedback loop: check alerts, retry failures, scan reports.

    This runs every cycle and uses LOCAL DB queries only (no LLM calls).
    Returns number of tasks created. Max 5 tasks per cycle to avoid flooding.
    """
    # v3.4: 글로벌 시스템 장애 시 reactive loop 일시 중지
    if _is_system_degraded():
        return 0

    created = 0
    MAX_REACTIVE = 5

    # 1. ALERT events: check ops_agent_events for unhandled alerts (last 15 min)
    created += _react_to_alerts(state)
    if created >= MAX_REACTIVE:
        return created

    # 2. Failed commands: auto-retry (max 1 retry; file-not-found exempt)
    created += _retry_failed_commands(state)
    if created >= MAX_REACTIVE:
        return created

    # 3. Specialist report scan: check recent reports for actionable findings
    created += _scan_specialist_reports(state)

    return min(created, MAX_REACTIVE)


def _react_to_alerts(state):
    """Check ops_agent_events for error/alert events and dispatch reactive commands."""
    if not is_interval_passed(state, "last_alert_react", 5):  # Check every 5 min
        return 0

    state["last_alert_react"] = now_ts()
    created = 0

    # Get recent error events (last 15 min, excluding autopilot cron_errors which are noise)
    rows = ops_db_query(
        "SELECT agent, event_type, event_data, created_at FROM ops_agent_events "
        "WHERE event_type IN ('error', 'alert') "
        "AND agent NOT IN ('autopilot') "
        "AND created_at > datetime('now','localtime','-15 minutes') "
        "ORDER BY created_at DESC LIMIT 10"
    )

    if not rows:
        return 0

    # Group by agent to avoid spam
    agent_alerts = {}
    for row in rows:
        agent = row.get("agent", "unknown")
        if agent not in agent_alerts:
            agent_alerts[agent] = []
        agent_alerts[agent].append(row)

    commands, _ = get_queue_status()

    # Infrastructure error patterns that agents cannot fix — skip REACT
    _INFRA_NOISE = (
        "timed out", "AGENT_TIMEOUT", "timeout", "429", "rate limit",
        "cooldown", "FailoverError", "ECONNREFUSED", "ECONNRESET",
        "services stopped", "File integrity",
    )

    for agent, alerts in agent_alerts.items():
        # Skip if already have a reactive task for this agent
        react_title_prefix = "[REACT] {}".format(agent)
        if queue_has_title(commands, react_title_prefix):
            continue

        # Parse first alert for details
        alert_data = alerts[0].get("event_data", "{}")
        try:
            data = json.loads(alert_data) if isinstance(alert_data, str) else alert_data
        except Exception:
            data = {"raw": str(alert_data)[:200]}

        alert_msg = data.get("message", str(data)[:150])

        # Skip infrastructure errors that agents can't fix
        if any(noise in alert_msg for noise in _INFRA_NOISE):
            log("REACT_SKIP_INFRA: {} — {}".format(agent, alert_msg[:80]))
            continue
        alert_count = len(alerts)

        # Decide who should handle the reaction
        if agent == "guardian":
            target = "codex"
            title = "[REACT] {} 에러 코드 수정 필요".format(agent)
            body = "guardian이 15분 내 {}건 알림 발생: {}. 스크립트를 점검하고 수정하라.".format(
                alert_count, alert_msg[:200])
        elif agent == "ron":
            target = "codex"
            title = "[REACT] ron API/인증 에러"
            body = "ron에서 {}건 에러 발생: {}. API/인증 문제를 진단하고 수정하라.".format(
                alert_count, alert_msg[:200])
        else:
            target = "ron"
            title = "[REACT] {} 에러 분류".format(agent)
            body = "{} 에이전트에서 {}건 에러 발생: {}. 심각도를 평가하고 조치하라.".format(
                agent, alert_count, alert_msg[:200])

        # Skip if circuit breaker is tripped for this pattern
        cb_tripped, cb_sig = _is_bus_cb_tripped(state, title, target)
        if cb_tripped:
            log("REACT_SKIP: '{}' blocked by circuit breaker [{}]".format(title[:40], cb_sig))
            continue

        if create_task(target, title, body, "high"):
            created += 1
            log("REACT: {} alert(s) from {} -> dispatched to {}".format(alert_count, agent, target))

    return created


def _retry_failed_commands(state):
    """Retry failed bus_commands (max 1 retry, tracked by [R1] title prefix).
    File-not-found errors (exit code 2) are exempt from retry."""
    if not is_interval_passed(state, "last_failed_retry", 10):  # Check every 10 min
        return 0

    state["last_failed_retry"] = now_ts()

    # Get recently failed commands (last 30 min)
    failed = ops_db_query(
        "SELECT id, title, body, target_agent, priority, result_note, created_at "
        "FROM bus_commands WHERE status='failed' "
        "AND created_at > datetime('now','localtime','-30 minutes') "
        "ORDER BY created_at DESC LIMIT 10"
    )

    if not failed:
        return 0

    commands, _ = get_queue_status()
    created = 0

    for cmd in failed:
        title = cmd.get("title", "")
        target = cmd.get("target_agent", "")
        body = cmd.get("body", "")
        result_note = cmd.get("result_note", "")

        # Skip if failure is systemic / not retryable
        combined = (result_note + " " + title).lower()
        if any(kw in combined for kw in
               ["401", "unauthorized", "billing", "429", "rate limit",
                "no such file or directory", "errno 2",
                "can't open file", "filenotfounderror",
                "timed out", "agent_timeout", "timeout",
                "cooldown", "failovererror", "econnrefused",
                "[react]", "[alert]", "coverage gap",
                "refused: payload references system path",
                "blocked: not in whitelist"]):
            continue

        # Skip if circuit breaker is tripped for this pattern
        cb_tripped, cb_sig = _is_bus_cb_tripped(state, title, target)
        if cb_tripped:
            log("RETRY_SKIP: #{} '{}' blocked by circuit breaker [{}]".format(
                cmd.get("id"), title[:30], cb_sig))
            continue

        # Determine retry count from title prefix — max R1 (R2+ blocked)
        retry_count = 0
        clean_title = title
        if title.startswith("[R1]") or title.startswith("[R2]"):
            continue  # Max 1 retry reached


        new_title = "[R{}] {}".format(retry_count + 1, clean_title[:70])

        # Skip if already queued
        if queue_has_title(commands, new_title[:15]):
            continue

        new_body = "{} [자동재시도 #{}: 이전 실패: {}]".format(
            body, retry_count + 1, (result_note or "알 수 없음")[:100])

        if create_task(target, new_title, new_body, cmd.get("priority", "normal")):
            created += 1
            log("RETRY: #{} '{}' -> '{}' (attempt {})".format(
                cmd.get("id"), title[:30], target, retry_count + 1))

    return created


def _scan_specialist_reports(state):
    """Scan recent specialist reports for actionable findings and create follow-up tasks."""
    if not is_interval_passed(state, "last_report_scan", 30):  # Check every 30 min
        return 0

    state["last_report_scan"] = now_ts()
    created = 0
    commands, _ = get_queue_status()

    report_base = os.path.join(HOME, ".openclaw/workspace/reports")

    # Check recovery reports for critical findings
    recovery_dir = os.path.join(report_base, "recovery")
    if os.path.isdir(recovery_dir):
        created += _scan_report_dir(
            recovery_dir, "recovery", commands, state,
            keywords=["CRITICAL", "FAIL", "DOWN", "BROKEN", "DRIFT"],
            target_agent="codex",
            title_prefix="[REPORT] recovery finding"
        )

    # Check analyst reports for actionable signals
    analyst_dir = os.path.join(report_base, "analyst")
    if os.path.isdir(analyst_dir):
        created += _scan_report_dir(
            analyst_dir, "analyst", commands, state,
            keywords=["SIGNAL", "ALERT", "CONVERGENCE", "NEW_ENTRY", "SIGNIFICANT"],
            target_agent="ron",
            title_prefix="[REPORT] analyst signal"
        )

    # Check ETF signal reports
    etf_dir = os.path.join(report_base, "etf_signals")
    if os.path.isdir(etf_dir):
        created += _scan_report_dir(
            etf_dir, "etf", commands, state,
            keywords=["NEW_ENTRY", "SIGNAL", "CONVERGENCE"],
            target_agent="ron",
            title_prefix="[REPORT] ETF signal"
        )

    return created


def _scan_report_dir(report_dir, report_type, commands, state, keywords, target_agent, title_prefix):
    """Scan a report directory for files newer than last scan with actionable keywords."""
    last_key = "last_{}_report_ts".format(report_type)
    last_ts = state.get(last_key) or ""
    created = 0

    try:
        files = sorted(os.listdir(report_dir), reverse=True)[:5]  # Only check 5 most recent
    except Exception:
        return 0

    for fname in files:
        fpath = os.path.join(report_dir, fname)
        if not os.path.isfile(fpath):
            continue

        # Check if file is newer than last scan
        try:
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(fpath))
            mtime_str = mtime.strftime("%Y-%m-%d %H:%M:%S")
            if mtime_str <= last_ts:
                continue
        except Exception:
            continue

        # Read first 500 chars to check for keywords
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(500)
        except Exception:
            continue

        head_upper = head.upper()
        found_keywords = [kw for kw in keywords if kw in head_upper]
        if not found_keywords:
            continue

        # Create follow-up task
        task_title = "{}: {}".format(title_prefix, fname[:40])
        if queue_has_title(commands, task_title[:15]):
            continue

        task_body = "Report '{}' contains actionable findings (keywords: {}). "                     "Review and determine next actions. First 200 chars: {}".format(
                        fname, ", ".join(found_keywords), head[:200])

        if created >= 2:  # Max 2 report tasks per directory per scan
            break
        if create_task(target_agent, task_title, task_body, "normal"):
            created += 1
            log("REPORT: {} finding in {} -> {}".format(report_type, fname[:30], target_agent))

    # Update last scan timestamp
    state[last_key] = now_ts()
    return created


def send_report(state):
    if not is_interval_passed(state, "last_report", 60):
        return

    agents = get_agent_status()
    commands, counts = get_queue_status()

    agent_summary = []
    for key in _AGENT_NAMES:
        a = agents.get(key, {})
        alive = "ON" if a.get("alive") else "OFF"
        task = a.get("current_task", "-")[:40]
        agent_summary.append("{}: {} | {}".format(key, alive, task))

    # v3: Ron LLM 상태 포함
    llm_status = "OK"
    failures = state.get("ron_llm_consecutive_failures", 0)
    if failures >= RON_LLM_MAX_FAILURES:
        llm_status = "FALLBACK"
    elif failures > 0:
        llm_status = "WARN({})".format(failures)

    report = "[오케스트레이터 v3 보고] " + " | ".join(agent_summary)
    report += " || 큐: queued={} claimed={} done={} | Ron-LLM: {}".format(
        counts.get("queued", 0), counts.get("claimed", 0),
        counts.get("done", 0), llm_status)

    bus_write("harry", "report", report)
    state["last_report"] = now_ts()
    log("Report sent to Harry (LLM={})".format(llm_status))


# ============================================================
# v3.5: bus_commands 서킷브레이커 (동일 에러 패턴 반복 차단)
# ============================================================

BUS_CB_THRESHOLD = int(os.environ.get("ORCH_BUS_CB_THRESHOLD", "5"))       # 동일 signature 5회 → trip (기존 3→5 상향)
BUS_CB_WINDOW_SEC = int(os.environ.get("ORCH_BUS_CB_WINDOW_SEC", "3600"))   # 1시간 sliding window
BUS_CB_COOLDOWN_SEC = int(os.environ.get("ORCH_BUS_CB_COOLDOWN_SEC", "43200"))  # 12시간 후 자동 해제 (기존 24h→12h 단축)

# Telegram DM for circuit breaker alerts
_CB_BOT_TOKEN = None

def _get_cb_bot_token():
    global _CB_BOT_TOKEN
    if _CB_BOT_TOKEN:
        return _CB_BOT_TOKEN
    try:
        with open(os.path.join(HOME, ".openclaw/openclaw.json")) as f:
            _CB_BOT_TOKEN = json.load(f)["channels"]["telegram"]["botToken"]
    except Exception:
        _CB_BOT_TOKEN = ""
    return _CB_BOT_TOKEN


def _cb_send_telegram_dm(text):
    """Send circuit breaker alert to Telegram DM (chat_id: 492860021)."""
    token = _get_cb_bot_token()
    if not token:
        return
    try:
        payload = json.dumps({
            "chat_id": 492860021,
            "text": text[:4000],
            "parse_mode": "HTML",
        }).encode("utf-8")
        req = Request(
            "https://api.telegram.org/bot{}/sendMessage".format(token),
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urlopen(req, timeout=10)
    except Exception:
        pass


def _compute_error_signature(title, result_note):
    """Compute error signature from failed command.

    Signature types:
    - missing:path — FileNotFoundError / No such file
    - http:code — HTTP error codes
    - path-guard:sample — PATH-GUARD specific missing file
    - generic:hash — fallback hash of first 80 chars
    """
    note = (result_note or "").lower()
    title_lower = (title or "").lower()

    # PATH-GUARD specific: extract missing file sample
    if "path-guard" in title_lower or "path_guard" in title_lower or "note_guard" in title_lower:
        # Extract file path from result_note
        for pattern in [r"missing.*?['\"]([^'\"]+)['\"]", r"not found.*?:\s*(.+?)(?:\s|$)", r"missing_sample.*?['\"]([^'\"]+)['\"]"]:
            m = re.search(pattern, note)
            if m:
                return "path-guard:{}".format(m.group(1).strip()[:60])
        return "path-guard:{}".format(hashlib.md5(note[:80].encode()).hexdigest()[:12])

    # File not found
    for kw in ["no such file", "filenotfounderror", "errno 2", "can't open file"]:
        if kw in note:
            m = re.search(r"['\"]([^'\"]+)['\"]", note)
            path = m.group(1) if m else note[:60]
            return "missing:{}".format(path.strip()[:60])

    # HTTP error codes
    m = re.search(r"http[_\s]*(\d{3})", note)
    if m:
        return "http:{}".format(m.group(1))

    # Generic: hash of first 80 chars
    h = hashlib.md5(note[:80].encode()).hexdigest()[:12]
    return "generic:{}".format(h)


def _update_circuit_breakers(state):
    """Update bus_commands circuit breaker state.

    Scans recently failed commands, computes error signatures,
    and trips breaker when threshold is reached within the window.

    state["circuit_breakers"] = {
        "sig|agent": {"count": N, "first_seen": ts, "tripped_at": ts_or_None, "last_title": str}
    }
    """
    breakers = state.setdefault("circuit_breakers", {})
    now = datetime.datetime.now()
    now_epoch = time.time()
    tripped_this_cycle = []

    # 1. Expire old breakers (24h cooldown after trip, or window expiry for untripped)
    expired_keys = []
    for key, info in breakers.items():
        if info.get("tripped_at"):
            # Tripped: expire after 24h
            try:
                tripped_dt = datetime.datetime.strptime(info["tripped_at"], "%Y-%m-%d %H:%M:%S")
                if (now - tripped_dt).total_seconds() > BUS_CB_COOLDOWN_SEC:
                    expired_keys.append(key)
            except Exception:
                expired_keys.append(key)
        else:
            # Untripped: expire after window
            try:
                first_dt = datetime.datetime.strptime(info["first_seen"], "%Y-%m-%d %H:%M:%S")
                if (now - first_dt).total_seconds() > BUS_CB_WINDOW_SEC:
                    expired_keys.append(key)
            except Exception:
                expired_keys.append(key)
    for k in expired_keys:
        del breakers[k]

    # 2. Scan recently failed commands (last 10 min to avoid re-processing)
    failed = ops_db_query(
        "SELECT id, title, target_agent, result_note, completed_at "
        "FROM bus_commands WHERE status='failed' "
        "AND completed_at > datetime('now','localtime','-10 minutes') "
        "ORDER BY completed_at DESC LIMIT 20"
    )

    for cmd in failed:
        title = cmd.get("title", "")
        agent = cmd.get("target_agent", "unknown")
        result_note = cmd.get("result_note", "")

        sig = _compute_error_signature(title, result_note)
        key = "{}|{}".format(sig, agent)

        if key not in breakers:
            breakers[key] = {
                "count": 0,
                "first_seen": now_ts(),
                "tripped_at": None,
                "last_title": title[:80],
                "cmd_ids": [],
            }

        info = breakers[key]

        # Skip if already tripped
        if info["tripped_at"]:
            continue

        # Track command ID to avoid double-counting
        cmd_id = cmd.get("id")
        if cmd_id in info.get("cmd_ids", []):
            continue
        info.setdefault("cmd_ids", []).append(cmd_id)
        # Keep cmd_ids list bounded
        if len(info["cmd_ids"]) > 10:
            info["cmd_ids"] = info["cmd_ids"][-10:]

        info["count"] += 1
        info["last_title"] = title[:80]

        # 3. Trip check
        if info["count"] >= BUS_CB_THRESHOLD:
            info["tripped_at"] = now_ts()
            tripped_this_cycle.append((key, sig, agent, info))
            log("BUS_CIRCUIT_BREAKER: TRIPPED [{}] agent={} count={} title='{}'".format(
                sig, agent, info["count"], title[:50]))

    # 4. Send Telegram alerts for newly tripped breakers
    for key, sig, agent, info in tripped_this_cycle:
        msg = (
            "<b>[Circuit Breaker TRIPPED]</b>\n"
            "Pattern: <code>{}</code>\n"
            "Agent: {}\n"
            "Failures: {} in 1h window\n"
            "Last: {}\n"
            "Action: blocking retries + new tasks for 24h".format(
                sig, agent, info["count"], info["last_title"][:60])
        )
        _cb_send_telegram_dm(msg)
        bus_write("harry", "alert", "[BUS-CB] {} tripped for agent={} ({} fails)".format(
            sig, agent, info["count"]))

    return len(tripped_this_cycle)


def _is_bus_cb_tripped(state, title, target_agent):
    """Check if a circuit breaker is tripped for the given title/agent combination.

    Used by _retry_failed_commands() and reactive task creation to skip blocked patterns.
    Returns (is_tripped: bool, signature: str).
    """
    breakers = state.get("circuit_breakers", {})
    if not breakers:
        return False, ""

    # Compute what the signature would be for this title (using title as proxy)
    # Check all tripped breakers for this agent
    for key, info in breakers.items():
        if not info.get("tripped_at"):
            continue
        # key format: "sig|agent"
        parts = key.rsplit("|", 1)
        if len(parts) != 2:
            continue
        cb_sig, cb_agent = parts
        if cb_agent != target_agent:
            continue

        # Match: check if title contains similar pattern keywords
        # For path-guard: title usually contains "path-guard" or "note_guard"
        title_lower = (title or "").lower()
        if cb_sig.startswith("path-guard:") and ("path-guard" in title_lower or "path_guard" in title_lower or "note_guard" in title_lower):
            return True, cb_sig
        # For missing: check if same file referenced in title (also try basename match for short titles)
        if cb_sig.startswith("missing:"):
            missing_path = cb_sig[8:]
            if missing_path.split("/")[-1] in title_lower:
                return True, cb_sig
        # For generic/http: check if retry of same title (R1/R2 prefix stripped)
        clean_title = re.sub(r"^\[R\d+\]\s*", "", title).strip().lower()
        last_clean = re.sub(r"^\[R\d+\]\s*", "", info.get("last_title", "")).strip().lower()
        if clean_title and last_clean and clean_title[:40] == last_clean[:40]:
            return True, cb_sig

    return False, ""


# ============================================================
# v3.4: 크론잡 서킷브레이커 (연속 실패 자동 비활성화)
# ============================================================

CRON_JOBS_FILE = os.path.join(HOME, ".openclaw/cron/jobs.json")
CRON_CB_THRESHOLD = int(os.environ.get("ORCH_CRON_CB_THRESHOLD", "5"))  # 연속 N회 실패 시 자동 비활성화 (기본 5회)
CRON_CB_INTERVAL_MIN = int(os.environ.get("ORCH_CRON_CB_INTERVAL_MIN", "30"))  # 체크 간격(분)


def check_cron_circuit_breaker(state):
    """크론잡 연속 실패 감지 → 자동 비활성화 (서킷브레이커).

    게이트웨이는 연속 실패 시 백오프만 적용하고 자동 비활성화하지 않는다.
    이 함수가 jobs.json을 직접 수정하여 서킷브레이커 역할을 한다.
    """
    if not is_interval_passed(state, "last_circuit_breaker_check", CRON_CB_INTERVAL_MIN):
        return 0

    state["last_circuit_breaker_check"] = now_ts()

    if not os.path.exists(CRON_JOBS_FILE):
        return 0

    try:
        with open(CRON_JOBS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log("circuit_breaker: failed to read jobs.json: {}".format(str(e)[:80]))
        return 0

    jobs = data.get("jobs", [])
    disabled_count = 0
    modified = False

    for job in jobs:
        if not job.get("enabled", False):
            continue

        job_state = job.get("state", {})
        consecutive = job_state.get("consecutiveErrors", 0)

        if consecutive < CRON_CB_THRESHOLD:
            continue

        name = job.get("name", "unknown")
        last_error = job_state.get("lastError", "")

        # 서킷 트립: 비활성화
        job["enabled"] = False
        disabled_count += 1
        modified = True

        log("CIRCUIT_BREAKER: disabled '{}' (consecutiveErrors={}, lastError={})".format(
            name, consecutive, last_error[:100]))

        run_memory_command("add-critical",
            "Circuit breaker tripped: disabled cron '{}' after {} consecutive errors".format(
                name, consecutive))

    if modified:
        try:
            with open(CRON_JOBS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            log("circuit_breaker: saved jobs.json ({} jobs disabled)".format(disabled_count))

            # 해리에게 알림
            if disabled_count > 0:
                bus_write("harry", "alert",
                    "[서킷브레이커] 크론잡 {}개 자동 비활성화 (연속 {}회+ 실패)".format(
                        disabled_count, CRON_CB_THRESHOLD))
        except Exception as e:
            log("circuit_breaker: failed to save jobs.json: {}".format(str(e)[:80]))

    return disabled_count


# ============================================================
# 메인 사이클 (v3)
# ============================================================

def run_cycle(state):
    state["last_run"] = now_ts()
    state["cycle_count"] = state.get("cycle_count", 0) + 1

    # 0. Auto-cleanup old completed commands (prevents daily cap buildup)
    _cleanup_old_commands()

    # 0.5 서킷브레이커: 연속 실패 크론잡 자동 비활성화
    circuit = check_cron_circuit_breaker(state)

    # 0.6 bus_commands 서킷브레이커: 동일 에러 패턴 반복 차단
    bus_cb = _update_circuit_breakers(state)

    # 1. Harry 직접 지시 triad 동기화
    triad = run_triad_directive_sync(state)

    # 2. 완료 감지 → Ron LLM 후속 판단 (fallback: FOLLOW_UP_MAP)
    follow_ups = check_completions_and_follow_up(state)

    # 2.5 Reactive feedback: ALERTs, failed retries, report scanning
    reactive = _check_and_react(state)

    # 3. cowork 정체 감지 → 대체 실행
    rescues = check_cowork_stall_and_rescue(state)

    # 4. Ron LLM → 지능적 태스크 생성 (fallback: hardcoded routines)
    ron_llm = check_idle_and_assign(state)

    # 5. [흡수] 에러 에스컬레이션 체크
    errors = check_error_escalation(state)

    # 6.3 자기진화 제안 → 태스크 변환 (2시간 간격)
    evolve = run_self_evolve_cycle(state)

    # 6.5 능동적 연구 사이클 (6시간 간격, §10)
    research = 0
    if is_interval_passed(state, "last_research_cycle", 360):
        try:
            import subprocess as _sp
            _rp = _sp.run(
                ["/usr/bin/python3",
                 os.path.join(HOME, ".openclaw/scripts/ops/proactive_research.py"),
                 "--run"],
                capture_output=True, text=True, timeout=90,
                cwd=os.path.join(HOME, ".openclaw/scripts/ops"),
            )
            state["last_research_cycle"] = now_ts()  # 성공/실패 무관 업데이트 (재시도 폭주 방지)
            if _rp.returncode == 0:
                for _line in _rp.stdout.split("\n"):
                    if "QUEUED research" in _line:
                        research += 1
                if research > 0:
                    log("Research cycle: {} tasks created".format(research))
            else:
                log("Research cycle error: {}".format(_rp.stderr[:100]))
        except Exception as _re:
            log("Research cycle failed: {}".format(str(_re)[:80]))

    # 6. [흡수] ETF 예열 트리거
    etf = check_etf_prewarming(state)

    # 7. Observational Memory 기록
    cycle_stats = {
        "triad": triad,
        "follow_ups": follow_ups,
        "reactive": reactive,
        "rescues": rescues,
        "ron_llm": ron_llm,
        "errors": errors,
        "evolve": evolve,
        "research": research,
        "etf": etf,
        "circuit": circuit,
        "bus_cb": bus_cb,
    }
    log_observation_if_significant(state, cycle_stats)

    # 8. 정기 보고
    send_report(state)

    total = triad + follow_ups + reactive + rescues + ron_llm + errors + evolve + research + etf
    state["tasks_generated"] = state.get("tasks_generated", 0) + total

    if total > 0:
        log("Cycle #{}: generated {} tasks (triad={}, follow={}, reactive={}, rescue={}, ron_llm={}, error={}, evolve={}, research={}, etf={})".format(
            state["cycle_count"], total, triad, follow_ups, reactive, rescues, ron_llm, errors, evolve, research, etf))
    else:
        if state["cycle_count"] % 20 == 0:
            log("Cycle #{}: idle (no tasks generated in last 20 cycles)".format(state["cycle_count"]))

    return total


def run_cycle_locked(state):
    os.makedirs(BUS_DIR, exist_ok=True)
    with open(LOCK_FILE, "w") as lockf:
        try:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("Another orchestrator cycle is running, skip")
            return 0
        last = state.get("last_run", "")
        if last:
            try:
                last_dt = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
                if (datetime.datetime.now() - last_dt).total_seconds() < 20:
                    log("Cycle throttled: recent run detected (<20s)")
                    return 0
            except Exception:
                pass
        result = run_cycle(state)
        save_state(state)
        return result


def show_status():
    state = load_state()
    print("=== Orchestrator v3 Status ===")
    print("Last run: {}".format(state.get("last_run", "never")))
    print("Cycles: {}".format(state.get("cycle_count", 0)))
    print("Tasks generated: {}".format(state.get("tasks_generated", 0)))
    print("Last report: {}".format(state.get("last_report", "never")))
    print("Last cowork rescue: {}".format(state.get("last_cowork_rescue", "never")))
    print("Last health: {}".format(state.get("last_health", "never")))
    print("Last knowledge cycle: {}".format(state.get("last_knowledge_cycle", "never")))
    print("Last error check: {}".format(state.get("last_error_check", "never")))
    print("Last ETF prewarming: {}".format(state.get("last_etf_prewarming", "never")))
    print("Last triad sync: {}".format(state.get("last_triad_sync", "never")))
    print()
    print("--- v3 Ron LLM ---")
    print("Last Ron LLM call: {}".format(state.get("last_ron_llm_call", "never")))
    print("Consecutive failures: {}".format(state.get("ron_llm_consecutive_failures", 0)))
    print("Fallback start: {}".format(state.get("last_ron_llm_fallback_start", "none")))
    print("Last memory cleanup: {}".format(state.get("last_memory_cleanup", "never")))

    commands, counts = get_queue_status()
    print("\nQueue: queued={} claimed={} done={} failed={}".format(
        counts.get("queued", 0), counts.get("claimed", 0),
        counts.get("done", 0), counts.get("failed", 0)))

    agents = get_agent_status()
    for key in _AGENT_NAMES:
        a = agents.get(key, {})
        print("  {}: alive={} task={}".format(key, a.get("alive"), a.get("current_task", "-")[:50]))


def main():
    if "--status" in sys.argv:
        show_status()
        return

    state = load_state()

    if "--loop" in sys.argv:
        log("=== Orchestrator v3.1 starting (loop mode, adaptive interval) ===")
        log("=== v3: Ron LLM 중앙 지휘 + Observational Memory + CoT 검증 ===")
        bus_write("all", "system", "오케스트레이터 v3 시작: Ron LLM 중앙 지휘 모드")
        while True:
            try:
                cycle_stats = run_cycle_locked(state)
            except Exception as e:
                log("ERROR: " + str(e))
                cycle_stats = {}
            idle_streak = state.get("idle_streak", 0)
            # run_cycle_locked returns int (total tasks generated)
            if isinstance(cycle_stats, int) and cycle_stats > 0:
                idle_streak = 0
            elif isinstance(cycle_stats, dict) and cycle_stats.get("total", 0) > 0:
                idle_streak = 0
            else:
                idle_streak += 1
            state["idle_streak"] = idle_streak
            sleep_sec = min(300, CYCLE_INTERVAL_SEC + idle_streak * 30)
            time.sleep(sleep_sec)
    else:
        log("=== Orchestrator v3 single run ===")
        run_cycle_locked(state)

if __name__ == "__main__":
    main()
