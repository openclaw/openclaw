"""
Section 08: Cron Scheduler
"When the agent knows time itself"

OpenClaw 的 Cron 系统让 agent 拥有时间维度的自主能力.
与 Section 08 的心跳不同, 心跳是 "定期检查有没有事", 而 Cron 是
"在精确的时间点执行精确的任务". 心跳是模糊的周期性轮询,
Cron 是确定性的时间调度.

在 OpenClaw 中:
  - CronSchedule: 三种调度类型的联合体
    * at: 一次性绝对时间 ("明天下午5点提醒我")
    * every: 基于锚点的等间隔 ("每小时检查一次")
    * cron: 标准 cron 表达式 ("每周一9点")
  - CronJob: 调度任务, 包含 schedule + payload + state
  - CronStore: JSON 文件持久化, 原子写入
  - CronRunLog: JSONL 追加日志, 带自动修剪
  - CronService: 后台线程, 1 秒轮询, 到期即执行
  - compute_next_run_at: 核心调度算法
    * "at" 型: 解析 ISO 时间, 过期返回 None
    * "every" 型: 锚点公式 anchor + ceil((now-anchor)/interval)*interval
      (不用 last_run 是为了防止累积漂移)
    * "cron" 型: 用 croniter 计算下一次触发, 带同秒防循环
  - 自动禁用: 连续 5 次执行错误后自动 disable
  - delete_after_run: 一次性任务执行后自动禁用

架构图:

  +--- CronService (background thread) -------+
  |  every 1s:                                  |
  |  for each enabled job:                      |
  |    compute_next_run_at(schedule, now)        |
  |    if next_run_at <= now:                    |
  |      execute_job(job)                        |
  |        -> call agent_fn(payload.message)     |
  |        -> update state (last_run, status)    |
  |        -> if delete_after_run: disable       |
  |        -> if errors >= 5: auto-disable       |
  |        -> append to run log                  |
  +---------------------------------------------+
           |
           v
    +--- CronStore ---+     +--- CronRunLog ---+
    | jobs.json       |     | run-log.jsonl     |
    | (atomic write)  |     | (append + prune)  |
    +------------------+     +------------------+

  +--- HeartbeatRunner (simplified) -----------+
  |  every N seconds:                           |
  |  should_run() -> agent_fn(HEARTBEAT.md)     |
  |  -> HEARTBEAT_OK = suppress                 |
  |  -> content = output to user                |
  +---------------------------------------------+

Schedule 类型详解:

  1. "at" -- 一次性绝对时间
     小明说 "明天下午5点提醒我提交报告"
     -> schedule: { kind: "at", at_time: "2025-01-16T17:00:00" }
     -> delete_after_run = True
     -> 执行一次后自动禁用

  2. "every" -- 基于锚点的等间隔
     小明说 "每小时检查一次服务器状态"
     -> schedule: { kind: "every", every_seconds: 3600, anchor: None }
     -> anchor 默认为创建时间
     -> 公式: anchor + ceil((now - anchor) / interval) * interval
     -> 为什么不用 last_run? 因为 last_run 会因执行耗时产生累积漂移

  3. "cron" -- 标准 cron 表达式
     小明说 "每周一9点检查依赖安全漏洞"
     -> schedule: { kind: "cron", expr: "0 9 * * 1", tz: None }
     -> 用 croniter 库解析
     -> 防止同秒循环: 如果结果 <= now, 从 now+1s 重试

运行方式:
    cd openclaw0
    python agents/s08_cron.py

需要在 .env 中配置:
    ANTHROPIC_API_KEY=sk-ant-xxxxx
    MODEL_ID=claude-sonnet-4-20250514
"""

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from anthropic import Anthropic

# croniter 用于解析标准 cron 表达式
# pip install croniter
try:
    from croniter import croniter
except ImportError:
    croniter = None  # type: ignore[assignment,misc]

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

MODEL_ID = os.getenv("MODEL_ID", "claude-sonnet-4-20250514")
client = Anthropic(
    api_key=os.getenv("ANTHROPIC_API_KEY"),
    base_url=os.getenv("ANTHROPIC_BASE_URL") or None,
)

WORKSPACE_DIR = Path(__file__).resolve().parent.parent / "workspace"

# 心跳间隔: 演示用 120 秒 (cron 演示中心跳不是主角)
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "120"))
HEARTBEAT_ACTIVE_START = int(os.getenv("HEARTBEAT_ACTIVE_START", "9"))
HEARTBEAT_ACTIVE_END = int(os.getenv("HEARTBEAT_ACTIVE_END", "22"))
HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK"
DEDUP_WINDOW_SECONDS = 24 * 60 * 60

BASE_SYSTEM_PROMPT = (
    "You are a helpful AI assistant running on the openclaw0 framework.\n"
    "Current date and time: {datetime}\n"
    "You have access to memory tools and cron scheduling tools.\n"
    "You can create, list, and delete scheduled tasks (cron jobs).\n"
    "Schedule types: 'at' (one-shot), 'every' (interval), 'cron' (cron expression)."
)

# ---------------------------------------------------------------------------
# ANSI 颜色
# ---------------------------------------------------------------------------
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
DIM = "\033[2m"
RESET = "\033[0m"
BOLD = "\033[1m"
MAGENTA = "\033[35m"
RED = "\033[31m"
BLUE = "\033[34m"
ORANGE = "\033[38;5;208m"


def colored_prompt() -> str:
    return f"{CYAN}{BOLD}You > {RESET}"


def print_assistant(text: str) -> None:
    print(f"\n{GREEN}{BOLD}Assistant:{RESET} {text}\n")


def print_info(text: str) -> None:
    print(f"{DIM}{text}{RESET}")


def print_tool(name: str, detail: str) -> None:
    print(f"  {MAGENTA}[tool:{name}]{RESET} {DIM}{detail}{RESET}")


def print_heartbeat(text: str) -> None:
    """心跳消息用蓝色标记."""
    print(f"\n{BLUE}{BOLD}[Heartbeat]{RESET} {text}\n")


def print_cron(text: str) -> None:
    """Cron 输出用橙色标记, 与心跳区分."""
    print(f"\n{ORANGE}{BOLD}[Cron]{RESET} {text}\n")


# ---------------------------------------------------------------------------
# CronSchedule 计算 -- compute_next_run_at
# ---------------------------------------------------------------------------
# 对应 OpenClaw 的 src/cron/schedule.ts::computeNextRunAtMs()
#
# 三种 schedule 类型各自的下一次触发时间计算:
#   - at: 一次性, 过了就是 None
#   - every: 锚点公式, 防漂移
#   - cron: croniter 解析, 防同秒循环
# ---------------------------------------------------------------------------

def compute_next_run_at(schedule: dict, now_ts: float) -> float | None:
    """计算调度的下一次触发时间 (Unix timestamp, 秒).

    对应 OpenClaw 的 computeNextRunAtMs(), 但使用秒而非毫秒.
    返回 None 表示已过期或无法计算.
    """
    kind = schedule.get("kind")

    if kind == "at":
        # 解析 ISO 时间字符串
        at_time_str = schedule.get("at_time", "")
        if not at_time_str:
            return None
        try:
            dt = datetime.fromisoformat(at_time_str)
            # 如果没有时区信息, 假设为本地时间
            if dt.tzinfo is None:
                dt = dt.astimezone()
            at_ts = dt.timestamp()
        except (ValueError, OSError):
            return None
        # 还没过期就返回, 否则 None
        return at_ts if at_ts > now_ts else None

    if kind == "every":
        every_seconds = max(1, int(schedule.get("every_seconds", 60)))
        anchor_str = schedule.get("anchor")
        if anchor_str:
            try:
                anchor_dt = datetime.fromisoformat(anchor_str)
                if anchor_dt.tzinfo is None:
                    anchor_dt = anchor_dt.astimezone()
                anchor_ts = anchor_dt.timestamp()
            except (ValueError, OSError):
                anchor_ts = now_ts
        else:
            anchor_ts = now_ts

        # 如果 now 还没到锚点, 直接返回锚点
        if now_ts < anchor_ts:
            return anchor_ts

        # 锚点公式: anchor + ceil((now - anchor) / interval) * interval
        elapsed = now_ts - anchor_ts
        steps = max(1, math.ceil(elapsed / every_seconds))
        return anchor_ts + steps * every_seconds

    if kind == "cron":
        expr = schedule.get("expr", "").strip()
        if not expr:
            return None

        if croniter is None:
            # croniter 未安装时, 无法计算 cron 表达式
            return None

        try:
            tz_str = schedule.get("tz")
            if tz_str:
                import zoneinfo
                tz_obj = zoneinfo.ZoneInfo(tz_str)
                base_dt = datetime.fromtimestamp(now_ts, tz=tz_obj)
            else:
                base_dt = datetime.fromtimestamp(now_ts).astimezone()

            cron = croniter(expr, base_dt)
            next_dt = cron.get_next(datetime)
            next_ts = next_dt.timestamp()

            if next_ts > now_ts:
                return next_ts

            # 防止同秒循环: 如果 croniter 返回了 <= now 的时间,
            # 从 now + 1 秒重试
            retry_ts = math.floor(now_ts) + 1.0
            if tz_str:
                retry_dt = datetime.fromtimestamp(retry_ts, tz=tz_obj)
            else:
                retry_dt = datetime.fromtimestamp(retry_ts).astimezone()
            cron2 = croniter(expr, retry_dt)
            retry_next = cron2.get_next(datetime)
            retry_next_ts = retry_next.timestamp()
            return retry_next_ts if retry_next_ts > now_ts else None
        except Exception:
            return None

    return None


# ---------------------------------------------------------------------------
# CronJob / CronJobState 数据结构
# ---------------------------------------------------------------------------

def make_cron_job_state() -> dict:
    """创建空的 CronJobState."""
    return {
        "next_run_at": None,
        "last_run_at": None,
        "last_status": None,
        "last_error": None,
        "last_duration_ms": None,
        "consecutive_errors": 0,
        "schedule_error_count": 0,
    }


def make_cron_job(
    name: str,
    schedule: dict,
    payload: dict,
    enabled: bool = True,
    delete_after_run: bool = False,
    job_id: str | None = None,
) -> dict:
    """创建一个 CronJob.

    对应 OpenClaw 的 CronJob 类型 (src/cron/types.ts).
    简化版: 省略 agentId, sessionTarget, wakeMode, delivery 等字段.
    """
    now_ts = time.time()
    return {
        "id": job_id or str(uuid.uuid4())[:8],
        "name": name,
        "enabled": enabled,
        "delete_after_run": delete_after_run,
        "created_at": now_ts,
        "schedule": schedule,
        "payload": payload,
        "state": make_cron_job_state(),
    }


# ---------------------------------------------------------------------------
# CronStore -- JSON 文件持久化
# ---------------------------------------------------------------------------
# 对应 OpenClaw 的 src/cron/store.ts
# 使用 tmp + rename 的原子写入模式, 防止写入中途断电导致数据损坏.
# ---------------------------------------------------------------------------

class CronStore:
    """Cron 任务持久化存储.

    存储路径: workspace/cron/jobs.json
    格式: { "version": 1, "jobs": [...] }
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
                return data["jobs"]
            return []
        except (json.JSONDecodeError, OSError):
            return []

    def save(self, jobs: list[dict]) -> None:
        """原子写入: 先写临时文件, 再 rename.

        OpenClaw 的 saveCronStore() 也使用同样的模式:
          1. 写入 .tmp 文件
          2. rename 覆盖目标文件
          3. 可选 .bak 备份
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
        except OSError:
            # 如果 rename 失败, 直接写入
            self.store_path.write_text(content, encoding="utf-8")
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def add_job(self, job: dict) -> None:
        """添加一个 job 并持久化."""
        with self._lock:
            jobs = self._load_unlocked()
            jobs.append(job)
            self._save_unlocked(jobs)

    def remove_job(self, job_id: str) -> bool:
        """删除一个 job, 返回是否成功找到并删除."""
        with self._lock:
            jobs = self._load_unlocked()
            filtered = [j for j in jobs if j.get("id") != job_id]
            if len(filtered) == len(jobs):
                return False
            self._save_unlocked(filtered)
            return True

    def update_state(self, job_id: str, state_patch: dict) -> None:
        """更新指定 job 的 state 字段."""
        with self._lock:
            jobs = self._load_unlocked()
            for job in jobs:
                if job.get("id") == job_id:
                    if "state" not in job:
                        job["state"] = make_cron_job_state()
                    job["state"].update(state_patch)
                    break
            self._save_unlocked(jobs)

    def update_job(self, job_id: str, patch: dict) -> None:
        """更新指定 job 的顶层字段."""
        with self._lock:
            jobs = self._load_unlocked()
            for job in jobs:
                if job.get("id") == job_id:
                    job.update(patch)
                    break
            self._save_unlocked(jobs)


# ---------------------------------------------------------------------------
# CronRunLog -- JSONL 追加日志
# ---------------------------------------------------------------------------
# 对应 OpenClaw 的 src/cron/run-log.ts
# JSONL 格式: 每行一条 JSON 记录
# 带自动修剪: 超过 MAX_SIZE_BYTES 时保留最近 MAX_LINES/2 行
# ---------------------------------------------------------------------------

class CronRunLog:
    """Cron 执行日志.

    日志路径: workspace/cron/run-log.jsonl
    每次执行结束后追加一条记录.
    """

    MAX_SIZE_BYTES = 2 * 1024 * 1024  # 2MB
    MAX_LINES = 2000

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, entry: dict) -> None:
        """追加一条日志, 然后检查是否需要修剪."""
        with self._lock:
            line = json.dumps(entry, ensure_ascii=False, default=str) + "\n"
            try:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                return
            self._prune_if_needed()

    def _prune_if_needed(self) -> None:
        """如果文件超过 MAX_SIZE_BYTES, 只保留最近 MAX_LINES/2 行.

        OpenClaw 的 pruneIfNeeded() 使用同样的策略:
        先检查文件大小, 超限后读取所有行, 保留后半部分, 原子写回.
        """
        try:
            stat = self.log_path.stat()
        except OSError:
            return
        if stat.st_size <= self.MAX_SIZE_BYTES:
            return
        try:
            raw = self.log_path.read_text(encoding="utf-8")
            lines = [l.strip() for l in raw.split("\n") if l.strip()]
            keep_count = self.MAX_LINES // 2
            kept = lines[-keep_count:] if len(lines) > keep_count else lines
            self.log_path.write_text("\n".join(kept) + "\n", encoding="utf-8")
        except OSError:
            pass

    def read_recent(self, limit: int = 20) -> list[dict]:
        """读取最近的 N 条日志."""
        with self._lock:
            if not self.log_path.exists():
                return []
            try:
                raw = self.log_path.read_text(encoding="utf-8")
                lines = [l.strip() for l in raw.split("\n") if l.strip()]
                recent_lines = lines[-limit:]
                results = []
                for line in recent_lines:
                    try:
                        results.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                return results
            except OSError:
                return []


# ---------------------------------------------------------------------------
# CronService -- 后台调度引擎
# ---------------------------------------------------------------------------
# 对应 OpenClaw 的 src/cron/service.ts + src/cron/service/jobs.ts
#
# 核心逻辑:
#   1. 每秒轮询一次所有 enabled job
#   2. 计算 next_run_at, 到期则执行
#   3. 执行后更新 state
#   4. 连续错误超过阈值则自动禁用
#   5. delete_after_run 的 job 执行后立即禁用
# ---------------------------------------------------------------------------

class CronService:
    """Cron 调度服务.

    后台线程每秒检查所有任务, 到期执行.
    agent_fn_factory: 返回一个 callable(message) -> str 的工厂函数,
    用于在 cron job 触发时执行 agent 调用.
    """

    AUTO_DISABLE_THRESHOLD = 5

    def __init__(
        self,
        store: CronStore,
        run_log: CronRunLog,
        agent_fn_factory: "callable",  # type: ignore[name-defined]
    ):
        self.store = store
        self.run_log = run_log
        self.agent_fn_factory = agent_fn_factory

        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # 执行结果输出队列, 由主线程读取
        self._output_queue: list[str] = []
        self._output_lock = threading.Lock()

    def _compute_all_next_runs(self) -> None:
        """为所有 enabled job 计算 next_run_at 并持久化.

        对应 OpenClaw 的 recomputeNextRuns().
        只在 nextRunAtMs 缺失或已过期时重算, 避免提前推进未触发的 job.
        """
        jobs = self.store.load()
        now = time.time()
        changed = False
        for job in jobs:
            if not job.get("enabled", False):
                if job.get("state", {}).get("next_run_at") is not None:
                    job.setdefault("state", make_cron_job_state())
                    job["state"]["next_run_at"] = None
                    changed = True
                continue
            state = job.setdefault("state", make_cron_job_state())
            current_next = state.get("next_run_at")
            # 只在缺失或已过期时重算
            if current_next is None or now >= current_next:
                try:
                    new_next = compute_next_run_at(job.get("schedule", {}), now)
                    if state.get("next_run_at") != new_next:
                        state["next_run_at"] = new_next
                        changed = True
                    # 计算成功, 清零调度错误计数
                    if state.get("schedule_error_count", 0) > 0:
                        state["schedule_error_count"] = 0
                        changed = True
                except Exception:
                    error_count = state.get("schedule_error_count", 0) + 1
                    state["schedule_error_count"] = error_count
                    state["next_run_at"] = None
                    # 调度计算连续出错 3 次则自动禁用
                    if error_count >= 3:
                        job["enabled"] = False
                    changed = True
        if changed:
            self.store.save(jobs)

    def _find_due_jobs(self, now: float) -> list[dict]:
        """找到所有到期的 job.

        对应 OpenClaw 的 isJobDue(): enabled && nextRunAtMs <= now && not running.
        """
        jobs = self.store.load()
        due = []
        for job in jobs:
            if not job.get("enabled", False):
                continue
            state = job.get("state", {})
            next_run = state.get("next_run_at")
            if next_run is not None and now >= next_run:
                due.append(job)
        return due

    def _execute_job(self, job: dict) -> dict:
        """执行一个 cron job.

        流程:
          1. 记录开始时间
          2. 调用 agent_fn 执行 payload
          3. 更新 state (last_run_at, last_status, consecutive_errors)
          4. 如果 delete_after_run: 禁用 job
          5. 如果 consecutive_errors >= threshold: 自动禁用
          6. 追加日志
          7. 返回结果

        对应 OpenClaw 的 service/ops.ts::run()
        """
        job_id = job.get("id", "?")
        job_name = job.get("name", "unnamed")
        payload = job.get("payload", {})
        message = payload.get("message", payload.get("text", ""))

        start_ts = time.time()
        result = {
            "job_id": job_id,
            "job_name": job_name,
            "status": "ok",
            "error": None,
            "response": "",
            "duration_ms": 0,
        }

        try:
            agent_fn = self.agent_fn_factory()
            response_text = agent_fn(message)
            result["response"] = response_text or ""
            result["status"] = "ok"
        except Exception as exc:
            result["status"] = "error"
            result["error"] = str(exc)

        duration_ms = (time.time() - start_ts) * 1000
        result["duration_ms"] = round(duration_ms, 1)

        # 更新 job state
        state_patch = {
            "last_run_at": time.time(),
            "last_status": result["status"],
            "last_error": result["error"],
            "last_duration_ms": result["duration_ms"],
        }

        if result["status"] == "ok":
            state_patch["consecutive_errors"] = 0
        else:
            jobs = self.store.load()
            for j in jobs:
                if j.get("id") == job_id:
                    prev_errors = j.get("state", {}).get("consecutive_errors", 0)
                    state_patch["consecutive_errors"] = prev_errors + 1
                    break

        self.store.update_state(job_id, state_patch)

        # delete_after_run: 执行完毕后禁用
        if job.get("delete_after_run", False) and result["status"] == "ok":
            self.store.update_job(job_id, {"enabled": False})

        # 自动禁用: 连续错误过多
        if state_patch.get("consecutive_errors", 0) >= self.AUTO_DISABLE_THRESHOLD:
            self.store.update_job(job_id, {"enabled": False})
            with self._output_lock:
                self._output_queue.append(
                    f"[cron] Job '{job_name}' (id={job_id}) auto-disabled "
                    f"after {self.AUTO_DISABLE_THRESHOLD} consecutive errors."
                )

        # 追加日志
        log_entry = {
            "ts": time.time(),
            "job_id": job_id,
            "job_name": job_name,
            "action": "finished",
            "status": result["status"],
            "error": result["error"],
            "duration_ms": result["duration_ms"],
            "summary": (result["response"] or "")[:200],
        }
        self.run_log.append(log_entry)

        return result

    def _background_loop(self) -> None:
        """后台调度循环.

        每秒:
          1. 重算所有 job 的 next_run_at
          2. 找到到期 job
          3. 逐个执行
          4. 将有意义的输出放入队列
        """
        while not self._stop_event.is_set():
            try:
                self._compute_all_next_runs()
                now = time.time()
                due_jobs = self._find_due_jobs(now)

                for job in due_jobs:
                    if self._stop_event.is_set():
                        break
                    job_id = job.get("id", "?")
                    job_name = job.get("name", "unnamed")

                    result = self._execute_job(job)

                    # 如果执行成功且有响应, 放入输出队列
                    if result["status"] == "ok" and result["response"]:
                        with self._output_lock:
                            self._output_queue.append(
                                f"Job '{job_name}': {result['response']}"
                            )
                    elif result["status"] == "error":
                        with self._output_lock:
                            self._output_queue.append(
                                f"Job '{job_name}' failed: {result['error']}"
                            )

                    # 执行后立刻重算该 job 的 next_run_at
                    self._compute_all_next_runs()

            except Exception as exc:
                with self._output_lock:
                    self._output_queue.append(f"[cron service error: {exc}]")

            self._stop_event.wait(1.0)

    def start(self) -> None:
        """启动后台调度线程."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        # 启动前先计算所有 next_run_at
        self._compute_all_next_runs()
        self._thread = threading.Thread(
            target=self._background_loop,
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

    def drain_output(self) -> list[str]:
        """取出所有待输出的 cron 消息. 由主线程调用."""
        with self._output_lock:
            messages = self._output_queue[:]
            self._output_queue.clear()
            return messages

    def trigger_job(self, job_id: str) -> dict | None:
        """手动触发一个 job (不管是否到期)."""
        jobs = self.store.load()
        for job in jobs:
            if job.get("id") == job_id:
                return self._execute_job(job)
        return None


# ---------------------------------------------------------------------------
# Soul System (复用 s08 的实现)
# ---------------------------------------------------------------------------

class SoulSystem:
    def __init__(self, soul_dir: Path):
        self.soul_path = soul_dir / "SOUL.md"

    def load_soul(self) -> str:
        if self.soul_path.exists():
            return self.soul_path.read_text(encoding="utf-8").strip()
        return ""

    def build_system_prompt(self, base_prompt: str) -> str:
        soul = self.load_soul()
        if soul:
            return f"{soul}\n\n---\n\n{base_prompt}"
        return base_prompt


# ---------------------------------------------------------------------------
# Memory System (复用 s08 的核心实现)
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9\u4e00-\u9fff]+", text.lower())
    return [t for t in tokens if len(t) > 1]


def _cosine_similarity(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    common_keys = set(vec_a.keys()) & set(vec_b.keys())
    if not common_keys:
        return 0.0
    dot = sum(vec_a[k] * vec_b[k] for k in common_keys)
    norm_a = math.sqrt(sum(v * v for v in vec_a.values()))
    norm_b = math.sqrt(sum(v * v for v in vec_b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class MemoryStore:
    def __init__(self, memory_dir: Path):
        self.memory_dir = memory_dir
        self.evergreen_path = memory_dir / "MEMORY.md"
        self.daily_dir = memory_dir / "memory"
        self.daily_dir.mkdir(parents=True, exist_ok=True)

    def write_memory(self, content: str, category: str = "general") -> str:
        today = date.today().isoformat()
        path = self.daily_dir / f"{today}.md"
        timestamp = datetime.now().strftime("%H:%M:%S")
        entry = f"\n## [{timestamp}] {category}\n\n{content}\n"
        if not path.exists():
            path.write_text(f"# Memory Log: {today}\n", encoding="utf-8")
        with open(path, "a", encoding="utf-8") as f:
            f.write(entry)
        return f"memory/{today}.md"

    def load_evergreen(self) -> str:
        if self.evergreen_path.exists():
            return self.evergreen_path.read_text(encoding="utf-8").strip()
        return ""

    def get_recent_memories(self, days: int = 7) -> list[dict]:
        results = []
        today = date.today()
        for i in range(days):
            d = today - timedelta(days=i)
            path = self.daily_dir / f"{d.isoformat()}.md"
            if path.exists():
                content = path.read_text(encoding="utf-8").strip()
                results.append({
                    "path": f"memory/{d.isoformat()}.md",
                    "date": d.isoformat(),
                    "content": content,
                })
        return results

    def _load_all_chunks(self) -> list[dict]:
        chunks = []
        if self.evergreen_path.exists():
            content = self.evergreen_path.read_text(encoding="utf-8")
            chunks.extend(self._split_by_heading(content, "MEMORY.md"))
        if self.daily_dir.exists():
            for md_file in sorted(self.daily_dir.glob("*.md"), reverse=True):
                content = md_file.read_text(encoding="utf-8")
                chunks.extend(self._split_by_heading(content, f"memory/{md_file.name}"))
        return chunks

    @staticmethod
    def _split_by_heading(content: str, path: str) -> list[dict]:
        lines = content.split("\n")
        chunks = []
        current_lines: list[str] = []
        current_start = 1
        for i, line in enumerate(lines):
            if line.startswith("#") and current_lines:
                text = "\n".join(current_lines).strip()
                if text:
                    chunks.append({
                        "path": path,
                        "text": text,
                        "line_start": current_start,
                        "line_end": current_start + len(current_lines) - 1,
                    })
                current_lines = [line]
                current_start = i + 1
            else:
                current_lines.append(line)
        if current_lines:
            text = "\n".join(current_lines).strip()
            if text:
                chunks.append({
                    "path": path,
                    "text": text,
                    "line_start": current_start,
                    "line_end": current_start + len(current_lines) - 1,
                })
        return chunks

    def search_memory(self, query: str, top_k: int = 5) -> list[dict]:
        chunks = self._load_all_chunks()
        if not chunks:
            return []
        doc_freq: Counter = Counter()
        chunk_tokens_list = []
        for chunk in chunks:
            tokens = _tokenize(chunk["text"])
            for t in set(tokens):
                doc_freq[t] += 1
            chunk_tokens_list.append(tokens)
        n_docs = len(chunks)

        def _idf(term: str) -> float:
            df = doc_freq.get(term, 0)
            return math.log(n_docs / df) if df > 0 else 0.0

        query_tokens = _tokenize(query)
        query_tf = Counter(query_tokens)
        query_vec = {t: (c / max(len(query_tokens), 1)) * _idf(t)
                     for t, c in query_tf.items()}
        scored = []
        for i, chunk in enumerate(chunks):
            tokens = chunk_tokens_list[i]
            if not tokens:
                continue
            tf = Counter(tokens)
            chunk_vec = {t: (c / len(tokens)) * _idf(t) for t, c in tf.items()}
            score = _cosine_similarity(query_vec, chunk_vec)
            if score > 0.01:
                scored.append({
                    "path": chunk["path"],
                    "line_start": chunk["line_start"],
                    "line_end": chunk["line_end"],
                    "score": round(score, 4),
                    "snippet": chunk["text"][:300],
                })
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]


# ---------------------------------------------------------------------------
# Heartbeat Runner (简化版, 复用 s08 核心逻辑)
# ---------------------------------------------------------------------------

class HeartbeatRunner:
    """简化版心跳运行器, 仅保留核心功能用于 cron 演示."""

    def __init__(
        self,
        interval_seconds: int = 1800,
        active_hours: tuple[int, int] = (9, 22),
        heartbeat_path: Path | None = None,
    ):
        self.interval = interval_seconds
        self.active_start, self.active_end = active_hours
        self.heartbeat_path = heartbeat_path or (WORKSPACE_DIR / "HEARTBEAT.md")
        self.last_run: float = 0.0
        self.dedup_cache: dict[str, float] = {}
        self.running = False
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._output_queue: list[str] = []
        self._output_lock = threading.Lock()

    def should_run(self) -> tuple[bool, str]:
        if not self.heartbeat_path.exists():
            return False, "disabled (no HEARTBEAT.md)"
        if (time.time() - self.last_run) < self.interval:
            return False, "interval not elapsed"
        current_hour = datetime.now().hour
        if self.active_start <= self.active_end:
            if not (self.active_start <= current_hour < self.active_end):
                return False, "outside active hours"
        else:
            if not (current_hour >= self.active_start or current_hour < self.active_end):
                return False, "outside active hours"
        acquired = self._lock.acquire(blocking=False)
        if acquired:
            self._lock.release()
        else:
            return False, "main lane busy"
        if self.running:
            return False, "heartbeat already running"
        return True, "ok"

    def _content_hash(self, content: str) -> str:
        normalized = content.strip().lower()
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    def is_duplicate(self, content: str) -> bool:
        h = self._content_hash(content)
        now = time.time()
        expired = [k for k, v in self.dedup_cache.items()
                   if now - v > DEDUP_WINDOW_SECONDS]
        for k in expired:
            del self.dedup_cache[k]
        if h in self.dedup_cache:
            return True
        self.dedup_cache[h] = now
        return False

    def run_heartbeat_turn(self, agent_fn) -> str | None:
        heartbeat_content = self.heartbeat_path.read_text(encoding="utf-8").strip()
        heartbeat_prompt = (
            "This is a scheduled heartbeat check. "
            "Follow the HEARTBEAT.md instructions below strictly.\n"
            "Do NOT infer or repeat old tasks from prior context.\n"
            "If nothing needs attention, respond with exactly: HEARTBEAT_OK\n\n"
            f"--- HEARTBEAT.md ---\n{heartbeat_content}\n--- end ---"
        )
        response_text = agent_fn(heartbeat_prompt)
        if not response_text:
            return None
        stripped = response_text.strip()
        without_token = stripped.replace(HEARTBEAT_OK_TOKEN, "").strip()
        if not without_token or len(without_token) <= 5:
            return None
        if HEARTBEAT_OK_TOKEN in stripped:
            cleaned = without_token
        else:
            cleaned = stripped
        if self.is_duplicate(cleaned):
            return None
        return cleaned

    def _background_loop(self, agent_fn) -> None:
        while not self._stop_event.is_set():
            should, _ = self.should_run()
            if should:
                acquired = self._lock.acquire(blocking=False)
                if not acquired:
                    self._stop_event.wait(1.0)
                    continue
                try:
                    self.running = True
                    self.last_run = time.time()
                    result = self.run_heartbeat_turn(agent_fn)
                    if result:
                        with self._output_lock:
                            self._output_queue.append(result)
                except Exception as exc:
                    with self._output_lock:
                        self._output_queue.append(f"[heartbeat error: {exc}]")
                finally:
                    self.running = False
                    self._lock.release()
            self._stop_event.wait(1.0)

    def start(self, agent_fn) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._background_loop,
            args=(agent_fn,),
            daemon=True,
            name="heartbeat-runner",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None

    def drain_output(self) -> list[str]:
        with self._output_lock:
            messages = self._output_queue[:]
            self._output_queue.clear()
            return messages


# ---------------------------------------------------------------------------
# 工具定义
# ---------------------------------------------------------------------------

memory_store = MemoryStore(WORKSPACE_DIR)

TOOLS = [
    {
        "name": "memory_write",
        "description": (
            "Write a memory to persistent storage. Use this to remember important "
            "information: preferences, facts, decisions, names, dates."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The information to remember.",
                },
                "category": {
                    "type": "string",
                    "description": "Category: preference, fact, decision, todo, person.",
                },
            },
            "required": ["content"],
        },
    },
    {
        "name": "memory_search",
        "description": (
            "Search through stored memories. Use before answering questions "
            "about prior conversations or previously discussed topics."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Max results. Default 5.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "cron_create",
        "description": (
            "Create a new scheduled cron job. "
            "schedule_type: 'at' for one-shot absolute time, "
            "'every' for interval-based, 'cron' for cron expressions.\n"
            "schedule_value: ISO datetime for 'at', seconds (integer) for 'every', "
            "cron expression for 'cron' (e.g. '0 9 * * 1' for every Monday 9am).\n"
            "message: the instruction to execute when the job fires.\n"
            "delete_after_run: true for one-shot jobs that should not repeat."
        ),
        "input_schema": {
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
                    "description": "The instruction the agent will execute when the job fires.",
                },
                "delete_after_run": {
                    "type": "boolean",
                    "description": "If true, the job is disabled after its first successful run.",
                },
            },
            "required": ["name", "schedule_type", "schedule_value", "message"],
        },
    },
    {
        "name": "cron_list",
        "description": "List all cron jobs with their status, schedule, and next run time.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "cron_delete",
        "description": "Delete a cron job by its ID.",
        "input_schema": {
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
]


# ---------------------------------------------------------------------------
# 工具处理函数 (需要在 main 中绑定 cron_store)
# ---------------------------------------------------------------------------

# cron_store 会在 main() 中初始化后绑定
_cron_store: CronStore | None = None


def _handle_cron_create(params: dict) -> str:
    """处理 cron_create 工具调用.

    根据 schedule_type 构建对应的 schedule dict,
    创建 CronJob 并写入 store.
    """
    if _cron_store is None:
        return json.dumps({"error": "cron store not initialized"})

    name = params.get("name", "unnamed job")
    schedule_type = params.get("schedule_type", "")
    schedule_value = params.get("schedule_value", "")
    message = params.get("message", "")
    delete_after_run = params.get("delete_after_run", False)

    # 构建 schedule
    if schedule_type == "at":
        schedule = {"kind": "at", "at_time": schedule_value}
        # at 类型默认 delete_after_run = True
        if not params.get("delete_after_run"):
            delete_after_run = True
    elif schedule_type == "every":
        try:
            every_seconds = int(schedule_value)
        except (ValueError, TypeError):
            return json.dumps({"error": f"Invalid interval: {schedule_value}"})
        schedule = {
            "kind": "every",
            "every_seconds": every_seconds,
            "anchor": datetime.now().astimezone().isoformat(),
        }
    elif schedule_type == "cron":
        if croniter is not None:
            try:
                croniter(schedule_value)
            except (ValueError, KeyError) as exc:
                return json.dumps({"error": f"Invalid cron expression: {exc}"})
        schedule = {"kind": "cron", "expr": schedule_value}
    else:
        return json.dumps({"error": f"Unknown schedule_type: {schedule_type}"})

    payload = {"kind": "agent_turn", "message": message}
    job = make_cron_job(
        name=name,
        schedule=schedule,
        payload=payload,
        delete_after_run=delete_after_run,
    )

    # 计算初始 next_run_at
    next_run = compute_next_run_at(schedule, time.time())
    job["state"]["next_run_at"] = next_run

    _cron_store.add_job(job)

    next_run_str = ""
    if next_run:
        next_run_str = datetime.fromtimestamp(next_run).strftime("%Y-%m-%d %H:%M:%S")

    return json.dumps({
        "status": "created",
        "job_id": job["id"],
        "name": name,
        "schedule_type": schedule_type,
        "next_run": next_run_str,
        "delete_after_run": delete_after_run,
    })


def _handle_cron_list(_params: dict) -> str:
    """处理 cron_list 工具调用."""
    if _cron_store is None:
        return json.dumps({"error": "cron store not initialized"})

    jobs = _cron_store.load()
    result = []
    for job in jobs:
        state = job.get("state", {})
        schedule = job.get("schedule", {})
        next_run = state.get("next_run_at")
        next_run_str = ""
        if next_run:
            next_run_str = datetime.fromtimestamp(next_run).strftime("%Y-%m-%d %H:%M:%S")
        last_run = state.get("last_run_at")
        last_run_str = ""
        if last_run:
            last_run_str = datetime.fromtimestamp(last_run).strftime("%Y-%m-%d %H:%M:%S")
        result.append({
            "id": job.get("id"),
            "name": job.get("name"),
            "enabled": job.get("enabled", False),
            "schedule": schedule,
            "next_run": next_run_str,
            "last_run": last_run_str,
            "last_status": state.get("last_status"),
            "consecutive_errors": state.get("consecutive_errors", 0),
            "delete_after_run": job.get("delete_after_run", False),
        })
    return json.dumps({"jobs": result, "total": len(result)})


def _handle_cron_delete(params: dict) -> str:
    """处理 cron_delete 工具调用."""
    if _cron_store is None:
        return json.dumps({"error": "cron store not initialized"})

    job_id = params.get("job_id", "")
    removed = _cron_store.remove_job(job_id)
    if removed:
        return json.dumps({"status": "deleted", "job_id": job_id})
    return json.dumps({"error": f"Job not found: {job_id}"})


TOOL_HANDLERS = {
    "memory_write": lambda p: json.dumps({
        "status": "saved",
        "path": memory_store.write_memory(p.get("content", ""), p.get("category", "general")),
    }),
    "memory_search": lambda p: json.dumps({
        "results": memory_store.search_memory(p.get("query", ""), p.get("top_k", 5)),
    }),
    "cron_create": _handle_cron_create,
    "cron_list": _handle_cron_list,
    "cron_delete": _handle_cron_delete,
}


# ---------------------------------------------------------------------------
# System Prompt 构建
# ---------------------------------------------------------------------------

soul_system = SoulSystem(WORKSPACE_DIR)


def build_system_prompt() -> str:
    """构建完整 system prompt: soul + base + memory context + cron context."""
    base = BASE_SYSTEM_PROMPT.format(datetime=datetime.now().strftime("%Y-%m-%d %H:%M"))
    prompt = soul_system.build_system_prompt(base)

    evergreen = memory_store.load_evergreen()
    if evergreen:
        prompt += f"\n\n---\n\n## Evergreen Memory\n\n{evergreen}"

    recent = memory_store.get_recent_memories(days=3)
    if recent:
        prompt += "\n\n---\n\n## Recent Memory Context\n"
        for entry in recent:
            prompt += f"\n### {entry['date']}\n{entry['content'][:500]}\n"

    # cron context: 让 agent 知道当前 cron 状态
    if _cron_store is not None:
        jobs = _cron_store.load()
        if jobs:
            prompt += "\n\n---\n\n## Active Cron Jobs\n"
            for job in jobs:
                status = "enabled" if job.get("enabled") else "disabled"
                prompt += f"- [{status}] {job.get('name', '?')} (id={job.get('id', '?')})\n"

    return prompt


# ---------------------------------------------------------------------------
# Agent 执行函数
# ---------------------------------------------------------------------------

def run_agent_single_turn(prompt: str) -> str:
    """执行单轮 agent 调用 (无工具), 用于心跳和 cron job."""
    system = build_system_prompt()
    try:
        response = client.messages.create(
            model=MODEL_ID,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        text = ""
        for block in response.content:
            if hasattr(block, "text"):
                text += block.text
        return text.strip()
    except Exception as exc:
        return f"[agent error: {exc}]"


# ---------------------------------------------------------------------------
# Agent 循环 + Heartbeat + Cron
# ---------------------------------------------------------------------------

def agent_loop(cron_service: CronService, heartbeat: HeartbeatRunner) -> None:
    """主 agent 循环 -- 带 Cron 和 Heartbeat 的 REPL."""

    messages: list[dict] = []

    print_info("=" * 64)
    print_info("  Mini-Claw  |  Section 08: Cron Scheduler")
    print_info(f"  Model: {MODEL_ID}")
    print_info(f"  Workspace: {WORKSPACE_DIR}")
    print_info(f"  Heartbeat: every {HEARTBEAT_INTERVAL}s "
               f"(active {HEARTBEAT_ACTIVE_START}:00-{HEARTBEAT_ACTIVE_END}:00)")
    print_info("  Commands:")
    print_info("    /cron           - list all cron jobs")
    print_info("    /cron-log       - show recent cron run log")
    print_info("    /trigger-cron <id> - manually trigger a cron job")
    print_info("    /heartbeat      - show heartbeat status")
    print_info("    /trigger        - manually trigger heartbeat")
    print_info("    quit / exit     - stop and exit")
    print_info("=" * 64)
    print()

    while True:
        # 输出心跳消息
        for msg in heartbeat.drain_output():
            print_heartbeat(msg)

        # 输出 cron 消息
        for msg in cron_service.drain_output():
            print_cron(msg)

        # 用户输入
        try:
            user_input = input(colored_prompt()).strip()
        except (KeyboardInterrupt, EOFError):
            print(f"\n{DIM}Goodbye.{RESET}")
            break

        if not user_input:
            continue

        if user_input.lower() in ("quit", "exit"):
            print(f"{DIM}Goodbye.{RESET}")
            break

        # -- 内置命令: /cron --
        if user_input == "/cron":
            jobs = _cron_store.load() if _cron_store else []
            if not jobs:
                print(f"\n{ORANGE}No cron jobs.{RESET}\n")
                continue
            print(f"\n{ORANGE}--- Cron Jobs ---{RESET}")
            for job in jobs:
                state = job.get("state", {})
                schedule = job.get("schedule", {})
                kind = schedule.get("kind", "?")
                status_icon = f"{GREEN}ON{RESET}" if job.get("enabled") else f"{RED}OFF{RESET}"
                next_run = state.get("next_run_at")
                next_str = (
                    datetime.fromtimestamp(next_run).strftime("%Y-%m-%d %H:%M:%S")
                    if next_run else "N/A"
                )
                last_status = state.get("last_status", "-")
                errors = state.get("consecutive_errors", 0)
                # 构建 schedule 描述
                if kind == "at":
                    sched_desc = f"at {schedule.get('at_time', '?')}"
                elif kind == "every":
                    sched_desc = f"every {schedule.get('every_seconds', '?')}s"
                elif kind == "cron":
                    sched_desc = f"cron '{schedule.get('expr', '?')}'"
                else:
                    sched_desc = str(schedule)
                dar = " [one-shot]" if job.get("delete_after_run") else ""
                print(f"  [{status_icon}] {job.get('id', '?')} "
                      f"| {job.get('name', 'unnamed')}{dar}")
                print(f"       schedule: {sched_desc}")
                print(f"       next_run: {next_str} | last: {last_status} "
                      f"| errors: {errors}")
            print(f"{ORANGE}--- end ({len(jobs)} jobs) ---{RESET}\n")
            continue

        # -- 内置命令: /cron-log --
        if user_input == "/cron-log":
            if _cron_run_log is None:
                print(f"\n{DIM}No cron run log.{RESET}\n")
                continue
            entries = _cron_run_log.read_recent(limit=15)
            if not entries:
                print(f"\n{ORANGE}No cron run log entries.{RESET}\n")
                continue
            print(f"\n{ORANGE}--- Recent Cron Runs ---{RESET}")
            for entry in entries:
                ts = entry.get("ts", 0)
                ts_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "?"
                status = entry.get("status", "?")
                job_name = entry.get("job_name", entry.get("job_id", "?"))
                duration = entry.get("duration_ms", 0)
                summary = entry.get("summary", "")[:80]
                status_color = GREEN if status == "ok" else RED
                print(f"  {DIM}{ts_str}{RESET} "
                      f"{status_color}{status}{RESET} "
                      f"{job_name} ({duration:.0f}ms) "
                      f"{DIM}{summary}{RESET}")
            print(f"{ORANGE}--- end ({len(entries)} entries) ---{RESET}\n")
            continue

        # -- 内置命令: /trigger-cron <id> --
        if user_input.startswith("/trigger-cron"):
            parts = user_input.split(maxsplit=1)
            if len(parts) < 2:
                print(f"{YELLOW}Usage: /trigger-cron <job_id>{RESET}\n")
                continue
            job_id = parts[1].strip()
            print_info(f"Manually triggering cron job {job_id}...")
            result = cron_service.trigger_job(job_id)
            if result is None:
                print(f"{YELLOW}Job not found: {job_id}{RESET}\n")
            elif result["status"] == "ok":
                print_cron(f"Job '{result['job_name']}': {result['response'][:500]}")
            else:
                print(f"{RED}Job failed: {result['error']}{RESET}\n")
            continue

        # -- 内置命令: /heartbeat --
        if user_input == "/heartbeat":
            should, reason = heartbeat.should_run()
            elapsed = time.time() - heartbeat.last_run
            next_in = max(0, heartbeat.interval - elapsed)
            print(f"\n{BLUE}--- Heartbeat Status ---{RESET}")
            print(f"  Enabled: {heartbeat.heartbeat_path.exists()}")
            print(f"  Interval: {heartbeat.interval}s")
            print(f"  Last run: {elapsed:.0f}s ago")
            print(f"  Next in: ~{next_in:.0f}s")
            print(f"  Should run: {should} ({reason})")
            print(f"  Running: {heartbeat.running}")
            print(f"{BLUE}--- end ---{RESET}\n")
            continue

        # -- 内置命令: /trigger --
        if user_input == "/trigger":
            print_info("Manually triggering heartbeat...")
            result = heartbeat.run_heartbeat_turn(run_agent_single_turn)
            if result:
                print_heartbeat(result)
            else:
                print_info("Heartbeat returned HEARTBEAT_OK (nothing to report).\n")
            heartbeat.last_run = time.time()
            continue

        # -- 获取互斥锁, 处理用户消息 --
        heartbeat._lock.acquire()
        try:
            messages.append({"role": "user", "content": user_input})
            system_prompt = build_system_prompt()

            # Agent 内循环 (带工具调用)
            while True:
                try:
                    response = client.messages.create(
                        model=MODEL_ID,
                        max_tokens=8096,
                        system=system_prompt,
                        messages=messages,
                        tools=TOOLS,
                    )
                except Exception as exc:
                    print(f"\n{YELLOW}API Error: {exc}{RESET}\n")
                    messages.pop()
                    break

                if response.stop_reason == "end_turn":
                    text = ""
                    for block in response.content:
                        if hasattr(block, "text"):
                            text += block.text
                    if text:
                        print_assistant(text)
                    messages.append({"role": "assistant", "content": response.content})
                    break

                elif response.stop_reason == "tool_use":
                    messages.append({"role": "assistant", "content": response.content})
                    tool_results = []
                    for block in response.content:
                        if block.type == "tool_use":
                            handler = TOOL_HANDLERS.get(block.name)
                            if handler:
                                print_tool(block.name,
                                           json.dumps(block.input, ensure_ascii=False)[:120])
                                result = handler(block.input)
                                tool_results.append({
                                    "type": "tool_result",
                                    "tool_use_id": block.id,
                                    "content": result,
                                })
                            else:
                                tool_results.append({
                                    "type": "tool_result",
                                    "tool_use_id": block.id,
                                    "content": json.dumps({"error": f"Unknown tool: {block.name}"}),
                                    "is_error": True,
                                })
                    messages.append({"role": "user", "content": tool_results})

                else:
                    text = ""
                    for block in response.content:
                        if hasattr(block, "text"):
                            text += block.text
                    if text:
                        print_assistant(text)
                    messages.append({"role": "assistant", "content": response.content})
                    break
        finally:
            heartbeat._lock.release()


# ---------------------------------------------------------------------------
# 全局引用 (在 main 中初始化)
# ---------------------------------------------------------------------------

_cron_run_log: CronRunLog | None = None


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main() -> None:
    global _cron_store, _cron_run_log

    if not os.getenv("ANTHROPIC_API_KEY"):
        print(f"{YELLOW}Error: ANTHROPIC_API_KEY not set.{RESET}")
        print(f"{DIM}Copy .env.example to .env and fill in your key.{RESET}")
        sys.exit(1)

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # 创建示例 SOUL.md
    soul_path = WORKSPACE_DIR / "SOUL.md"
    if not soul_path.exists():
        soul_path.write_text(
            "# Soul\n\n"
            "You are Koda, a thoughtful AI assistant.\n\n"
            "## Personality\n"
            "- Warm but not overly enthusiastic\n"
            "- Prefer concise, clear explanations\n\n"
            "## Language Style\n"
            "- Direct and clear\n"
            "- No filler phrases\n",
            encoding="utf-8",
        )
        print_info(f"Created sample SOUL.md at {soul_path}")

    # 创建示例 HEARTBEAT.md
    heartbeat_path = WORKSPACE_DIR / "HEARTBEAT.md"
    if not heartbeat_path.exists():
        heartbeat_path.write_text(
            "# Heartbeat Instructions\n\n"
            "Check the following and report ONLY if action is needed:\n\n"
            "1. Review today's memory log for any unfinished tasks or pending items.\n"
            "2. If the user mentioned a deadline or reminder, check if it is approaching.\n"
            "3. If there are new daily memories, summarize any actionable items.\n\n"
            "If nothing needs attention, respond with exactly: HEARTBEAT_OK\n",
            encoding="utf-8",
        )
        print_info(f"Created sample HEARTBEAT.md at {heartbeat_path}")

    # 初始化 Cron Store
    cron_dir = WORKSPACE_DIR / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    store_path = cron_dir / "jobs.json"
    cron_store = CronStore(store_path)
    _cron_store = cron_store

    # 如果 store 为空, 创建示例 job
    existing_jobs = cron_store.load()
    if not existing_jobs:
        # 示例 cron 表达式任务: 每分钟检查 (演示用)
        sample_cron_job = make_cron_job(
            name="demo-every-minute",
            schedule={"kind": "cron", "expr": "* * * * *"},
            payload={"kind": "agent_turn", "message": (
                "This is a scheduled check. Briefly state: "
                "'Cron check at [current time]. All systems nominal.' "
                "Keep it under 20 words."
            )},
            job_id="demo-cron",
        )
        sample_cron_job["state"]["next_run_at"] = compute_next_run_at(
            sample_cron_job["schedule"], time.time()
        )

        # 示例 every 任务: 每 90 秒 (演示用)
        sample_every_job = make_cron_job(
            name="demo-every-90s",
            schedule={
                "kind": "every",
                "every_seconds": 90,
                "anchor": datetime.now().astimezone().isoformat(),
            },
            payload={"kind": "agent_turn", "message": (
                "This is an interval check (every 90s). "
                "Reply with a very short status update (under 15 words)."
            )},
            enabled=False,  # 默认禁用, 用户可手动启用
            job_id="demo-every",
        )

        cron_store.save([sample_cron_job, sample_every_job])
        print_info("Created sample cron jobs (demo-cron enabled, demo-every disabled)")

    # 初始化 Cron Run Log
    run_log_path = cron_dir / "run-log.jsonl"
    cron_run_log = CronRunLog(run_log_path)
    _cron_run_log = cron_run_log

    # 创建 Cron Service
    def agent_fn_factory():
        return run_agent_single_turn
    cron_service = CronService(cron_store, cron_run_log, agent_fn_factory)

    # 创建 Heartbeat Runner
    heartbeat = HeartbeatRunner(
        interval_seconds=HEARTBEAT_INTERVAL,
        active_hours=(HEARTBEAT_ACTIVE_START, HEARTBEAT_ACTIVE_END),
        heartbeat_path=heartbeat_path,
    )

    # 启动后台线程
    heartbeat.start(run_agent_single_turn)
    print_info(f"Heartbeat started (interval={HEARTBEAT_INTERVAL}s)")

    cron_service.start()
    job_count = len(cron_store.load())
    print_info(f"Cron service started ({job_count} jobs loaded)")
    print_info("")

    if croniter is None:
        print(f"{YELLOW}Warning: croniter not installed. "
              f"'cron' schedule type will not work.{RESET}")
        print(f"{DIM}Install with: pip install croniter{RESET}\n")

    try:
        agent_loop(cron_service, heartbeat)
    finally:
        cron_service.stop()
        print_info("Cron service stopped.")
        heartbeat.stop()
        print_info("Heartbeat stopped.")


if __name__ == "__main__":
    main()
