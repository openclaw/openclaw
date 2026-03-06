"""
Section 08 — Cron Scheduler
"When the agent knows time itself"

本文件是 s07_heartbeat.py 的【功能超集】— 在 Heartbeat 框架之上,
加入 OpenClaw 最精确的调度特性: Cron 系统.

传统的心跳是 "定期检查有没有事", 而 Cron 是
"在精确的时间点执行精确的任务". 心跳是模糊的周期性轮询,
Cron 是确定性的时间调度.

【与 s07 的关系 — 纯增量, 零删减】
  s07_heartbeat.py 提供 (继承自 s06/s05):
    - AgentWithSoulMemory / workspace / SOUL.md / MEMORY.md
    - MemoryIndexManager + memory_search / memory_get / memory_write
    - build_agent_system_prompt (soul + memory 注入)
    - run_agent_with_soul_and_memory (带工具循环的 agent runner)
    - HeartbeatRunner: 后台定时器, 周期性触发 agent 执行
    - HeartbeatGateway: 继承 SoulMemoryGateway, 增加心跳 RPC
    - run_repl_with_heartbeat: s06 REPL + 心跳后台循环

  本文件新增:
    - CronSchedule: 三种调度类型 (at / every / cron)
    - CronJob: 完整数据结构 (schedule + payload + state + delivery)
    - CronStore: JSON 文件持久化 (原子写入 + 备份)
    - CronRunLog: JSONL 追加日志 (per-job, 带自动修剪)
    - CronService: 后台调度引擎 (timer tick + 到期执行)
    - compute_next_run_at: 核心调度算法
    - 错误指数退避: 30s → 1m → 5m → 15m → 60m
    - sessionTarget: main (system event → 心跳) vs isolated (独立 agent turn)
    - wakeMode: now (立即唤醒心跳) vs next-heartbeat (等下次心跳)
    - delivery: announce / none (隔离任务的结果投递)
    - CronGateway: 继承 HeartbeatGateway, 增加 cron RPC
    - run_repl_with_cron: 继承 s07 REPL, 增加 cron 命令

【参考】OpenClaw 源码
  - src/cron/types.ts              CronJob / CronSchedule / CronPayload / CronDelivery
  - src/cron/schedule.ts           computeNextRunAtMs
  - src/cron/service.ts            CronService
  - src/cron/service/ops.ts        start / stop / add / update / remove / run
  - src/cron/service/timer.ts      armTimer / onTimer / executeJobCore
  - src/cron/service/jobs.ts       recomputeNextRuns / createJob / applyJobResult
  - src/cron/service/state.ts      CronServiceState / CronEvent
  - src/cron/service/store.ts      ensureLoaded / persist
  - src/cron/service/locked.ts     promise-chain locking
  - src/cron/delivery.ts           resolveCronDeliveryPlan
  - src/cron/run-log.ts            appendCronRunLog / readCronRunLogEntries
  - src/cron/session-reaper.ts     sweepCronRunSessions
  - src/gateway/server-cron.ts     buildGatewayCronService
  - src/gateway/server-methods/cron.ts  RPC method handlers

── Cron 与 Heartbeat 的区别 ──────────────────────────────

  | 方面       | Heartbeat              | Cron                           |
  |-----------|------------------------|--------------------------------|
  | 时间精度   | ~每 30 分钟 (近似)      | 精确: 7:00 AM, 每小时, 20分钟后 |
  | Session   | 主 session (完整上下文)  | main 或 isolated (独立 session) |
  | 范围       | 批量检查多个事项         | 单个聚焦任务                    |
  | 输出       | 仅当不是 HEARTBEAT_OK   | announce (投递) 或 none         |
  | 最佳用途   | 收件箱/日历/定期监控     | 报告/一次性提醒/精确调度         |
  | 互补使用   | heartbeat 做批量监控    | cron 做精确调度                 |

── 三种调度类型 ──────────────────────────────────────────

  1. "at" — 一次性绝对时间
     schedule: { "kind": "at", "at": "2026-03-07T17:00:00Z" }
     → 执行一次后自动 disable / delete_after_run

  2. "every" — 基于锚点的等间隔
     schedule: { "kind": "every", "every_ms": 3600000, "anchor_ms": 1704067200000 }
     → 公式: anchor + ceil((now-anchor)/interval) * interval
     → 不用 last_run, 防止累积漂移

  3. "cron" — 标准 cron 表达式 (5-field)
     schedule: { "kind": "cron", "expr": "0 7 * * *", "tz": "America/New_York" }
     → 用 croniter 解析, 带时区支持

── 执行流程 ──────────────────────────────────────────────

  CronService._background_loop() (后台线程, 每秒 tick)
      │
      ├─ [1] _find_due_jobs() → 找到 nextRunAt <= now 的 job
      │
      ├─ [2] _execute_job(job)
      │      │
      │      ├─ main session:
      │      │   enqueue system event → requestHeartbeatNow / runHeartbeatOnce
      │      │
      │      └─ isolated session:
      │          run_agent_with_soul_and_memory (独立 session)
      │          → 结果 → delivery (announce / none)
      │
      ├─ [3] _apply_job_result()
      │      ├─ 更新 state (lastRunAt, lastStatus, consecutiveErrors)
      │      ├─ 错误退避 (30s → 1m → 5m → 15m → 60m)
      │      ├─ one-shot: disable after ANY terminal status
      │      ├─ delete_after_run: 成功后删除
      │      └─ 重算 nextRunAt
      │
      ├─ [4] 追加 run log (per-job JSONL)
      │
      └─ [5] emit 事件 → Gateway 广播

── 运行方式 ──────────────────────────────────────────────

  1. 服务器模式 (带 cron+heartbeat 的网关):
     python s08_cron.py

  2. 交互式 REPL (路由 + Soul/Memory + Heartbeat + Cron):
     python s08_cron.py --repl

  3. 测试客户端 (s06 功能):
     python s08_cron.py --test-client

  4. 交互式对话 (连接网关):
     python s08_cron.py --chat

── 依赖 ──────────────────────────────────────────────────
  pip install python-dotenv websockets croniter
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import asyncio
import json
import logging
import math
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# 确保当前目录在 sys.path 中
_agents_dir = Path(__file__).resolve().parent
if str(_agents_dir) not in sys.path:
    sys.path.insert(0, str(_agents_dir))

from llm_client import (
    load_env_if_exists,
    deepseek_chat_with_tools,
    LLMClientConfig,
    LLMClientError,
    LLMValidationError,
)

# croniter 用于解析标准 cron 表达式
try:
    from croniter import croniter
except ImportError:
    croniter = None  # type: ignore[assignment,misc]

# ── 从 s07 导入: Heartbeat 框架 (全量) ──
from s07_heartbeat import (
    # HeartbeatRunner + 相关常量/函数
    HeartbeatRunner,
    HeartbeatGateway,
    run_repl_with_heartbeat,
    # Heartbeat 常量
    HEARTBEAT_OK_TOKEN,
    HEARTBEAT_PROMPT,
    DEFAULT_HEARTBEAT_FILENAME,
    DEFAULT_ACK_MAX_CHARS,
    DEFAULT_HEARTBEAT_EVERY_SECONDS,
    DEMO_HEARTBEAT_INTERVAL,
    HEARTBEAT_ACTIVE_START,
    HEARTBEAT_ACTIVE_END,
    DEDUP_WINDOW_SECONDS,
    # Heartbeat Token 处理
    strip_heartbeat_token,
    is_heartbeat_content_effectively_empty,
    load_heartbeat_file,
    # Active Hours
    parse_active_hours_time,
    is_within_active_hours,
    # Heartbeat 事件
    emit_heartbeat_event,
    HEARTBEAT_STATUS_SENT,
    HEARTBEAT_STATUS_OK_EMPTY,
    HEARTBEAT_STATUS_OK_TOKEN,
    HEARTBEAT_STATUS_SKIPPED,
    HEARTBEAT_STATUS_FAILED,
    # Heartbeat UI
    print_heartbeat,
    print_heartbeat_status,
    # 样例创建
    _ensure_sample_heartbeat,
)

# ── 从 s06 导入: Soul+Memory 框架 ──
from s06_soul_memory import (
    # Agent 配置
    AgentWithSoulMemory,
    create_agents_with_soul_memory,
    _ensure_sample_soul,
    # Memory 管理
    MemoryIndexManager,
    get_memory_manager,
    MEMORY_TOOL_NAMES,
    build_memory_tools,
    handle_memory_tool,
    # System prompt 构建
    build_agent_system_prompt,
    load_workspace_bootstrap_files,
    _truncate_bootstrap,
    BOOTSTRAP_MAX_CHARS,
    # Agent runner
    run_agent_with_soul_and_memory,
    # Gateway
    SoulMemoryGateway,
    # 客户端模式 (原样继承)
    test_client as s06_test_client,
    interactive_chat as s06_interactive_chat,
    run_repl as s06_run_repl,
    # UI 工具
    colored_prompt,
    print_assistant,
    print_info,
    print_tool,
    print_agent,
    # 颜色常量
    CYAN, GREEN, YELLOW, DIM, RESET, BOLD, MAGENTA, BLUE,
    # 目录
    WORKSPACE_DIR,
    SESSIONS_DIR,
)

# ── 从 s05 导入: 路由基础设施 ──
from s05_gateway import (
    MessageRouter,
    Binding,
    ConnectedClient,
    make_event,
    make_result,
    make_error,
    JSONRPC_VERSION,
    INTERNAL_ERROR,
)

# ── 从 s04 导入: session + 工具 ──
from s04_multi_channel import (
    TOOLS_OPENAI,
    SessionStore as S04SessionStore,
    SYSTEM_PROMPT as S04_SYSTEM_PROMPT,
    process_tool_call,
)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

load_dotenv()
load_env_if_exists()

MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat")

# 网关配置 (与 s06/s07 一致)
GATEWAY_HOST = os.getenv("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "18789"))
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")

# 日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway-cron")

# ---------------------------------------------------------------------------
# Cron 颜色
# ---------------------------------------------------------------------------
RED = "\033[31m"
ORANGE = "\033[38;5;208m"


def print_cron(text: str) -> None:
    """Cron 消息用橙色标记, 与心跳 (蓝色) 区分."""
    print(f"\n{ORANGE}{BOLD}[Cron]{RESET} {text}\n")


def print_cron_status(text: str) -> None:
    """Cron 状态信息用 DIM 显示."""
    print(f"  {DIM}[cron] {text}{RESET}")



# ============================================================================
# Part 1: CronSchedule 计算 — compute_next_run_at
# ============================================================================
#
# 【参考】OpenClaw src/cron/schedule.ts  computeNextRunAtMs()
#
# 三种 schedule 类型各自的下一次触发时间计算:
#   - at: 一次性, 解析 ISO 时间或纯数字时间戳, 过期返回 None
#   - every: 锚点公式 anchor + ceil((now-anchor)/interval)*interval
#            不用 last_run, 防止累积漂移
#   - cron: croniter 解析, 从 floor(now) 开始计算下一个匹配时间
#           防同秒循环: 只接受 strictly > now_second 的结果
# ============================================================================


def parse_absolute_time_seconds(input_str: str) -> float | None:
    """解析绝对时间字符串, 返回 Unix timestamp (秒).

    【参考】OpenClaw src/cron/parse.ts  parseAbsoluteTimeMs()

    支持:
      - 纯数字: 视为 Unix timestamp (秒)
      - ISO 8601: "2026-03-07T17:00:00Z", "2026-03-07", "2026-03-07T17:00:00"
      - 无时区信息时自动追加 UTC
    """
    raw = input_str.strip()
    if not raw:
        return None

    # 纯数字 → 直接作为 Unix timestamp (秒)
    if re.match(r"^\d+(\.\d+)?$", raw):
        n = float(raw)
        return n if n > 0 else None

    # ISO 日期时间解析
    # 如果没有时区信息, 假设 UTC
    iso_tz_re = re.compile(r"(Z|[+-]\d{2}:?\d{2})$", re.IGNORECASE)
    iso_date_re = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    iso_datetime_re = re.compile(r"^\d{4}-\d{2}-\d{2}T")

    normalized = raw
    if not iso_tz_re.search(raw):
        if iso_date_re.match(raw):
            normalized = f"{raw}T00:00:00Z"
        elif iso_datetime_re.match(raw):
            normalized = f"{raw}Z"

    try:
        dt = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, OSError):
        return None


def compute_next_run_at(schedule: dict, now_ts: float) -> float | None:
    """计算调度的下一次触发时间 (Unix timestamp, 秒).

    【参考】OpenClaw src/cron/schedule.ts  computeNextRunAtMs()

    三种 schedule 类型:
      - "at": 一次性绝对时间, 过期返回 None
      - "every": 基于锚点的等间隔, 公式: anchor + ceil((now-anchor)/interval)*interval
      - "cron": 标准 5-field cron 表达式, 用 croniter 库解析

    返回 None 表示已过期或无法计算.
    """
    kind = schedule.get("kind")

    if kind == "at":
        at_str = schedule.get("at", "")
        if not at_str:
            return None
        at_ts = parse_absolute_time_seconds(at_str)
        if at_ts is None:
            return None
        return at_ts if at_ts > now_ts else None

    if kind == "every":
        every_s = max(0.001, schedule.get("every_s", 60))
        anchor_s = schedule.get("anchor_s")
        if anchor_s is None:
            anchor_s = now_ts
        anchor_s = max(0, anchor_s)

        if now_ts < anchor_s:
            return anchor_s

        elapsed = now_ts - anchor_s
        # 【关键】ceil 公式: 确保结果 strictly > now
        # OpenClaw: const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
        steps = max(1, math.ceil(elapsed / every_s))
        return anchor_s + steps * every_s

    if kind == "cron":
        expr = schedule.get("expr", "").strip()
        if not expr:
            return None

        if croniter is None:
            log.warning("croniter not installed — cannot compute cron schedule")
            return None

        try:
            tz_str = schedule.get("tz")
            if tz_str:
                import zoneinfo
                tz_obj = zoneinfo.ZoneInfo(tz_str)
                base_dt = datetime.fromtimestamp(now_ts, tz=tz_obj)
            else:
                base_dt = datetime.fromtimestamp(now_ts).astimezone()

            # 【参考】OpenClaw: Cron operates at second granularity,
            # so floor nowMs to the start of the current second.
            # Ask croner for the next occurrence strictly *after* nowSecondMs.
            now_second_ts = math.floor(now_ts)
            now_second_dt = datetime.fromtimestamp(
                now_second_ts,
                tz=base_dt.tzinfo,
            )

            cron_iter = croniter(expr, now_second_dt)
            next_dt = cron_iter.get_next(datetime)
            next_ts = next_dt.timestamp()

            # 只接受 strictly > now_second 的结果
            # 防止同秒重复触发 (see OpenClaw #14164)
            if next_ts > now_second_ts:
                return next_ts

            # 如果 croniter 返回了 <= now_second 的时间, 从 now+1s 重试
            retry_dt = datetime.fromtimestamp(
                now_second_ts + 1,
                tz=base_dt.tzinfo,
            )
            cron_iter2 = croniter(expr, retry_dt)
            retry_next = cron_iter2.get_next(datetime)
            retry_ts = retry_next.timestamp()
            return retry_ts if retry_ts > now_second_ts else None
        except Exception as exc:
            log.warning("cron schedule parse error: %s", exc)
            return None

    return None


# ============================================================================
# Part 2: CronJob 数据结构
# ============================================================================
#
# 【参考】OpenClaw src/cron/types.ts
#
# CronJob 完整结构, 包含 OpenClaw 的所有关键字段:
#   - id, name, description, enabled, deleteAfterRun
#   - schedule: { kind: "at" | "every" | "cron", ... }
#   - sessionTarget: "main" | "isolated"
#   - wakeMode: "now" | "next-heartbeat"
#   - payload: { kind: "systemEvent", text } | { kind: "agentTurn", message, ... }
#   - delivery: { mode: "announce" | "none", channel, to }
#   - state: { nextRunAt, runningAt, lastRunAt, lastStatus, ... }
# ============================================================================


def make_cron_job_state() -> dict:
    """创建空的 CronJobState.

    【参考】OpenClaw src/cron/types.ts  CronJobState
    """
    return {
        "next_run_at": None,       # float | None — 下一次触发时间 (Unix ts)
        "running_at": None,        # float | None — 开始执行时间 (防并发)
        "last_run_at": None,       # float | None — 上次执行时间
        "last_status": None,       # "ok" | "error" | "skipped" | None
        "last_error": None,        # str | None
        "last_duration_ms": None,  # float | None
        "consecutive_errors": 0,   # int — 连续错误计数 (用于退避)
        "schedule_error_count": 0, # int — 调度计算错误计数 (超 3 次自动 disable)
    }


def make_cron_job(
    name: str,
    schedule: dict,
    payload: dict,
    *,
    enabled: bool = True,
    delete_after_run: bool | None = None,
    session_target: str = "main",
    wake_mode: str = "next-heartbeat",
    delivery: dict | None = None,
    agent_id: str | None = None,
    description: str | None = None,
    job_id: str | None = None,
) -> dict:
    """创建一个 CronJob.

    【参考】OpenClaw src/cron/service/jobs.ts  createJob()

    关键设计:
      - "at" 类型默认 delete_after_run=True
      - "every" 类型自动填充 anchor_s (如果缺失)
      - session_target: "main" → payload 必须是 systemEvent
      - session_target: "isolated" → payload 必须是 agentTurn
    """
    now_ts = time.time()

    # 默认 delete_after_run: at 类型为 True
    if delete_after_run is None:
        delete_after_run = schedule.get("kind") == "at"

    # "every" 类型自动填充 anchor_s
    if schedule.get("kind") == "every" and schedule.get("anchor_s") is None:
        schedule = {**schedule, "anchor_s": now_ts}

    job = {
        "id": job_id or str(uuid.uuid4()),
        "agent_id": agent_id,
        "name": name.strip() or "unnamed",
        "description": description,
        "enabled": enabled,
        "delete_after_run": delete_after_run,
        "created_at": now_ts,
        "updated_at": now_ts,
        "schedule": schedule,
        "session_target": session_target,  # "main" | "isolated"
        "wake_mode": wake_mode,            # "now" | "next-heartbeat"
        "payload": payload,
        "delivery": delivery,              # { mode, channel, to } | None
        "state": make_cron_job_state(),
    }

    # 验证 session_target 与 payload.kind 的一致性
    # 【参考】OpenClaw jobs.ts  assertSupportedJobSpec()
    payload_kind = payload.get("kind")
    if session_target == "main" and payload_kind != "systemEvent":
        log.warning("main cron jobs require payload.kind='systemEvent', got '%s'",
                     payload_kind)
    if session_target == "isolated" and payload_kind != "agentTurn":
        log.warning("isolated cron jobs require payload.kind='agentTurn', got '%s'",
                     payload_kind)

    # 计算初始 nextRunAt
    job["state"]["next_run_at"] = compute_next_run_at(schedule, now_ts)

    return job



# ============================================================================
# Part 3: CronStore — JSON 文件持久化
# ============================================================================
#
# 【参考】OpenClaw src/cron/store.ts + src/cron/service/store.ts
#
# 使用 tmp + rename 的原子写入模式, 防止写入中途断电导致数据损坏.
# 每次 save 后创建 .bak 备份 (best-effort).
# ============================================================================


class CronStore:
    """Cron 任务持久化存储.

    【参考】OpenClaw src/cron/store.ts  loadCronStore / saveCronStore

    存储路径: workspace/cron/jobs.json
    格式: { "version": 1, "jobs": [...] }
    线程安全: 内部 lock 保证串行访问.
    """

    def __init__(self, store_path: Path):
        self.store_path = store_path
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def load(self) -> list[dict]:
        """从文件加载所有 CronJob."""
        with self._lock:
            return self._load_unlocked()

    def _load_unlocked(self) -> list[dict]:
        if not self.store_path.exists():
            return []
        try:
            raw = self.store_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            if isinstance(data, dict) and isinstance(data.get("jobs"), list):
                jobs = data["jobs"]
                # 确保每个 job 都有 state
                for job in jobs:
                    if not isinstance(job.get("state"), dict):
                        job["state"] = make_cron_job_state()
                return jobs
            return []
        except (json.JSONDecodeError, OSError):
            return []

    def save(self, jobs: list[dict]) -> None:
        """原子写入: 先写临时文件, 再 rename.

        【参考】OpenClaw store.ts  saveCronStore()
        """
        with self._lock:
            self._save_unlocked(jobs)

    def _save_unlocked(self, jobs: list[dict]) -> None:
        data = {"version": 1, "jobs": jobs}
        content = json.dumps(data, indent=2, ensure_ascii=False, default=str)
        tmp_path = self.store_path.with_suffix(f".{os.getpid()}.tmp")
        try:
            tmp_path.write_text(content, encoding="utf-8")
            tmp_path.replace(self.store_path)
            # 创建备份 (best-effort)
            try:
                bak_path = Path(str(self.store_path) + ".bak")
                bak_path.write_text(content, encoding="utf-8")
            except OSError:
                pass
        except OSError:
            self.store_path.write_text(content, encoding="utf-8")
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def find_job(self, job_id: str) -> dict | None:
        """查找指定 ID 的 job."""
        with self._lock:
            jobs = self._load_unlocked()
            for job in jobs:
                if job.get("id") == job_id:
                    return job
            return None

    def add_job(self, job: dict) -> None:
        """添加一个 job 并持久化."""
        with self._lock:
            jobs = self._load_unlocked()
            jobs.append(job)
            self._save_unlocked(jobs)

    def remove_job(self, job_id: str) -> bool:
        """删除一个 job, 返回是否成功."""
        with self._lock:
            jobs = self._load_unlocked()
            filtered = [j for j in jobs if j.get("id") != job_id]
            if len(filtered) == len(jobs):
                return False
            self._save_unlocked(filtered)
            return True

    def update_job_in_store(self, job_id: str, mutator) -> None:
        """通过 mutator 函数原子地修改指定 job."""
        with self._lock:
            jobs = self._load_unlocked()
            for job in jobs:
                if job.get("id") == job_id:
                    mutator(job)
                    break
            self._save_unlocked(jobs)

    def mutate_all(self, mutator) -> None:
        """通过 mutator 函数原子地修改所有 jobs."""
        with self._lock:
            jobs = self._load_unlocked()
            mutator(jobs)
            self._save_unlocked(jobs)


# ============================================================================
# Part 4: CronRunLog — JSONL 追加日志
# ============================================================================
#
# 【参考】OpenClaw src/cron/run-log.ts
#
# JSONL 格式: 每行一条 JSON 记录.
# 每个 job 有独立的日志文件: runs/<jobId>.jsonl
# 超过 MAX_SIZE_BYTES 时保留最近 KEEP_LINES 行.
# ============================================================================


class CronRunLog:
    """Cron 执行日志.

    【参考】OpenClaw src/cron/run-log.ts

    日志目录: workspace/cron/runs/
    每个 job 一个文件: <jobId>.jsonl
    """

    MAX_SIZE_BYTES = 2_000_000  # 2MB
    KEEP_LINES = 2000

    def __init__(self, runs_dir: Path):
        self.runs_dir = runs_dir
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _log_path(self, job_id: str) -> Path:
        """每个 job 独立的日志文件路径."""
        return self.runs_dir / f"{job_id}.jsonl"

    def append(self, job_id: str, entry: dict) -> None:
        """追加一条日志, 然后检查是否需要修剪.

        【参考】OpenClaw run-log.ts  appendCronRunLog()
        """
        with self._lock:
            path = self._log_path(job_id)
            line = json.dumps(entry, ensure_ascii=False, default=str) + "\n"
            try:
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                return
            self._prune_if_needed(path)

    def _prune_if_needed(self, path: Path) -> None:
        """如果文件超过 MAX_SIZE_BYTES, 只保留最近 KEEP_LINES 行.

        【参考】OpenClaw run-log.ts  pruneIfNeeded()
        """
        try:
            stat = path.stat()
        except OSError:
            return
        if stat.st_size <= self.MAX_SIZE_BYTES:
            return
        try:
            raw = path.read_text(encoding="utf-8")
            lines = [l.strip() for l in raw.split("\n") if l.strip()]
            kept = lines[-self.KEEP_LINES:]
            # 原子写入
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text("\n".join(kept) + "\n", encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    def read_recent(self, job_id: str, limit: int = 200) -> list[dict]:
        """读取指定 job 最近的 N 条日志.

        【参考】OpenClaw run-log.ts  readCronRunLogEntries()
        """
        with self._lock:
            path = self._log_path(job_id)
            if not path.exists():
                return []
            try:
                raw = path.read_text(encoding="utf-8")
                lines = raw.strip().split("\n")
                parsed = []
                for line in reversed(lines):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        if isinstance(obj, dict) and obj.get("action") == "finished":
                            parsed.append(obj)
                            if len(parsed) >= limit:
                                break
                    except json.JSONDecodeError:
                        continue
                return list(reversed(parsed))
            except OSError:
                return []



# ============================================================================
# Part 5: Cron 事件系统
# ============================================================================
#
# 【参考】OpenClaw src/cron/service/state.ts  CronEvent
# ============================================================================


def emit_cron_event(
    job_id: str,
    action: str,
    *,
    run_at: float | None = None,
    duration_ms: float | None = None,
    status: str | None = None,
    error: str | None = None,
    summary: str | None = None,
    next_run_at: float | None = None,
) -> dict:
    """构建 cron 事件 payload.

    【参考】OpenClaw CronEvent 类型
    actions: added, updated, removed, started, finished
    """
    payload: dict[str, Any] = {
        "job_id": job_id,
        "action": action,
    }
    if run_at is not None:
        payload["run_at"] = run_at
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    if status is not None:
        payload["status"] = status
    if error is not None:
        payload["error"] = error
    if summary is not None:
        payload["summary"] = summary[:200]
    if next_run_at is not None:
        payload["next_run_at"] = next_run_at
    return payload


# ============================================================================
# Part 6: 错误退避
# ============================================================================
#
# 【参考】OpenClaw src/cron/service/timer.ts  ERROR_BACKOFF_SCHEDULE_MS
#
# 连续错误时的指数退避:
#   1st error →  30 s
#   2nd error →   1 min
#   3rd error →   5 min
#   4th error →  15 min
#   5th+ error → 60 min
# ============================================================================

ERROR_BACKOFF_SCHEDULE_S = [
    30,         # 1st error →  30 s
    60,         # 2nd error →   1 min
    5 * 60,     # 3rd error →   5 min
    15 * 60,    # 4th error →  15 min
    60 * 60,    # 5th+ error → 60 min
]

# 调度计算连续出错超过此阈值则自动 disable
# 【参考】OpenClaw jobs.ts  MAX_SCHEDULE_ERRORS = 3
MAX_SCHEDULE_ERRORS = 3

# 运行标记超过此时间视为卡住
# 【参考】OpenClaw jobs.ts  STUCK_RUN_MS = 2 * 60 * 60 * 1000
STUCK_RUN_SECONDS = 2 * 60 * 60

# 单个 job 执行超时 (safety net)
# 【参考】OpenClaw timer.ts  DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000
DEFAULT_JOB_TIMEOUT_S = 10 * 60


def error_backoff_seconds(consecutive_errors: int) -> float:
    """根据连续错误次数计算退避延迟.

    【参考】OpenClaw timer.ts  errorBackoffMs()
    """
    idx = min(consecutive_errors - 1, len(ERROR_BACKOFF_SCHEDULE_S) - 1)
    return ERROR_BACKOFF_SCHEDULE_S[max(0, idx)]


# ============================================================================
# Part 7: Delivery 计划解析
# ============================================================================
#
# 【参考】OpenClaw src/cron/delivery.ts  resolveCronDeliveryPlan()
# ============================================================================


def resolve_cron_delivery_plan(job: dict) -> dict:
    """解析 cron job 的投递计划.

    【参考】OpenClaw delivery.ts  resolveCronDeliveryPlan()

    返回:
      { mode, channel, to, source, requested }
    """
    payload = job.get("payload", {})
    delivery = job.get("delivery")
    has_delivery = isinstance(delivery, dict)

    # 从 delivery 配置解析
    if has_delivery:
        raw_mode = delivery.get("mode", "")
        mode = "announce" if raw_mode in ("announce", "deliver") else "none"
        channel = delivery.get("channel", "last") or "last"
        to = delivery.get("to")
        return {
            "mode": mode,
            "channel": channel,
            "to": to,
            "source": "delivery",
            "requested": mode == "announce",
        }

    # Legacy: 从 payload 字段推断
    if payload.get("kind") == "agentTurn":
        deliver = payload.get("deliver")
        to = payload.get("to", "")
        has_target = bool(to and to.strip())
        if deliver is True or (deliver is None and has_target):
            return {
                "mode": "announce",
                "channel": payload.get("channel", "last") or "last",
                "to": to,
                "source": "payload",
                "requested": True,
            }

    return {
        "mode": "none",
        "channel": "last",
        "to": None,
        "source": "payload",
        "requested": False,
    }



# ============================================================================
# Part 8: CronService — 后台调度引擎
# ============================================================================
#
# 【参考】OpenClaw src/cron/service.ts + service/ops.ts + service/timer.ts
#
# 核心设计:
#   1. 后台线程每秒 tick, 找到到期 job 并执行
#   2. recomputeNextRuns: 只在 nextRunAt 缺失或已过期时重算
#   3. recomputeNextRunsForMaintenance: 只填充缺失值, 不推进已有值
#   4. applyJobResult: 更新 state, 处理退避/one-shot/delete
#   5. executeJobCore: main → 系统事件+心跳唤醒; isolated → 独立 agent turn
#   6. 心跳互斥: main session 任务通过心跳系统执行
# ============================================================================


class CronService:
    """Cron 调度服务.

    【参考】OpenClaw src/cron/service.ts  CronService

    后台线程每秒检查所有任务, 到期执行.

    与 HeartbeatRunner 的集成:
      - main session 任务: 通过 enqueue_system_event 注入事件,
        然后通过 heartbeat runner 的 wake 机制执行
      - isolated 任务: 在独立 session 中运行 agent turn
    """

    def __init__(
        self,
        store: CronStore,
        run_log: CronRunLog,
        *,
        # 心跳集成回调
        enqueue_system_event: "callable | None" = None,
        request_heartbeat_now: "callable | None" = None,
        run_heartbeat_once: "callable | None" = None,
        # 隔离任务执行回调
        run_isolated_agent_job: "callable | None" = None,
        # 事件回调
        on_event: "callable | None" = None,
        # 是否启用
        cron_enabled: bool = True,
    ):
        self.store = store
        self.run_log = run_log
        self.cron_enabled = cron_enabled

        # 心跳集成
        self._enqueue_system_event = enqueue_system_event
        self._request_heartbeat_now = request_heartbeat_now
        self._run_heartbeat_once = run_heartbeat_once

        # 隔离任务执行
        self._run_isolated_agent_job = run_isolated_agent_job

        # 事件回调
        self._on_event = on_event

        # 线程控制
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False  # 是否正在执行 job (防止重入)

        # 执行结果输出队列, 由主线程消费
        self._output_queue: list[dict] = []
        self._output_lock = threading.Lock()

    # ── 事件发射 ──

    def _emit(self, evt: dict) -> None:
        """发射 cron 事件.

        【参考】OpenClaw timer.ts  emit()
        """
        try:
            if self._on_event:
                self._on_event(evt)
        except Exception:
            pass

    # ── 重算 nextRunAt ──

    def _recompute_next_runs(self, jobs: list[dict]) -> bool:
        """为所有 job 重算 nextRunAt.

        【参考】OpenClaw jobs.ts  recomputeNextRuns()

        只在 nextRunAt 缺失或已过期时重算, 避免推进未触发的 job.
        """
        now = time.time()
        changed = False

        for job in jobs:
            state = job.setdefault("state", make_cron_job_state())

            # 清理 disabled job
            if not job.get("enabled", False):
                if state.get("next_run_at") is not None:
                    state["next_run_at"] = None
                    changed = True
                if state.get("running_at") is not None:
                    state["running_at"] = None
                    changed = True
                continue

            # 清理卡住的 running 标记
            running_at = state.get("running_at")
            if isinstance(running_at, (int, float)):
                if now - running_at > STUCK_RUN_SECONDS:
                    log.warning("cron: clearing stuck running marker for job %s",
                                job.get("id"))
                    state["running_at"] = None
                    changed = True

            # 只在 nextRunAt 缺失或已过期时重算
            next_run = state.get("next_run_at")
            if next_run is None or now >= next_run:
                try:
                    new_next = compute_next_run_at(job.get("schedule", {}), now)
                    if state.get("next_run_at") != new_next:
                        state["next_run_at"] = new_next
                        changed = True
                    # 清零调度错误计数
                    if state.get("schedule_error_count", 0) > 0:
                        state["schedule_error_count"] = 0
                        changed = True
                except Exception as exc:
                    error_count = state.get("schedule_error_count", 0) + 1
                    state["schedule_error_count"] = error_count
                    state["next_run_at"] = None
                    state["last_error"] = f"schedule error: {exc}"
                    changed = True

                    if error_count >= MAX_SCHEDULE_ERRORS:
                        job["enabled"] = False
                        log.error("cron: auto-disabled job %s after %d schedule errors",
                                  job.get("id"), error_count)
                    else:
                        log.warning("cron: schedule error for job %s (count=%d): %s",
                                    job.get("id"), error_count, exc)
        return changed

    def _recompute_next_runs_for_maintenance(self, jobs: list[dict]) -> bool:
        """维护版重算: 只填充缺失的 nextRunAt, 不推进已有值.

        【参考】OpenClaw jobs.ts  recomputeNextRunsForMaintenance()

        用于 timer tick 未找到到期 job 时, 防止静默跳过 (see OpenClaw #13992).
        """
        now = time.time()
        changed = False

        for job in jobs:
            state = job.setdefault("state", make_cron_job_state())

            if not job.get("enabled", False):
                if state.get("next_run_at") is not None:
                    state["next_run_at"] = None
                    changed = True
                continue

            # 只填充缺失值
            if state.get("next_run_at") is None:
                try:
                    new_next = compute_next_run_at(job.get("schedule", {}), now)
                    if new_next is not None:
                        state["next_run_at"] = new_next
                        changed = True
                except Exception:
                    pass

        return changed

    # ── 找到到期 job ──

    def _find_due_jobs(self, jobs: list[dict], now: float) -> list[dict]:
        """找到所有到期的 job.

        【参考】OpenClaw timer.ts  findDueJobs()
        """
        due = []
        for job in jobs:
            if not job.get("enabled", False):
                continue
            state = job.get("state", {})
            # 正在运行的不重复触发
            if isinstance(state.get("running_at"), (int, float)):
                continue
            next_run = state.get("next_run_at")
            if isinstance(next_run, (int, float)) and now >= next_run:
                due.append(job)
        return due

    # ── 执行核心 ──

    def _execute_job_core(
        self,
        job: dict,
        agent: AgentWithSoulMemory | None = None,
        session_store: S04SessionStore | None = None,
    ) -> dict:
        """执行一个 cron job 的核心逻辑.

        【参考】OpenClaw timer.ts  executeJobCore()

        main session:
          1. 将 payload.text 作为系统事件注入
          2. 根据 wakeMode 决定是否立即唤醒心跳
          → 心跳 runner 会在下次 tick 时处理该事件

        isolated session:
          1. 在独立 session 中运行 agent turn
          2. 根据 delivery 配置投递结果
        """
        session_target = job.get("session_target", "main")
        payload = job.get("payload", {})

        if session_target == "main":
            # ── main session: 系统事件 + 心跳唤醒 ──
            text = ""
            if payload.get("kind") == "systemEvent":
                text = payload.get("text", "").strip()
            elif payload.get("kind") == "agentTurn":
                text = payload.get("message", "").strip()
            else:
                return {"status": "skipped",
                        "error": "main job requires systemEvent or agentTurn payload"}

            if not text:
                return {"status": "skipped",
                        "error": "main job requires non-empty text"}

            # 注入系统事件
            if self._enqueue_system_event:
                self._enqueue_system_event(text)
            else:
                log.warning("cron: no enqueue_system_event callback, "
                            "cannot inject event for job %s", job.get("id"))

            # 根据 wakeMode 唤醒心跳
            wake_mode = job.get("wake_mode", "next-heartbeat")
            if wake_mode == "now":
                if self._run_heartbeat_once:
                    try:
                        result = self._run_heartbeat_once(
                            reason=f"cron:{job.get('id')}")
                        if result.get("status") == "sent":
                            return {"status": "ok", "summary": text}
                        elif result.get("status") == "skipped":
                            return {"status": "skipped",
                                    "error": result.get("reason"),
                                    "summary": text}
                    except Exception:
                        pass
                    # 回退到 requestHeartbeatNow
                    if self._request_heartbeat_now:
                        self._request_heartbeat_now(
                            reason=f"cron:{job.get('id')}")
                elif self._request_heartbeat_now:
                    self._request_heartbeat_now(
                        reason=f"cron:{job.get('id')}")
            else:
                # next-heartbeat: 只注入事件, 让正常心跳 tick 处理
                if self._request_heartbeat_now:
                    self._request_heartbeat_now(
                        reason=f"cron:{job.get('id')}")

            return {"status": "ok", "summary": text}

        elif session_target == "isolated":
            # ── isolated session: 独立 agent turn ──
            if payload.get("kind") != "agentTurn":
                return {"status": "skipped",
                        "error": "isolated job requires agentTurn payload"}

            message = payload.get("message", "").strip()
            if not message:
                return {"status": "skipped",
                        "error": "isolated job requires non-empty message"}

            # 使用回调执行隔离任务
            if self._run_isolated_agent_job:
                try:
                    res = self._run_isolated_agent_job(job=job, message=message)
                    return res
                except Exception as exc:
                    return {"status": "error", "error": str(exc)}

            # 没有回调时, 使用 run_agent_with_soul_and_memory
            if agent and session_store:
                session_key = f"cron:{job.get('id')}:run:{uuid.uuid4()}"
                try:
                    response = run_agent_with_soul_and_memory(
                        agent, session_store, session_key, message)
                    summary = (response or "")[:200]
                    return {"status": "ok", "summary": summary,
                            "session_key": session_key}
                except Exception as exc:
                    return {"status": "error", "error": str(exc)}

            return {"status": "error",
                    "error": "no execution callback for isolated job"}

        return {"status": "skipped",
                "error": f"unknown session_target: {session_target}"}

    # ── 应用执行结果 ──

    def _apply_job_result(
        self,
        job: dict,
        result: dict,
        started_at: float,
        ended_at: float,
    ) -> bool:
        """应用 job 执行结果到 state.

        【参考】OpenClaw timer.ts  applyJobResult()

        处理:
          - 连续错误跟踪 + 指数退避
          - one-shot 任务: 任何终态后 disable
          - delete_after_run: 成功后删除

        返回: 是否应该删除该 job
        """
        state = job.setdefault("state", make_cron_job_state())

        state["running_at"] = None
        state["last_run_at"] = started_at
        state["last_status"] = result.get("status", "error")
        state["last_duration_ms"] = max(0, (ended_at - started_at) * 1000)
        state["last_error"] = result.get("error")
        job["updated_at"] = ended_at

        # 连续错误跟踪
        if result.get("status") == "error":
            state["consecutive_errors"] = state.get("consecutive_errors", 0) + 1
        else:
            state["consecutive_errors"] = 0

        # 是否应该删除
        should_delete = (
            job.get("schedule", {}).get("kind") == "at"
            and job.get("delete_after_run") is True
            and result.get("status") == "ok"
        )

        if not should_delete:
            schedule_kind = job.get("schedule", {}).get("kind")

            if schedule_kind == "at":
                # 【关键】one-shot 任务: 任何终态后 disable
                # 防止 computeNextRunAt 返回过去时间导致循环重执行
                # 【参考】OpenClaw timer.ts applyJobResult() #11452
                job["enabled"] = False
                state["next_run_at"] = None
                if result.get("status") == "error":
                    log.warning("cron: disabling one-shot job %s after error",
                                job.get("id"))

            elif result.get("status") == "error" and job.get("enabled"):
                # 指数退避
                backoff = error_backoff_seconds(
                    state.get("consecutive_errors", 1))
                normal_next = compute_next_run_at(
                    job.get("schedule", {}), ended_at)
                backoff_next = ended_at + backoff
                # 取较大值
                state["next_run_at"] = (
                    max(normal_next, backoff_next) if normal_next else backoff_next
                )
                log.info("cron: applying error backoff for job %s "
                         "(errors=%d, backoff=%.0fs)",
                         job.get("id"),
                         state.get("consecutive_errors"),
                         backoff)

            elif job.get("enabled"):
                state["next_run_at"] = compute_next_run_at(
                    job.get("schedule", {}), ended_at)

            else:
                state["next_run_at"] = None

        return should_delete

    # ── 完整执行流程 ──

    def _execute_job(
        self,
        job: dict,
        now: float,
        *,
        agent: AgentWithSoulMemory | None = None,
        session_store: S04SessionStore | None = None,
    ) -> dict:
        """执行一个 cron job 的完整流程.

        【参考】OpenClaw timer.ts  executeJob()
        """
        job_id = job.get("id", "?")
        state = job.setdefault("state", make_cron_job_state())

        started_at = time.time()
        state["running_at"] = started_at
        state["last_error"] = None

        # 发射 started 事件
        self._emit(emit_cron_event(job_id, "started", run_at=started_at))

        # 执行核心
        try:
            core_result = self._execute_job_core(
                job, agent=agent, session_store=session_store)
        except Exception as exc:
            core_result = {"status": "error", "error": str(exc)}

        ended_at = time.time()

        # 应用结果
        should_delete = self._apply_job_result(
            job, core_result, started_at, ended_at)

        # 发射 finished 事件
        self._emit(emit_cron_event(
            job_id, "finished",
            status=core_result.get("status"),
            error=core_result.get("error"),
            summary=core_result.get("summary"),
            run_at=started_at,
            duration_ms=state.get("last_duration_ms"),
            next_run_at=state.get("next_run_at"),
        ))

        # 追加 run log
        log_entry = {
            "ts": ended_at,
            "job_id": job_id,
            "action": "finished",
            "status": core_result.get("status"),
            "error": core_result.get("error"),
            "summary": (core_result.get("summary") or "")[:200],
            "duration_ms": state.get("last_duration_ms"),
            "next_run_at": state.get("next_run_at"),
        }
        self.run_log.append(job_id, log_entry)

        # 对 isolated 任务: 如果 delivery 是 announce 且有内容,
        # 向 main session 注入摘要
        # 【参考】OpenClaw timer.ts executeJobCore() — main session summary
        if (job.get("session_target") == "isolated"
                and core_result.get("status") == "ok"):
            summary = core_result.get("summary", "").strip()
            delivery_plan = resolve_cron_delivery_plan(job)
            delivered = core_result.get("delivered", False)
            if summary and delivery_plan["requested"] and not delivered:
                label = f"Cron: {summary}"
                if self._enqueue_system_event:
                    self._enqueue_system_event(label)
                if job.get("wake_mode") == "now" and self._request_heartbeat_now:
                    self._request_heartbeat_now(reason=f"cron:{job_id}")

        return {
            "job_id": job_id,
            "should_delete": should_delete,
            **core_result,
        }

    # ── 后台循环 ──

    def _background_loop(
        self,
        *,
        agent: AgentWithSoulMemory | None = None,
        session_store: S04SessionStore | None = None,
    ) -> None:
        """后台调度循环.

        【参考】OpenClaw timer.ts  onTimer()

        每秒:
          1. 加载 jobs
          2. 找到到期 job
          3. 如果有到期 job: 标记 running → 执行 → 更新结果
          4. 如果无到期 job: maintenance recompute
          5. 持久化
        """
        log.info("cron service started (enabled=%s)", self.cron_enabled)

        # 启动时清理卡住的 running 标记
        # 【参考】OpenClaw ops.ts  start()
        def _startup_cleanup(jobs: list[dict]) -> None:
            now = time.time()
            for job in jobs:
                state = job.get("state", {})
                if isinstance(state.get("running_at"), (int, float)):
                    log.warning("cron: clearing stale running marker for "
                                "job %s on startup", job.get("id"))
                    state["running_at"] = None
            self._recompute_next_runs(jobs)

        self.store.mutate_all(_startup_cleanup)

        while not self._stop_event.is_set():
            if not self.cron_enabled:
                self._stop_event.wait(1.0)
                continue

            if self._running:
                self._stop_event.wait(1.0)
                continue

            self._running = True
            try:
                jobs = self.store.load()
                now = time.time()
                due = self._find_due_jobs(jobs, now)

                if not due:
                    # 维护: 只填充缺失值
                    if self._recompute_next_runs_for_maintenance(jobs):
                        self.store.save(jobs)
                else:
                    # 标记 running
                    for job in due:
                        job.setdefault("state", make_cron_job_state())
                        job["state"]["running_at"] = now
                    self.store.save(jobs)

                    # 逐个执行
                    for job in due:
                        if self._stop_event.is_set():
                            break

                        result = self._execute_job(
                            job, now,
                            agent=agent,
                            session_store=session_store,
                        )

                        # 输出到队列
                        with self._output_lock:
                            self._output_queue.append(result)

                    # 处理 delete_after_run
                    jobs = self.store.load()
                    to_delete = []
                    for result in self.drain_output_internal():
                        if result.get("should_delete"):
                            to_delete.append(result.get("job_id"))

                    if to_delete:
                        jobs = [j for j in jobs if j.get("id") not in to_delete]
                        for job_id in to_delete:
                            self._emit(emit_cron_event(job_id, "removed"))

                    # 重算所有 nextRunAt
                    self._recompute_next_runs(jobs)
                    self.store.save(jobs)

            except Exception as exc:
                log.error("cron service error: %s", exc)

            finally:
                self._running = False

            self._stop_event.wait(1.0)

        log.info("cron service stopped")

    def drain_output_internal(self) -> list[dict]:
        """内部用: 取出但不清空输出队列."""
        with self._output_lock:
            return self._output_queue[:]

    def drain_output(self) -> list[dict]:
        """取出所有待输出的 cron 结果. 由主线程调用."""
        with self._output_lock:
            results = self._output_queue[:]
            self._output_queue.clear()
            return results

    # ── 公共 API ──

    def start(
        self,
        *,
        agent: AgentWithSoulMemory | None = None,
        session_store: S04SessionStore | None = None,
    ) -> None:
        """启动后台调度线程.

        【参考】OpenClaw ops.ts  start()
        """
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._background_loop,
            kwargs={"agent": agent, "session_store": session_store},
            daemon=True,
            name="cron-service",
        )
        self._thread.start()

    def stop(self) -> None:
        """停止后台调度线程."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None

    def status(self) -> dict:
        """查询调度器状态.

        【参考】OpenClaw ops.ts  status()
        """
        jobs = self.store.load()
        enabled_jobs = [j for j in jobs if j.get("enabled")]
        with_next = [j for j in enabled_jobs
                     if isinstance(j.get("state", {}).get("next_run_at"),
                                   (int, float))]
        next_wake = None
        if with_next:
            next_wake = min(j["state"]["next_run_at"] for j in with_next)

        return {
            "enabled": self.cron_enabled,
            "store_path": str(self.store.store_path),
            "jobs": len(jobs),
            "next_wake_at": next_wake,
        }

    def add_job(self, job: dict) -> dict:
        """添加一个 job.

        【参考】OpenClaw ops.ts  add()
        """
        self.store.add_job(job)
        self._emit(emit_cron_event(
            job["id"], "added",
            next_run_at=job.get("state", {}).get("next_run_at"),
        ))
        log.info("cron: job added: id=%s name=%s next=%s",
                 job["id"], job.get("name"),
                 job.get("state", {}).get("next_run_at"))
        return job

    def remove_job(self, job_id: str) -> dict:
        """删除一个 job.

        【参考】OpenClaw ops.ts  remove()
        """
        removed = self.store.remove_job(job_id)
        if removed:
            self._emit(emit_cron_event(job_id, "removed"))
        return {"ok": True, "removed": removed}

    def update_job(self, job_id: str, patch: dict) -> dict | None:
        """更新一个 job.

        【参考】OpenClaw ops.ts  update()
        """
        job = self.store.find_job(job_id)
        if job is None:
            return None

        now = time.time()
        schedule_changed = False

        def _apply(j: dict) -> None:
            nonlocal schedule_changed
            if "name" in patch:
                j["name"] = patch["name"]
            if "description" in patch:
                j["description"] = patch["description"]
            if "enabled" in patch:
                j["enabled"] = patch["enabled"]
            if "delete_after_run" in patch:
                j["delete_after_run"] = patch["delete_after_run"]
            if "schedule" in patch:
                j["schedule"] = patch["schedule"]
                schedule_changed = True
            if "session_target" in patch:
                j["session_target"] = patch["session_target"]
            if "wake_mode" in patch:
                j["wake_mode"] = patch["wake_mode"]
            if "payload" in patch:
                j["payload"] = patch["payload"]
            if "delivery" in patch:
                j["delivery"] = patch["delivery"]
            j["updated_at"] = now

            # 重算 nextRunAt
            if schedule_changed or "enabled" in patch:
                if j.get("enabled"):
                    j.setdefault("state", make_cron_job_state())
                    j["state"]["next_run_at"] = compute_next_run_at(
                        j.get("schedule", {}), now)
                else:
                    j.setdefault("state", make_cron_job_state())
                    j["state"]["next_run_at"] = None
                    j["state"]["running_at"] = None

        self.store.update_job_in_store(job_id, _apply)
        updated = self.store.find_job(job_id)

        if updated:
            self._emit(emit_cron_event(
                job_id, "updated",
                next_run_at=updated.get("state", {}).get("next_run_at"),
            ))

        return updated

    def run_job(self, job_id: str, *, mode: str = "force",
                agent: AgentWithSoulMemory | None = None,
                session_store: S04SessionStore | None = None) -> dict:
        """手动执行一个 job.

        【参考】OpenClaw ops.ts  run()
        """
        job = self.store.find_job(job_id)
        if job is None:
            return {"ok": False, "error": f"unknown job: {job_id}"}

        state = job.get("state", {})
        if isinstance(state.get("running_at"), (int, float)):
            return {"ok": True, "ran": False, "reason": "already-running"}

        if mode != "force":
            now = time.time()
            next_run = state.get("next_run_at")
            if not (isinstance(next_run, (int, float)) and now >= next_run):
                return {"ok": True, "ran": False, "reason": "not-due"}

        result = self._execute_job(
            job, time.time(),
            agent=agent, session_store=session_store,
        )

        # 持久化
        jobs = self.store.load()
        self._recompute_next_runs(jobs)
        self.store.save(jobs)

        return {"ok": True, "ran": True, **result}

    def wake(self, *, mode: str = "now", text: str) -> dict:
        """即时系统事件 (无需创建 job).

        【参考】OpenClaw ops.ts  wakeNow()
        """
        text = text.strip()
        if not text:
            return {"ok": False}
        if self._enqueue_system_event:
            self._enqueue_system_event(text)
        if mode == "now" and self._request_heartbeat_now:
            self._request_heartbeat_now(reason="wake")
        return {"ok": True}



# ============================================================================
# Part 9: Cron Agent 工具定义
# ============================================================================
#
# Agent 可用的 cron 工具:
#   - cron_create: 创建调度任务
#   - cron_list: 列出所有任务
#   - cron_delete: 删除任务
#   - cron_update: 更新任务
#
# 这些工具与 s06 的 memory 工具 和 s04 的 channel 工具组合使用.
# ============================================================================


CRON_TOOL_NAMES = {"cron_create", "cron_list", "cron_delete", "cron_update"}


def build_cron_tools() -> list[dict]:
    """构建 cron 工具定义 (OpenAI function calling 格式).

    与 s06 的 build_memory_tools() 类似, 用于 LLM 工具调用.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "cron_create",
                "description": (
                    "Create a new scheduled cron job. "
                    "schedule_type: 'at' for one-shot absolute time, "
                    "'every' for interval-based, 'cron' for cron expressions.\n"
                    "schedule_value: ISO datetime for 'at', seconds for 'every', "
                    "cron expression for 'cron' (e.g. '0 9 * * 1').\n"
                    "message: the instruction to execute when the job fires.\n"
                    "delete_after_run: true for one-shot jobs."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Human-readable name for the job.",
                        },
                        "schedule_type": {
                            "type": "string",
                            "description": "One of: 'at', 'every', 'cron'.",
                        },
                        "schedule_value": {
                            "type": "string",
                            "description": (
                                "ISO datetime for 'at', integer seconds for 'every', "
                                "cron expression for 'cron'."
                            ),
                        },
                        "message": {
                            "type": "string",
                            "description": "The instruction to execute when the job fires.",
                        },
                        "delete_after_run": {
                            "type": "boolean",
                            "description": "If true, job is disabled after first success.",
                        },
                    },
                    "required": ["name", "schedule_type", "schedule_value", "message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "cron_list",
                "description": "List all cron jobs with status, schedule, and next run time.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "include_disabled": {
                            "type": "boolean",
                            "description": "Include disabled jobs. Default true.",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "cron_delete",
                "description": "Delete a cron job by its ID.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "job_id": {
                            "type": "string",
                            "description": "The ID of the cron job to delete.",
                        },
                    },
                    "required": ["job_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "cron_update",
                "description": "Update a cron job (enable/disable, change schedule, etc.).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "job_id": {
                            "type": "string",
                            "description": "The ID of the cron job to update.",
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "Enable or disable the job.",
                        },
                        "name": {
                            "type": "string",
                            "description": "New name for the job.",
                        },
                        "schedule_type": {
                            "type": "string",
                            "description": "New schedule type.",
                        },
                        "schedule_value": {
                            "type": "string",
                            "description": "New schedule value.",
                        },
                        "message": {
                            "type": "string",
                            "description": "New message/instruction.",
                        },
                    },
                    "required": ["job_id"],
                },
            },
        },
    ]


def handle_cron_tool(
    tool_name: str,
    params: dict,
    cron_service: CronService,
) -> str:
    """处理 cron 工具调用, 返回 JSON 结果.

    与 s06 的 handle_memory_tool 类似的接口.
    """
    if tool_name == "cron_create":
        return _handle_cron_create(params, cron_service)
    if tool_name == "cron_list":
        return _handle_cron_list(params, cron_service)
    if tool_name == "cron_delete":
        return _handle_cron_delete(params, cron_service)
    if tool_name == "cron_update":
        return _handle_cron_update(params, cron_service)
    return json.dumps({"error": f"unknown cron tool: {tool_name}"})


def _handle_cron_create(params: dict, svc: CronService) -> str:
    """处理 cron_create 工具调用."""
    name = params.get("name", "unnamed job")
    schedule_type = params.get("schedule_type", "")
    schedule_value = params.get("schedule_value", "")
    message = params.get("message", "")
    delete_after_run = params.get("delete_after_run")

    # 构建 schedule
    if schedule_type == "at":
        schedule = {"kind": "at", "at": schedule_value}
        if delete_after_run is None:
            delete_after_run = True
    elif schedule_type == "every":
        try:
            every_s = int(schedule_value)
        except (ValueError, TypeError):
            return json.dumps({"error": f"Invalid interval: {schedule_value}"})
        schedule = {"kind": "every", "every_s": every_s}
    elif schedule_type == "cron":
        if croniter is not None:
            try:
                croniter(schedule_value)
            except (ValueError, KeyError) as exc:
                return json.dumps({"error": f"Invalid cron expression: {exc}"})
        schedule = {"kind": "cron", "expr": schedule_value}
    else:
        return json.dumps({"error": f"Unknown schedule_type: {schedule_type}"})

    # main session → systemEvent; isolated → agentTurn
    payload = {"kind": "systemEvent", "text": message}

    job = make_cron_job(
        name=name,
        schedule=schedule,
        payload=payload,
        delete_after_run=delete_after_run or False,
    )

    svc.add_job(job)

    next_run = job.get("state", {}).get("next_run_at")
    next_str = ""
    if next_run:
        next_str = datetime.fromtimestamp(next_run).strftime("%Y-%m-%d %H:%M:%S")

    return json.dumps({
        "status": "created",
        "job_id": job["id"],
        "name": name,
        "schedule_type": schedule_type,
        "next_run": next_str,
        "delete_after_run": job.get("delete_after_run"),
    })


def _handle_cron_list(params: dict, svc: CronService) -> str:
    """处理 cron_list 工具调用."""
    include_disabled = params.get("include_disabled", True)
    jobs = svc.store.load()

    result = []
    for job in jobs:
        if not include_disabled and not job.get("enabled", False):
            continue
        state = job.get("state", {})
        schedule = job.get("schedule", {})
        next_run = state.get("next_run_at")
        next_str = ""
        if isinstance(next_run, (int, float)):
            next_str = datetime.fromtimestamp(next_run).strftime(
                "%Y-%m-%d %H:%M:%S")
        last_run = state.get("last_run_at")
        last_str = ""
        if isinstance(last_run, (int, float)):
            last_str = datetime.fromtimestamp(last_run).strftime(
                "%Y-%m-%d %H:%M:%S")

        result.append({
            "id": job.get("id"),
            "name": job.get("name"),
            "enabled": job.get("enabled", False),
            "schedule": schedule,
            "session_target": job.get("session_target", "main"),
            "wake_mode": job.get("wake_mode", "next-heartbeat"),
            "next_run": next_str,
            "last_run": last_str,
            "last_status": state.get("last_status"),
            "consecutive_errors": state.get("consecutive_errors", 0),
            "delete_after_run": job.get("delete_after_run", False),
        })

    return json.dumps({"jobs": result, "total": len(result)})


def _handle_cron_delete(params: dict, svc: CronService) -> str:
    """处理 cron_delete 工具调用."""
    job_id = params.get("job_id", "")
    result = svc.remove_job(job_id)
    if result.get("removed"):
        return json.dumps({"status": "deleted", "job_id": job_id})
    return json.dumps({"error": f"Job not found: {job_id}"})


def _handle_cron_update(params: dict, svc: CronService) -> str:
    """处理 cron_update 工具调用."""
    job_id = params.get("job_id", "")
    if not job_id:
        return json.dumps({"error": "job_id required"})

    patch: dict[str, Any] = {}
    if "enabled" in params:
        patch["enabled"] = params["enabled"]
    if "name" in params:
        patch["name"] = params["name"]
    if "message" in params:
        patch["payload"] = {"kind": "systemEvent", "text": params["message"]}

    # 处理 schedule 更新
    st = params.get("schedule_type")
    sv = params.get("schedule_value")
    if st and sv:
        if st == "at":
            patch["schedule"] = {"kind": "at", "at": sv}
        elif st == "every":
            try:
                patch["schedule"] = {"kind": "every", "every_s": int(sv)}
            except (ValueError, TypeError):
                return json.dumps({"error": f"Invalid interval: {sv}"})
        elif st == "cron":
            patch["schedule"] = {"kind": "cron", "expr": sv}

    updated = svc.update_job(job_id, patch)
    if updated is None:
        return json.dumps({"error": f"Job not found: {job_id}"})

    return json.dumps({
        "status": "updated",
        "job_id": job_id,
        "job": {
            "name": updated.get("name"),
            "enabled": updated.get("enabled"),
            "next_run_at": updated.get("state", {}).get("next_run_at"),
        },
    })



# ============================================================================
# Part 10: CronGateway — 继承 HeartbeatGateway, 增加 Cron RPC
# ============================================================================
#
# 在 s07 的 HeartbeatGateway 基础上增加:
#   - CronService 后台线程
#   - 新增 RPC: cron.list / cron.status / cron.add / cron.update
#     / cron.remove / cron.run / cron.runs / wake
#   - Cron 事件通过 WebSocket 广播给所有客户端
#
# 继承链: CronGateway → HeartbeatGateway → SoulMemoryGateway
# ============================================================================


class CronGateway(HeartbeatGateway):
    """带 Cron 的 WebSocket 网关 — 继承 HeartbeatGateway 全部功能.

    【参考】OpenClaw src/gateway/server-cron.ts  buildGatewayCronService()
    【参考】OpenClaw src/gateway/server-methods/cron.ts  cronHandlers

    新增:
      - CronService 后台调度线程
      - cron.* RPC 方法
      - wake RPC: 即时系统事件
      - Cron 事件广播
    """

    def __init__(
        self,
        host: str,
        port: int,
        router: MessageRouter,
        sessions: S04SessionStore,
        soul_agents: dict[str, AgentWithSoulMemory],
        token: str = "",
        *,
        heartbeat_interval: int = DEMO_HEARTBEAT_INTERVAL,
        active_start: str = HEARTBEAT_ACTIVE_START,
        active_end: str = HEARTBEAT_ACTIVE_END,
        cron_store_path: Path | None = None,
        cron_enabled: bool = True,
    ) -> None:
        super().__init__(
            host, port, router, sessions, soul_agents, token,
            heartbeat_interval=heartbeat_interval,
            active_start=active_start,
            active_end=active_end,
        )

        # 初始化 CronStore + CronRunLog
        cron_dir = (cron_store_path or WORKSPACE_DIR / "cron")
        if cron_store_path and cron_store_path.suffix == ".json":
            store_path = cron_store_path
            runs_dir = cron_store_path.parent / "runs"
        else:
            cron_dir.mkdir(parents=True, exist_ok=True)
            store_path = cron_dir / "jobs.json"
            runs_dir = cron_dir / "runs"

        self._cron_store = CronStore(store_path)
        self._cron_run_log = CronRunLog(runs_dir)

        # 获取默认 agent + heartbeat runner (用于心跳集成)
        default_agent_id = router.default_agent
        default_agent = soul_agents.get(default_agent_id)
        if default_agent is None:
            default_agent = next(iter(soul_agents.values()))

        default_runner = self._heartbeat_runners.get(default_agent_id)

        # 创建 CronService
        # 【参考】OpenClaw server-cron.ts  buildGatewayCronService()
        self._cron_service = CronService(
            self._cron_store,
            self._cron_run_log,
            cron_enabled=cron_enabled,
            enqueue_system_event=lambda text: log.info(
                "cron system event: %s", text[:100]),
            request_heartbeat_now=lambda reason="cron": (
                default_runner and setattr(
                    default_runner, 'last_run', 0)  # 强制下次 tick 执行
            ),
            run_heartbeat_once=lambda reason="cron": (
                default_runner.run_heartbeat_once() if default_runner else
                {"status": "skipped", "reason": "no-runner"}
            ),
            run_isolated_agent_job=lambda job, message: (
                self._run_isolated_cron_job(job, message, soul_agents, sessions)
            ),
            on_event=lambda evt: self._broadcast_cron_event(evt),
        )

        # 注册 Cron RPC 方法
        self._methods["cron.status"] = self._handle_cron_status
        self._methods["cron.list"] = self._handle_cron_list
        self._methods["cron.add"] = self._handle_cron_add
        self._methods["cron.update"] = self._handle_cron_update
        self._methods["cron.remove"] = self._handle_cron_remove
        self._methods["cron.run"] = self._handle_cron_run
        self._methods["cron.runs"] = self._handle_cron_runs
        self._methods["wake"] = self._handle_wake

    def _run_isolated_cron_job(
        self,
        job: dict,
        message: str,
        soul_agents: dict[str, AgentWithSoulMemory],
        sessions: S04SessionStore,
    ) -> dict:
        """执行隔离 cron job: 在独立 session 中运行 agent turn.

        【参考】OpenClaw src/cron/isolated-agent/run.ts  runCronIsolatedAgentTurn()
        """
        agent_id = job.get("agent_id") or self.router.default_agent
        agent = soul_agents.get(agent_id)
        if agent is None:
            agent = next(iter(soul_agents.values()))

        session_key = f"cron:{job.get('id')}:run:{uuid.uuid4()}"

        try:
            response = run_agent_with_soul_and_memory(
                agent, sessions, session_key, message)
            summary = (response or "")[:200]
            return {
                "status": "ok",
                "summary": summary,
                "session_key": session_key,
            }
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def _broadcast_cron_event(self, payload: dict) -> None:
        """广播 cron 事件给所有客户端.

        【参考】OpenClaw server-cron.ts  onEvent → broadcast("cron", evt)
        """
        event_str = make_event("cron", payload)
        for client in list(self.clients.values()):
            try:
                asyncio.get_event_loop().call_soon_threadsafe(
                    asyncio.ensure_future,
                    client.ws.send(event_str),
                )
            except Exception:
                pass

    # ── RPC Handlers ──

    async def _handle_cron_status(self, client: ConnectedClient,
                                  params: dict) -> dict:
        """cron.status — 查询调度器状态."""
        return self._cron_service.status()

    async def _handle_cron_list(self, client: ConnectedClient,
                                params: dict) -> dict:
        """cron.list — 列出所有 job."""
        include_disabled = params.get("include_disabled", True)
        jobs = self._cron_store.load()
        if not include_disabled:
            jobs = [j for j in jobs if j.get("enabled")]
        # 按 nextRunAt 排序
        jobs.sort(key=lambda j: j.get("state", {}).get("next_run_at") or 0)
        return {"jobs": jobs}

    async def _handle_cron_add(self, client: ConnectedClient,
                               params: dict) -> dict:
        """cron.add — 创建 job."""
        try:
            name = params.get("name", "unnamed")
            schedule = params.get("schedule", {})
            payload = params.get("payload", {})
            session_target = params.get("session_target", "main")
            wake_mode = params.get("wake_mode", "next-heartbeat")
            delivery = params.get("delivery")
            delete_after_run = params.get("delete_after_run")

            job = make_cron_job(
                name=name,
                schedule=schedule,
                payload=payload,
                session_target=session_target,
                wake_mode=wake_mode,
                delivery=delivery,
                delete_after_run=delete_after_run,
                agent_id=params.get("agent_id"),
                description=params.get("description"),
            )
            return self._cron_service.add_job(job)
        except Exception as exc:
            return {"error": str(exc)}

    async def _handle_cron_update(self, client: ConnectedClient,
                                  params: dict) -> dict:
        """cron.update — 更新 job."""
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            return {"error": "missing id"}
        patch = params.get("patch", params)
        result = self._cron_service.update_job(job_id, patch)
        if result is None:
            return {"error": f"unknown job: {job_id}"}
        return result

    async def _handle_cron_remove(self, client: ConnectedClient,
                                  params: dict) -> dict:
        """cron.remove — 删除 job."""
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            return {"error": "missing id"}
        return self._cron_service.remove_job(job_id)

    async def _handle_cron_run(self, client: ConnectedClient,
                               params: dict) -> dict:
        """cron.run — 手动执行 job."""
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            return {"error": "missing id"}
        mode = params.get("mode", "force")
        return self._cron_service.run_job(job_id, mode=mode)

    async def _handle_cron_runs(self, client: ConnectedClient,
                                params: dict) -> dict:
        """cron.runs — 查询 job 运行历史."""
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            return {"error": "missing id"}
        limit = params.get("limit", 200)
        entries = self._cron_run_log.read_recent(job_id, limit=limit)
        return {"entries": entries}

    async def _handle_wake(self, client: ConnectedClient,
                           params: dict) -> dict:
        """wake — 即时系统事件 (不创建 job)."""
        mode = params.get("mode", "now")
        text = params.get("text", "")
        return self._cron_service.wake(mode=mode, text=text)

    # ── 生命周期 ──

    async def start(self) -> None:
        """启动网关 + 心跳 + Cron."""
        # 获取默认 agent 用于 cron 执行
        default_agent_id = self.router.default_agent
        default_agent = self._soul_agents.get(default_agent_id)
        if default_agent is None:
            default_agent = next(iter(self._soul_agents.values()))

        self._cron_service.start(
            agent=default_agent,
            session_store=self._sessions,
        )
        log.info("cron service started (%d jobs)",
                 len(self._cron_store.load()))

        try:
            await super().start()
        finally:
            self._cron_service.stop()



# ============================================================================
# Part 11: run_repl_with_cron — 扩展 s07 REPL, 加入 Cron 命令
# ============================================================================
#
# 在 s07 run_repl_with_heartbeat 的基础上增加:
#   - CronService 后台线程
#   - /cron 命令: 列出所有 cron job
#   - /cron-add 命令: 通过 REPL 创建 job
#   - /cron-delete <id> 命令: 删除 job
#   - /cron-run <id> 命令: 手动触发 job
#   - /cron-log <id> 命令: 查看 job 运行日志
#   - /cron-status 命令: 查看调度器状态
#   - 每次等待输入前, 检查并输出 cron 结果
# ============================================================================


def _ensure_sample_cron_jobs(cron_service: CronService) -> None:
    """为空的 cron store 创建示例 job.

    【参考】OpenClaw docs/automation/cron-jobs.md
    """
    jobs = cron_service.store.load()
    if jobs:
        return

    # 示例 1: 每分钟检查 (演示用)
    demo_cron = make_cron_job(
        name="demo-every-minute",
        schedule={"kind": "cron", "expr": "* * * * *"},
        payload={"kind": "systemEvent",
                 "text": "Scheduled check: briefly state current status."},
        enabled=False,  # 默认禁用
    )

    # 示例 2: 每 90 秒 (演示用)
    demo_every = make_cron_job(
        name="demo-every-90s",
        schedule={"kind": "every", "every_s": 90},
        payload={"kind": "systemEvent",
                 "text": "Interval check: give a brief status update."},
        enabled=False,
    )

    cron_service.store.save([demo_cron, demo_every])
    print_info("Created sample cron jobs (both disabled by default)")


def run_repl_with_cron(
    router: MessageRouter,
    soul_agents: dict[str, AgentWithSoulMemory],
    session_store: S04SessionStore,
    heartbeat_interval: int = DEMO_HEARTBEAT_INTERVAL,
    active_start: str = HEARTBEAT_ACTIVE_START,
    active_end: str = HEARTBEAT_ACTIVE_END,
    cron_store_path: Path | None = None,
) -> None:
    """交互式 REPL: s07 全部功能 + Cron 调度.

    包含 s07 run_repl_with_heartbeat 的所有命令 + cron 命令.
    """
    default_agent_id = router.default_agent
    current_agent = soul_agents.get(default_agent_id)
    if current_agent is None:
        current_agent = next(iter(soul_agents.values()))
    session_key = f"repl:{current_agent.id}:local"

    # 创建心跳 runner (复用 s07 的 HeartbeatRunner)
    heartbeat = HeartbeatRunner(
        agent=current_agent,
        session_store=session_store,
        session_key=session_key,
        interval_seconds=heartbeat_interval,
        active_start=active_start,
        active_end=active_end,
    )

    # 创建 CronService
    cron_dir = cron_store_path or (WORKSPACE_DIR / "cron")
    cron_dir.mkdir(parents=True, exist_ok=True)
    cron_store = CronStore(cron_dir / "jobs.json")
    cron_run_log = CronRunLog(cron_dir / "runs")

    cron_service = CronService(
        cron_store,
        cron_run_log,
        cron_enabled=True,
        request_heartbeat_now=lambda reason="cron": setattr(
            heartbeat, 'last_run', 0),
        run_heartbeat_once=lambda reason="cron": (
            heartbeat.run_heartbeat_once()),
    )

    # 创建示例 jobs
    _ensure_sample_cron_jobs(cron_service)

    print_info("=" * 70)
    print_info("  Mini-Claw REPL  |  Section 08: Cron Scheduler")
    print_info(f"  Agent: {current_agent.id}")
    print_info(f"  Model: {current_agent.model}")
    print_info(f"  Workspace: {current_agent.workspace_dir}")
    print_info(f"  Heartbeat: every {heartbeat_interval}s "
               f"(active {active_start}-{active_end})")
    print_info(f"  Cron: {len(cron_store.load())} jobs loaded")
    print_info("")
    print_info("  Commands (s06/s07 inherited):")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current agent's soul")
    print_info("    /memory            - View memory status")
    print_info("    /route <ch> <sender> [kind] [guild]")
    print_info("    /switch <agent_id> - Switch agent")
    print_info("    /agents            - List all agents")
    print_info("    /bindings          - List routing bindings")
    print_info("    /heartbeat         - Heartbeat status")
    print_info("    /trigger           - Trigger heartbeat")
    print_info("  Commands (s08 new — cron):")
    print_info("    /cron              - List all cron jobs")
    print_info("    /cron-status       - Scheduler status")
    print_info("    /cron-run <id>     - Manually trigger a cron job")
    print_info("    /cron-delete <id>  - Delete a cron job")
    print_info("    /cron-log <id>     - View job run history")
    print_info("    (anything else)    - Chat with current agent")
    print_info("=" * 70)
    print()

    # 显示 Soul 状态
    if current_agent.soul_path.exists():
        soul_content = current_agent.soul_path.read_text(encoding="utf-8").strip()
        first_line = soul_content.split("\n")[0].strip()
        print_info(f"Soul loaded: {first_line}")

    # 显示 Heartbeat 状态
    hb_content = load_heartbeat_file(current_agent.workspace_dir)
    if hb_content and not is_heartbeat_content_effectively_empty(hb_content):
        print_info(f"HEARTBEAT.md loaded ({len(hb_content)} chars)")
    else:
        print_info("HEARTBEAT.md not found or empty")

    if croniter is None:
        print(f"{YELLOW}Warning: croniter not installed. "
              f"'cron' schedule type will not work.{RESET}")
        print(f"{DIM}Install with: pip install croniter{RESET}")
    print()

    # 启动后台循环
    heartbeat.start()
    print_info(f"Heartbeat started (interval={heartbeat_interval}s)")
    cron_service.start(agent=current_agent, session_store=session_store)
    print_info(f"Cron service started ({len(cron_store.load())} jobs)")
    print()

    try:
        while True:
            # ── 心跳输出 ──
            for result in heartbeat.drain_output():
                if result["status"] == HEARTBEAT_STATUS_SENT and result["text"]:
                    print_heartbeat(result["text"])
                elif (result["status"] == HEARTBEAT_STATUS_FAILED
                      and result.get("reason")):
                    print(f"  {RED}[heartbeat error] "
                          f"{result['reason']}{RESET}")

            # ── Cron 输出 ──
            for result in cron_service.drain_output():
                status = result.get("status", "?")
                job_id = result.get("job_id", "?")
                summary = result.get("summary", "")
                if status == "ok" and summary:
                    print_cron(f"Job {job_id}: {summary}")
                elif status == "error":
                    print(f"  {RED}[cron error] Job {job_id}: "
                          f"{result.get('error', '?')}{RESET}")

            try:
                user_input = input(colored_prompt()).strip()
            except (KeyboardInterrupt, EOFError):
                print(f"\n{DIM}Goodbye.{RESET}")
                break

            if not user_input:
                continue

            if user_input.lower() in ("/quit", "/exit"):
                print(f"{DIM}Goodbye.{RESET}")
                break

            # ── s06/s07 继承的命令 ──

            if user_input == "/soul":
                sp = current_agent.soul_path
                if sp.exists():
                    print(f"\n{MAGENTA}--- {current_agent.id.upper()} "
                          f"SOUL ---{RESET}")
                    print(sp.read_text(encoding="utf-8").strip())
                    print(f"{MAGENTA}--- end ---{RESET}\n")
                else:
                    print_info(f"No soul file at {sp}\n")
                continue

            if user_input == "/memory":
                mgr = get_memory_manager(current_agent)
                evergreen = mgr.load_evergreen()
                recent = mgr.get_recent_daily(days=7)
                print(f"\n{MAGENTA}--- Memory Status "
                      f"({current_agent.id}) ---{RESET}")
                print(f"Workspace: {current_agent.workspace_dir}")
                if evergreen:
                    print(f"MEMORY.md: {len(evergreen)} chars")
                else:
                    print("MEMORY.md: (not found)")
                print(f"Recent daily logs: {len(recent)} files")
                for entry in recent:
                    lines_cnt = entry["content"].count("\n") + 1
                    print(f"  {entry['date']}: {lines_cnt} lines")
                print(f"{MAGENTA}--- end ---{RESET}\n")
                continue

            if user_input == "/bindings":
                print(router.describe_bindings())
                continue

            if user_input == "/agents":
                for aid, a in soul_agents.items():
                    marker = " <--" if aid == current_agent.id else ""
                    has_soul = "soul" if a.soul_path.exists() else "    "
                    has_hb = "hb" if (
                        a.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
                    ).exists() else "  "
                    print(f"  {aid:<12} model={a.model:<16} "
                          f"[{has_soul}|{has_hb}]"
                          f" workspace={a.workspace_dir}{marker}")
                continue

            if user_input.startswith("/route "):
                parts = user_input[7:].split()
                if len(parts) < 2:
                    print("  Usage: /route <channel> <sender> "
                          "[kind] [guild_id]")
                    continue
                channel = parts[0]
                sender = parts[1]
                peer_kind = parts[2] if len(parts) > 2 else "direct"
                guild_id = parts[3] if len(parts) > 3 else None
                agent_cfg, sk = router.resolve(
                    channel=channel, sender=sender,
                    peer_kind=peer_kind, guild_id=guild_id,
                )
                sa = soul_agents.get(agent_cfg.id)
                has_soul = sa and sa.soul_path.exists()
                print(f"  Agent:       {agent_cfg.id} ({agent_cfg.model})")
                print(f"  Session Key: {sk}")
                print(f"  Prompt:      {agent_cfg.system_prompt[:80]}...")
                print(f"  Soul:        {'Yes' if has_soul else 'No'}")
                continue

            if user_input.startswith("/switch "):
                new_id = user_input[8:].strip()
                if new_id in soul_agents:
                    heartbeat.stop()
                    cron_service.stop()
                    current_agent = soul_agents[new_id]
                    session_key = f"repl:{current_agent.id}:local"
                    heartbeat = HeartbeatRunner(
                        agent=current_agent,
                        session_store=session_store,
                        session_key=session_key,
                        interval_seconds=heartbeat_interval,
                        active_start=active_start,
                        active_end=active_end,
                    )
                    heartbeat.start()
                    cron_service.start(
                        agent=current_agent,
                        session_store=session_store,
                    )
                    print_info(f"Switched to agent: {current_agent.id}")
                    print_info(f"Heartbeat + Cron restarted")
                else:
                    print(f"  Unknown agent: {new_id}. "
                          f"Available: {', '.join(soul_agents.keys())}")
                continue

            # ── s07 心跳命令 ──

            if user_input == "/heartbeat":
                should, reason = heartbeat.should_run()
                elapsed = (time.time() - heartbeat.last_run
                           if heartbeat.last_run > 0 else 0)
                next_in = max(0, heartbeat.interval - elapsed)
                print(f"\n{BLUE}--- Heartbeat Status ---{RESET}")
                print(f"  Enabled:        {heartbeat._is_enabled()}")
                print(f"  Active hours:   {heartbeat.active_start}"
                      f"-{heartbeat.active_end}")
                print(f"  Interval:       {heartbeat.interval}s")
                print(f"  Last run:       {elapsed:.0f}s ago"
                      if heartbeat.last_run > 0 else
                      "  Last run:       never")
                print(f"  Next in:        ~{next_in:.0f}s")
                print(f"  Should run:     {should} ({reason})")
                print(f"  Total runs:     {heartbeat.total_runs}")
                print(f"  Total alerts:   {heartbeat.total_alerts}")
                print(f"{BLUE}--- end ---{RESET}\n")
                continue

            if user_input == "/trigger":
                print_info("Manually triggering heartbeat...")
                result = heartbeat.run_heartbeat_once()
                if result["status"] == HEARTBEAT_STATUS_SENT and result["text"]:
                    print_heartbeat(result["text"])
                elif result["status"] == HEARTBEAT_STATUS_OK_TOKEN:
                    print_info("Heartbeat: HEARTBEAT_OK (nothing to report).\n")
                elif result["status"] == HEARTBEAT_STATUS_OK_EMPTY:
                    print_info("Heartbeat: empty response.\n")
                elif result["status"] == HEARTBEAT_STATUS_SKIPPED:
                    print_info(f"Heartbeat skipped: "
                               f"{result.get('reason', '?')}\n")
                elif result["status"] == HEARTBEAT_STATUS_FAILED:
                    print(f"  {RED}Heartbeat failed: "
                          f"{result.get('reason', '?')}{RESET}\n")
                heartbeat.last_run = time.time()
                continue

            # ── s08 新增: cron 命令 ──

            if user_input == "/cron":
                jobs = cron_store.load()
                if not jobs:
                    print(f"\n{ORANGE}No cron jobs.{RESET}\n")
                    continue
                print(f"\n{ORANGE}--- Cron Jobs ---{RESET}")
                for job in jobs:
                    state = job.get("state", {})
                    schedule = job.get("schedule", {})
                    kind = schedule.get("kind", "?")
                    status_icon = (f"{GREEN}ON{RESET}"
                                   if job.get("enabled")
                                   else f"{RED}OFF{RESET}")
                    next_run = state.get("next_run_at")
                    next_str = (
                        datetime.fromtimestamp(next_run).strftime(
                            "%Y-%m-%d %H:%M:%S")
                        if isinstance(next_run, (int, float)) else "N/A"
                    )
                    last_status = state.get("last_status", "-")
                    errors = state.get("consecutive_errors", 0)
                    # Schedule 描述
                    if kind == "at":
                        sched_desc = f"at {schedule.get('at', '?')}"
                    elif kind == "every":
                        sched_desc = f"every {schedule.get('every_s', '?')}s"
                    elif kind == "cron":
                        sched_desc = f"cron '{schedule.get('expr', '?')}'"
                    else:
                        sched_desc = str(schedule)
                    target = job.get("session_target", "main")
                    dar = " [one-shot]" if job.get("delete_after_run") else ""
                    print(f"  [{status_icon}] {job.get('id', '?')[:12]} "
                          f"| {job.get('name', 'unnamed')}{dar} "
                          f"({target})")
                    print(f"       schedule: {sched_desc}")
                    print(f"       next_run: {next_str} | last: "
                          f"{last_status} | errors: {errors}")
                print(f"{ORANGE}--- end ({len(jobs)} jobs) ---{RESET}\n")
                continue

            if user_input == "/cron-status":
                status = cron_service.status()
                print(f"\n{ORANGE}--- Cron Status ---{RESET}")
                print(f"  Enabled:    {status['enabled']}")
                print(f"  Store:      {status['store_path']}")
                print(f"  Jobs:       {status['jobs']}")
                nw = status.get("next_wake_at")
                if nw:
                    nw_str = datetime.fromtimestamp(nw).strftime(
                        "%Y-%m-%d %H:%M:%S")
                    eta = max(0, nw - time.time())
                    print(f"  Next wake:  {nw_str} (~{eta:.0f}s)")
                else:
                    print("  Next wake:  none")
                print(f"{ORANGE}--- end ---{RESET}\n")
                continue

            if user_input.startswith("/cron-run "):
                job_id = user_input[10:].strip()
                print_info(f"Manually running cron job {job_id}...")
                result = cron_service.run_job(
                    job_id, agent=current_agent,
                    session_store=session_store)
                if result.get("ran"):
                    summary = result.get("summary", "")
                    if summary:
                        print_cron(f"Job {job_id}: {summary}")
                    else:
                        print_info(f"Job {job_id}: completed "
                                   f"(status={result.get('status')})\n")
                elif result.get("error"):
                    print(f"  {RED}{result['error']}{RESET}\n")
                else:
                    print_info(f"Job not run: "
                               f"{result.get('reason', '?')}\n")
                continue

            if user_input.startswith("/cron-delete "):
                job_id = user_input[13:].strip()
                result = cron_service.remove_job(job_id)
                if result.get("removed"):
                    print_info(f"Deleted cron job: {job_id}\n")
                else:
                    print(f"  {YELLOW}Job not found: {job_id}{RESET}\n")
                continue

            if user_input.startswith("/cron-log "):
                job_id = user_input[10:].strip()
                entries = cron_run_log.read_recent(job_id, limit=15)
                if not entries:
                    print(f"\n{ORANGE}No run history for "
                          f"job {job_id}.{RESET}\n")
                    continue
                print(f"\n{ORANGE}--- Run History: {job_id} ---{RESET}")
                for entry in entries:
                    ts = entry.get("ts", 0)
                    ts_str = (datetime.fromtimestamp(ts).strftime("%H:%M:%S")
                              if ts else "?")
                    status = entry.get("status", "?")
                    duration = entry.get("duration_ms", 0)
                    summary = (entry.get("summary") or "")[:80]
                    sc = GREEN if status == "ok" else RED
                    print(f"  {DIM}{ts_str}{RESET} {sc}{status}{RESET} "
                          f"({duration:.0f}ms) {DIM}{summary}{RESET}")
                print(f"{ORANGE}--- end ({len(entries)}) ---{RESET}\n")
                continue

            # ── 普通对话: 获取互斥锁, 调用 Agent ──
            heartbeat._lock.acquire()
            try:
                print(f"\n{BLUE}[Agent: {current_agent.id}]{RESET}")
                response = run_agent_with_soul_and_memory(
                    current_agent,
                    session_store,
                    session_key,
                    user_input,
                )
                if response:
                    print_assistant(response)
            except Exception as e:
                print(f"\n{YELLOW}Error: {e}{RESET}\n")
                log.exception("Error in agent loop: %s", e)
            finally:
                heartbeat._lock.release()

    finally:
        cron_service.stop()
        print_info("Cron service stopped.")
        heartbeat.stop()
        print_info("Heartbeat stopped.")


# ============================================================================
# Part 13: Main 程序入口 — s07 全部模式 + Cron
# ============================================================================

def main() -> None:
    """程序入口: 兼容 s07 所有运行模式, 且增加 Cron 调度.

    运行方式:
      python s08_cron.py              # 启动带 Cron+Heartbeat 的网关 (默认)
      python s08_cron.py --test-client # 运行测试客户端 (s06 功能)
      python s08_cron.py --chat       # 交互式对话 (s06 功能)
      python s08_cron.py --repl       # REPL + Heartbeat + Cron

    Cron 参数:
      --cron-store /path/to/jobs.json  # 指定 cron store 路径
      --no-cron                        # 禁用 cron 调度

    心跳参数 (继承自 s07):
      --interval 30          # 心跳间隔 (秒)
      --active-start 09:00   # 活跃时段开始
      --active-end 22:00     # 活跃时段结束
    """
    # 检查 API 密钥
    try:
        LLMClientConfig().require_api_key()
    except LLMValidationError as e:
        print(f"Error: {e}")
        print("Set DEEPSEEK_API_KEY in .env file or environment variable.")
        sys.exit(1)

    # 解析 --config 参数
    config_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--config" and i + 1 < len(sys.argv):
            config_path = sys.argv[i + 1]
            break

    # 解析心跳参数 (继承自 s07)
    heartbeat_interval = DEMO_HEARTBEAT_INTERVAL
    active_start = HEARTBEAT_ACTIVE_START
    active_end = HEARTBEAT_ACTIVE_END
    for i, arg in enumerate(sys.argv):
        if arg == "--interval" and i + 1 < len(sys.argv):
            heartbeat_interval = int(sys.argv[i + 1])
        elif arg == "--active-start" and i + 1 < len(sys.argv):
            active_start = sys.argv[i + 1]
        elif arg == "--active-end" and i + 1 < len(sys.argv):
            active_end = sys.argv[i + 1]

    # 解析 cron 参数 (s08 新增)
    cron_store_path: Path | None = None
    cron_enabled = "--no-cron" not in sys.argv
    for i, arg in enumerate(sys.argv):
        if arg == "--cron-store" and i + 1 < len(sys.argv):
            cron_store_path = Path(sys.argv[i + 1])
            break

    # 确保目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # 加载配置, 创建 Agent (复用 s06)
    soul_agents, bindings, default_agent, dm_scope = create_agents_with_soul_memory(config_path)
    if not soul_agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    # 创建示例文件 (s06 Soul + s07 Heartbeat)
    _ensure_sample_soul(soul_agents)
    _ensure_sample_heartbeat(soul_agents)

    # 构建路由器
    router = MessageRouter(soul_agents, bindings, default_agent, dm_scope)

    if "--test-client" in sys.argv:
        # 测试客户端 — 直接复用 s06
        asyncio.run(s06_test_client())

    elif "--chat" in sys.argv:
        # 交互式对话 — 直接复用 s06
        asyncio.run(s06_interactive_chat())

    elif "--repl" in sys.argv:
        # REPL + Heartbeat + Cron — s08 的核心模式
        session_store = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        run_repl_with_cron(
            router,
            soul_agents,
            session_store,
            heartbeat_interval=heartbeat_interval,
            active_start=active_start,
            active_end=active_end,
            cron_store_path=cron_store_path,
        )

    else:
        # 默认: 启动带 Cron+Heartbeat 的网关
        print("=" * 60)
        print("  OpenClaw Gateway — Cron Edition")
        print("  (s08: s07 Heartbeat Gateway + Cron Scheduler)")
        print("=" * 60)
        print(f"  Host:        {GATEWAY_HOST}")
        print(f"  Port:        {GATEWAY_PORT}")
        print(f"  Agents:      {', '.join(soul_agents.keys())}")
        print(f"  Bindings:    {len(bindings)} rules")
        print(f"  DM Scope:    {dm_scope}")
        print(f"  Heartbeat:   every {heartbeat_interval}s"
              f" (active {active_start}-{active_end})")
        print(f"  Cron:        {'enabled' if cron_enabled else 'disabled'}")
        print()
        print("  New RPC methods (s08 — cron):")
        print("    cron.list      - List all cron jobs")
        print("    cron.add       - Create a new cron job")
        print("    cron.update    - Update a cron job")
        print("    cron.remove    - Remove a cron job")
        print("    cron.run       - Manually trigger a cron job")
        print("    cron.runs      - Query per-job run history")
        print("    cron.status    - Cron scheduler status")
        print("    wake           - Inject system event immediately")
        print()
        print("  Inherited RPC methods (s07/s06):")
        print("    health, chat.send, chat.history, routing.resolve,")
        print("    routing.bindings, sessions.list, identify,")
        print("    memory.status, soul.get,")
        print("    heartbeat.status, heartbeat.trigger")
        print("=" * 60)

        sessions = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        gateway = CronGateway(
            host=GATEWAY_HOST,
            port=GATEWAY_PORT,
            router=router,
            sessions=sessions,
            soul_agents=soul_agents,
            token=GATEWAY_TOKEN,
            heartbeat_interval=heartbeat_interval,
            active_start=active_start,
            active_end=active_end,
            cron_store_path=cron_store_path,
            cron_enabled=cron_enabled,
        )
        asyncio.run(gateway.start())


if __name__ == "__main__":
    main()
