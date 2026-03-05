"""
Section 07 — Heartbeat & Proactive Behavior
"Not just reactive — proactive"

本文件是 s06_soul_memory.py 的【功能超集】— 在 Soul+Memory 框架之上,
加入 OpenClaw 最独特的特性: 心跳系统 (Heartbeat).

传统 chatbot 只能被动回复; OpenClaw 的 agent 像一个真正的助手,
会定期 "检查一下" 是否有需要汇报的事情.

【与 s06 的关系 — 纯增量, 零删减】
  s06_soul_memory.py 提供:
    - AgentWithSoulMemory / workspace / SOUL.md / MEMORY.md
    - MemoryIndexManager + memory_search / memory_get / memory_write
    - build_agent_system_prompt (soul + memory 注入)
    - run_agent_with_soul_and_memory (带工具循环的 agent runner)
    - SoulMemoryGateway (WebSocket 网关)
    - run_repl / test_client / interactive_chat

  本文件新增:
    - HEARTBEAT.md: workspace bootstrap file, 定义心跳检查内容
    - HeartbeatRunner: 后台定时器, 周期性触发 agent 执行
    - Active Hours: 只在配置时间窗口内运行
    - HEARTBEAT_OK token: 静默信号, 不发送给用户
    - 互斥锁: 心跳让位于用户消息
    - 去重: 24h 内不发送重复内容
    - HeartbeatGateway: 继承 SoulMemoryGateway, 增加心跳 RPC
    - run_repl_with_heartbeat: 继承 s06 REPL, 增加心跳后台循环

【参考】OpenClaw 源码
  - src/infra/heartbeat-runner.ts      HeartbeatRunner + runHeartbeatOnce
  - src/auto-reply/heartbeat.ts        HEARTBEAT_PROMPT + stripHeartbeatToken
  - src/infra/heartbeat-active-hours.ts isWithinActiveHours
  - src/infra/heartbeat-events.ts      事件发射 + 指示器类型
  - src/infra/heartbeat-wake.ts        唤醒 + 调度
  - src/infra/heartbeat-visibility.ts  可见性 (showOk / showAlerts)
  - src/auto-reply/tokens.ts           HEARTBEAT_TOKEN = "HEARTBEAT_OK"

── 心跳与 Soul/Memory 的信息流 ──────────────────────────

  HeartbeatRunner (后台线程, 每秒 tick)
      │
      ├─ [1] 6 步检查链 (enabled → interval → active hours
      │       → HEARTBEAT.md 有内容 → 主通道空闲 → 未在运行)
      │
      ├─ [2] 获取互斥锁 (与用户消息互斥)
      │
      ├─ [3] 构建心跳上下文 — 复用 s06 的完整流程:
      │       │
      │       ├─ build_agent_system_prompt(agent, base_prompt)
      │       │   ├─ Base system prompt (identity + tools)
      │       │   ├─ Personality (from agent config)
      │       │   ├─ ## Memory Recall 指令
      │       │   ├─ ## Time / Workspace
      │       │   ├─ ## Project Context Files
      │       │   │   ├─ SOUL.md → 人格注入 (心跳也有人格!)
      │       │   │   └─ MEMORY.md → 长期记忆
      │       │   └─ ## Recent Memory (今日 + 昨日 headline)
      │       │
      │       ├─ 加载 HEARTBEAT.md → 追加到 user message
      │       │   "Read HEARTBEAT.md ... If nothing needs attention, reply HEARTBEAT_OK"
      │       │
      │       └─ 加载 session 历史 (与用户对话共享!)
      │           → 心跳能看到之前的用户消息, 知道上下文
      │
      ├─ [4] 调用 LLM (带完整工具集)
      │       │
      │       ├─ Tools = s04 工具 + memory_search + memory_get + memory_write
      │       │   → 心跳可以搜索记忆 (查 deadline / todo)
      │       │   → 心跳可以写入记忆 (记录观察结果)
      │       │
      │       └─ 工具循环: 与 run_agent_with_soul_and_memory 相同
      │           → 可能多轮: search memory → get lines → 生成回复
      │
      ├─ [5] 处理响应
      │       │
      │       ├─ 空响应 → status="ok-empty", 静默
      │       ├─ 含 HEARTBEAT_OK → strip token
      │       │   ├─ 剩余文字 ≤ ackMaxChars (300) → status="ok-token", 静默
      │       │   └─ 剩余文字 > ackMaxChars → 视为有内容
      │       ├─ 有内容 → 去重检查 (24h hash)
      │       │   ├─ 重复 → status="skipped", reason="duplicate"
      │       │   └─ 新内容 → status="sent", 输出给用户
      │       │
      │       └─ 注意: 心跳回复 **不** 推进 session.updatedAt
      │           → 保持 idle timeout 语义, 只有用户消息才算活跃
      │
      └─ [6] 发射心跳事件 (Gateway 广播 / UI 指示器)

  关键设计:
    ✓ 心跳复用 Soul (同一个人格说话)
    ✓ 心跳复用 Memory (能查历史、查 todo、查 deadline)
    ✓ 心跳共享 Session (知道用户聊了什么)
    ✓ 心跳能写 Memory (把观察结果持久化)
    ✓ 心跳让位于用户 (互斥锁, 用户消息优先)
    ✓ 心跳不推进 session 时间 (不干扰 idle 超时)

── 运行方式 (完全兼容 s06 的所有模式, 且增加心跳) ──

  1. 服务器模式 (带心跳的网关):
     python s07_heartbeat.py

  2. 测试客户端 (s06 测试 + 心跳状态):
     python s07_heartbeat.py --test-client

  3. 交互式对话 (连接网关, s06 完整功能):
     python s07_heartbeat.py --chat

  4. 交互式 REPL (路由 + Soul/Memory + 心跳后台循环):
     python s07_heartbeat.py --repl

  5. 自定义心跳间隔:
     python s07_heartbeat.py --repl --interval 30 --active-start 09:00 --active-end 22:00

── 依赖 ──────────────────────────────────────────
  pip install python-dotenv websockets
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

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

# ── 从 s06 导入: Soul+Memory 框架 (全量, 零删减) ──
from s06_soul_memory import (
    # Agent 配置 + workspace
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
    # Agent runner (核心: 心跳复用此函数与 soul/memory 交互)
    run_agent_with_soul_and_memory,
    # Gateway (心跳版将继承它)
    SoulMemoryGateway,
    # 客户端模式 (原样继承)
    test_client as s06_test_client,
    interactive_chat as s06_interactive_chat,
    # REPL (心跳版将扩展它)
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

# 网关配置 (与 s06 一致)
GATEWAY_HOST = os.getenv("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "18789"))
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")

# 日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway-heartbeat")

# ---------------------------------------------------------------------------
# 心跳颜色
# ---------------------------------------------------------------------------
RED = "\033[31m"


def print_heartbeat(text: str) -> None:
    """心跳消息用蓝色标记, 与普通回复区分."""
    print(f"\n{BLUE}{BOLD}[Heartbeat]{RESET} {text}\n")


def print_heartbeat_status(text: str) -> None:
    """心跳状态信息用 DIM 显示."""
    print(f"  {DIM}[heartbeat] {text}{RESET}")


# ============================================================================
# Part 1: HEARTBEAT_OK Token 处理
# ============================================================================
#
# 【参考】OpenClaw src/auto-reply/heartbeat.ts  stripHeartbeatToken()
# 【参考】OpenClaw src/auto-reply/tokens.ts     HEARTBEAT_TOKEN = "HEARTBEAT_OK"
#
# Agent 回复 HEARTBEAT_OK 表示 "没事可报", 不应发送给用户.
# 如果 HEARTBEAT_OK 后面跟着少量文字 (≤ ackMaxChars), 也视为静默.
# ============================================================================

HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK"

# 【参考】OpenClaw heartbeat.ts  DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300
DEFAULT_ACK_MAX_CHARS = 300

# 【参考】OpenClaw heartbeat.ts  DEFAULT_HEARTBEAT_EVERY = "30m"
DEFAULT_HEARTBEAT_EVERY_SECONDS = 30 * 60

# 演示用默认间隔 (60s), 方便观察
DEMO_HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "60"))

# 活跃时段 (24 小时制, 支持跨午夜)
HEARTBEAT_ACTIVE_START = os.getenv("HEARTBEAT_ACTIVE_START", "09:00")
HEARTBEAT_ACTIVE_END = os.getenv("HEARTBEAT_ACTIVE_END", "22:00")

# 去重窗口: 24 小时
DEDUP_WINDOW_SECONDS = 24 * 60 * 60

# 【参考】OpenClaw heartbeat.ts  HEARTBEAT_PROMPT
HEARTBEAT_PROMPT = (
    "Read HEARTBEAT.md if it exists (workspace context). "
    "Follow it strictly. Do not infer or repeat old tasks from prior chats. "
    "If nothing needs attention, reply HEARTBEAT_OK."
)

DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md"


def strip_heartbeat_token(
    text: str | None,
    *,
    ack_max_chars: int = DEFAULT_ACK_MAX_CHARS,
) -> dict:
    """从 agent 响应中剥离 HEARTBEAT_OK 标记.

    【参考】OpenClaw src/auto-reply/heartbeat.ts  stripHeartbeatToken()

    逻辑:
      1. 空文本 → should_skip=True
      2. 移除 HTML/Markdown 包裹 (<b>HEARTBEAT_OK</b>, **HEARTBEAT_OK**)
      3. 从前后反复移除 HEARTBEAT_OK token
      4. 剩余为空 → should_skip=True
      5. 剩余 ≤ ackMaxChars → should_skip=True (少量注释也视为静默)
      6. 否则返回去掉 token 后的实质内容
    """
    if not text:
        return {"should_skip": True, "text": "", "did_strip": False}

    trimmed = text.strip()
    if not trimmed:
        return {"should_skip": True, "text": "", "did_strip": False}

    def strip_markup(s: str) -> str:
        s = re.sub(r"<[^>]*>", " ", s)
        s = re.sub(r"&nbsp;", " ", s, flags=re.IGNORECASE)
        s = re.sub(r"^[*`~_]+", "", s)
        s = re.sub(r"[*`~_]+$", "", s)
        return s

    normalized = strip_markup(trimmed)
    has_token = HEARTBEAT_OK_TOKEN in trimmed or HEARTBEAT_OK_TOKEN in normalized

    if not has_token:
        return {"should_skip": False, "text": trimmed, "did_strip": False}

    def strip_edges(s: str) -> tuple[str, bool]:
        did_strip = False
        changed = True
        while changed:
            changed = False
            s = s.strip()
            if s.startswith(HEARTBEAT_OK_TOKEN):
                s = s[len(HEARTBEAT_OK_TOKEN):].lstrip()
                did_strip = True
                changed = True
            pattern = re.escape(HEARTBEAT_OK_TOKEN) + r"[^\w]{0,4}$"
            m = re.search(pattern, s)
            if m:
                s = s[:m.start()].rstrip()
                did_strip = True
                changed = True
        return re.sub(r"\s+", " ", s).strip(), did_strip

    stripped_orig, did_orig = strip_edges(trimmed)
    stripped_norm, did_norm = strip_edges(normalized)

    if did_orig and stripped_orig:
        rest = stripped_orig
    elif did_norm:
        rest = stripped_norm
    else:
        return {"should_skip": False, "text": trimmed, "did_strip": False}

    did_strip = did_orig or did_norm

    if not rest:
        return {"should_skip": True, "text": "", "did_strip": did_strip}

    if len(rest) <= ack_max_chars:
        return {"should_skip": True, "text": "", "did_strip": did_strip}

    return {"should_skip": False, "text": rest, "did_strip": did_strip}


# ============================================================================
# Part 2: HEARTBEAT.md 内容检查
# ============================================================================
#
# 【参考】OpenClaw src/auto-reply/heartbeat.ts isHeartbeatContentEffectivelyEmpty()
#
# 文件只含空行 / heading / 空 checkbox → 视为"无实质内容", 跳过 LLM 调用.
# ============================================================================

def is_heartbeat_content_effectively_empty(content: str | None) -> bool:
    """检查 HEARTBEAT.md 内容是否实质为空."""
    if content is None:
        return False
    if not isinstance(content, str):
        return False

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if re.match(r"^#+(\s|$)", stripped):
            continue
        if re.match(r"^[-*+]\s*(\[[\sXx]?\]\s*)?$", stripped):
            continue
        return False
    return True


def load_heartbeat_file(workspace_dir: Path) -> str | None:
    """加载 HEARTBEAT.md 文件内容."""
    path = workspace_dir / DEFAULT_HEARTBEAT_FILENAME
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


# ============================================================================
# Part 3: Active Hours — 活跃时段检查
# ============================================================================
#
# 【参考】OpenClaw src/infra/heartbeat-active-hours.ts  isWithinActiveHours()
# ============================================================================

def parse_active_hours_time(raw: str, *, allow_24: bool = False) -> int | None:
    """解析 "HH:MM" 格式时间, 返回分钟数 (0-1440)."""
    m = re.match(r"^([01]\d|2[0-3]|24):([0-5]\d)$", raw.strip())
    if not m:
        try:
            hour = int(raw.strip())
            if 0 <= hour <= 23:
                return hour * 60
            if hour == 24 and allow_24:
                return 24 * 60
        except ValueError:
            pass
        return None

    hour, minute = int(m.group(1)), int(m.group(2))
    if hour == 24:
        if not allow_24 or minute != 0:
            return None
        return 24 * 60
    return hour * 60 + minute


def is_within_active_hours(
    active_start: str = "09:00",
    active_end: str = "22:00",
    now: datetime | None = None,
) -> bool:
    """检查当前时间是否在活跃时段内. 支持跨午夜."""
    start_min = parse_active_hours_time(active_start, allow_24=False)
    end_min = parse_active_hours_time(active_end, allow_24=True)

    if start_min is None or end_min is None:
        return True
    if start_min == end_min:
        return True

    if now is None:
        now = datetime.now()
    current_min = now.hour * 60 + now.minute

    if end_min > start_min:
        return start_min <= current_min < end_min
    else:
        return current_min >= start_min or current_min < end_min


# ============================================================================
# Part 4: Heartbeat Event — 心跳事件
# ============================================================================
#
# 【参考】OpenClaw src/infra/heartbeat-events.ts
# ============================================================================

HEARTBEAT_STATUS_SENT = "sent"
HEARTBEAT_STATUS_OK_EMPTY = "ok-empty"
HEARTBEAT_STATUS_OK_TOKEN = "ok-token"
HEARTBEAT_STATUS_SKIPPED = "skipped"
HEARTBEAT_STATUS_FAILED = "failed"


def emit_heartbeat_event(
    status: str,
    *,
    reason: str | None = None,
    preview: str | None = None,
    duration_ms: int | None = None,
) -> dict:
    """发射心跳事件. 返回事件 payload 供 Gateway 广播.

    【参考】OpenClaw src/infra/heartbeat-events.ts  emitHeartbeatEvent()
    """
    payload = {"ts": time.time(), "status": status}
    if reason:
        payload["reason"] = reason
    if preview:
        payload["preview"] = preview[:200]
    if duration_ms is not None:
        payload["durationMs"] = duration_ms

    # 指示器类型 (供 UI 显示)
    if status in (HEARTBEAT_STATUS_OK_EMPTY, HEARTBEAT_STATUS_OK_TOKEN):
        payload["indicatorType"] = "ok"
    elif status == HEARTBEAT_STATUS_SENT:
        payload["indicatorType"] = "alert"
    elif status == HEARTBEAT_STATUS_FAILED:
        payload["indicatorType"] = "error"

    parts = [f"status={status}"]
    if reason:
        parts.append(f"reason={reason}")
    if preview:
        parts.append(f"preview={preview[:80]!r}")
    if duration_ms is not None:
        parts.append(f"duration={duration_ms}ms")
    log.info("heartbeat-event: %s", ", ".join(parts))

    return payload


# ============================================================================
# Part 5: HeartbeatRunner — 心跳引擎
# ============================================================================
#
# 【参考】OpenClaw src/infra/heartbeat-runner.ts
#
# 核心设计: 心跳复用 s06 的 run_agent_with_soul_and_memory 完整流程,
# 包括 Soul 人格注入、Memory 搜索/写入、Session 历史.
#
# 信息流:
#   HeartbeatRunner._background_loop()   ← 后台线程, 每秒 tick
#       │
#       ├─ should_run() → 6 步检查
#       ├─ 获取互斥锁 (与用户消息互斥)
#       │
#       └─ run_heartbeat_once()
#           │
#           ├─ 加载 HEARTBEAT.md → 构建心跳 user message
#           ├─ build_agent_system_prompt() → Soul + Memory 完整注入
#           ├─ 加载 session 历史 (共享!) → 心跳看到用户聊天上下文
#           ├─ 调用 LLM (带 memory 工具) → 可搜索/写入记忆
#           ├─ strip HEARTBEAT_OK → 去重 → 输出
#           └─ 心跳回复不存入 session (不推进 updatedAt)
#
# 与 s06 的信息交互:
#   ✓ 读: Soul (人格) → 心跳用相同人格说话
#   ✓ 读: MEMORY.md (长期记忆) → 心跳知道持久化的知识
#   ✓ 读: memory/日期.md (每日记忆) → 心跳检查 todo/deadline
#   ✓ 读: Session 历史 → 心跳知道用户最近聊了什么
#   ✓ 写: memory_write → 心跳可以把观察结果写入记忆
#   ✗ 写: Session → 心跳回复不写入 session (保持 idle 语义)
# ============================================================================

class HeartbeatRunner:
    """心跳运行器: 后台定时循环, 让 agent 定期检查并主动汇报.

    【参考】OpenClaw src/infra/heartbeat-runner.ts
    """

    def __init__(
        self,
        agent: AgentWithSoulMemory,
        session_store: S04SessionStore,
        session_key: str,
        *,
        interval_seconds: int = DEFAULT_HEARTBEAT_EVERY_SECONDS,
        active_start: str = "09:00",
        active_end: str = "22:00",
        ack_max_chars: int = DEFAULT_ACK_MAX_CHARS,
    ):
        self.agent = agent
        self.session_store = session_store
        self.session_key = session_key

        self.interval = interval_seconds
        self.active_start = active_start
        self.active_end = active_end
        self.ack_max_chars = ack_max_chars

        self.heartbeat_path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME

        # 运行时状态
        self.last_run: float = 0.0
        self.running = False
        self.total_runs: int = 0
        self.total_alerts: int = 0

        # 去重
        self.last_heartbeat_text: str = ""
        self.last_heartbeat_sent_at: float = 0.0

        # 互斥锁: 心跳和用户消息共享
        self._lock = threading.Lock()

        # 后台线程控制
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # 心跳产生的消息队列, 由主线程消费
        self._output_queue: list[dict] = []
        self._output_lock = threading.Lock()

        # 事件回调 (Gateway 模式下用于广播)
        self.on_event: list = []  # list of callable(payload)

    # -- 6 步检查链 --

    def _is_enabled(self) -> bool:
        """[1] heartbeat 是否启用?"""
        return self.interval > 0

    def _interval_elapsed(self) -> bool:
        """[2] 间隔是否已过?"""
        return (time.time() - self.last_run) >= self.interval

    def _is_active_hours(self) -> bool:
        """[3] 当前是否在活跃时段?"""
        return is_within_active_hours(self.active_start, self.active_end)

    def _heartbeat_has_content(self) -> bool:
        """[4] HEARTBEAT.md 是否有实质内容?"""
        content = load_heartbeat_file(self.agent.workspace_dir)
        if content is None:
            return False
        return not is_heartbeat_content_effectively_empty(content)

    def _main_lane_idle(self) -> bool:
        """[5] 主通道是否空闲? (尝试非阻塞获取锁)"""
        acquired = self._lock.acquire(blocking=False)
        if acquired:
            self._lock.release()
            return True
        return False

    def should_run(self) -> tuple[bool, str]:
        """6 步检查链, 返回 (是否运行, 原因)."""
        if not self._is_enabled():
            return False, "disabled"
        if not self._interval_elapsed():
            return False, "not-due"
        if not self._is_active_hours():
            return False, "quiet-hours"
        if not self._heartbeat_has_content():
            return False, "empty-heartbeat-file"
        if not self._main_lane_idle():
            return False, "requests-in-flight"
        if self.running:
            return False, "already-running"
        return True, "ok"

    # -- 心跳执行 (核心信息流) --

    def run_heartbeat_once(self) -> dict:
        """执行一次心跳.

        【信息流详解】
        这是心跳与 soul/memory 框架交互的核心:

        1. 构建 system prompt — 复用 s06 的 build_agent_system_prompt:
           - 注入 SOUL.md (心跳用相同人格说话)
           - 注入 MEMORY.md (心跳知道长期记忆)
           - 注入 Recent Memory (心跳知道最近发生了什么)
           - 注入 Memory Recall 指令 (心跳被提示用 memory_search)

        2. 加载 session 历史 — 与用户对话共享:
           - 心跳能看到用户之前说了什么
           - 例: 用户说 "明天下午 3 点开会", 心跳到时间会提醒

        3. 构建心跳 prompt — 注入 HEARTBEAT.md:
           - HEARTBEAT.md 定义检查清单
           - 作为 user message 追加到 session 历史后面

        4. 调用 LLM — 带完整工具集:
           - memory_search: 搜索记忆 (查 deadline, todo, reminder)
           - memory_get: 精确读取记忆行
           - memory_write: 写入观察结果 (心跳也能产生记忆!)
           - s04 工具: get_weather, search_web 等

        5. 处理响应:
           - HEARTBEAT_OK → 静默
           - 有内容 → 去重 → 输出给用户

        6. 关键: 心跳回复不写入 session 历史
           - 避免 session 被心跳消息污染
           - 保持 idle timeout 语义

        返回:
          {"status": str, "text": str, "duration_ms": int, "reason": str|None}
        """
        started_at = time.time()
        self.total_runs += 1

        try:
            # ── Step 1: 构建 system prompt (复用 s06 完整流程) ──
            # 这里 build_agent_system_prompt 会:
            #   - 注入 Base prompt (identity + tools)
            #   - 注入 agent.system_prompt (personality)
            #   - 注入 Memory Recall 指令
            #   - 注入 Time / Workspace
            #   - 注入 SOUL.md (project context file → 人格!)
            #   - 注入 MEMORY.md (project context file → 长期记忆!)
            #   - 注入 Recent Memory (今日 + 昨日 headline)
            system_prompt = build_agent_system_prompt(self.agent, S04_SYSTEM_PROMPT)

            # ── Step 2: 加载 session 历史 (与用户对话共享) ──
            # 心跳看到的是同一个 session, 所以知道用户之前聊了什么
            session_data = self.session_store.load_session(self.session_key)
            messages = list(session_data["history"])  # 浅拷贝, 不修改原始 session

            # ── Step 3: 构建心跳 user message ──
            # 加载 HEARTBEAT.md 作为上下文, 追加到心跳 prompt
            heartbeat_content = load_heartbeat_file(self.agent.workspace_dir)
            heartbeat_user_msg = HEARTBEAT_PROMPT
            if heartbeat_content:
                heartbeat_user_msg += (
                    f"\n\n--- HEARTBEAT.md ---\n{heartbeat_content.strip()}\n--- end ---"
                )
            messages.append({"role": "user", "content": heartbeat_user_msg})

            # ── Step 4: 调用 LLM (带完整工具集) ──
            # 工具 = s04 工具 + memory 工具
            # 心跳可以: search memory → 查找 deadline/todo
            #           get memory → 精确读取
            #           write memory → 记录观察结果
            all_tools = TOOLS_OPENAI + build_memory_tools()

            # 工具循环 — 与 run_agent_with_soul_and_memory 相同逻辑
            response_text = ""
            max_tool_rounds = 5  # 防止无限循环

            for _round in range(max_tool_rounds):
                resp = deepseek_chat_with_tools(
                    messages,
                    all_tools,
                    model=self.agent.model,
                    system_prompt=system_prompt,
                    max_tokens=1024,
                )

                content = resp.get("content") or ""
                tool_calls = resp.get("tool_calls") or []

                if not tool_calls:
                    # 没有工具调用, content 就是最终回复
                    response_text = content
                    break

                # 有工具调用 → 执行工具 → 继续循环
                assistant_msg: dict = {"role": "assistant", "content": content}
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in tool_calls
                ]
                messages.append(assistant_msg)

                for tc in tool_calls:
                    try:
                        args = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"]
                    except json.JSONDecodeError:
                        args = {}

                    log.info("  [heartbeat-tool] %s(%s)", tc["name"],
                             json.dumps(args, ensure_ascii=False)[:80])

                    # memory 工具 → 心跳与 memory 的核心交互点
                    if tc["name"] in MEMORY_TOOL_NAMES:
                        result = handle_memory_tool(tc["name"], args, self.agent)
                    else:
                        result = process_tool_call(tc["name"], args)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })
            else:
                # 超过 max_tool_rounds, 取最后一次的 content
                response_text = content

            duration_ms = int((time.time() - started_at) * 1000)

            # ── Step 5: 处理响应 ──
            # 注意: 我们不把心跳的 messages 写回 session
            # 这保证心跳不污染用户对话历史, 不推进 session.updatedAt

            if not response_text.strip():
                payload = emit_heartbeat_event(
                    HEARTBEAT_STATUS_OK_EMPTY, duration_ms=duration_ms)
                self._notify_event(payload)
                return {"status": HEARTBEAT_STATUS_OK_EMPTY, "text": "",
                        "duration_ms": duration_ms, "reason": None}

            stripped = strip_heartbeat_token(
                response_text, ack_max_chars=self.ack_max_chars)

            if stripped["should_skip"]:
                payload = emit_heartbeat_event(
                    HEARTBEAT_STATUS_OK_TOKEN, duration_ms=duration_ms)
                self._notify_event(payload)
                return {"status": HEARTBEAT_STATUS_OK_TOKEN, "text": "",
                        "duration_ms": duration_ms, "reason": None}

            final_text = stripped["text"]

            # 去重检查 (24h)
            if (
                self.last_heartbeat_text.strip()
                and final_text.strip() == self.last_heartbeat_text.strip()
                and self.last_heartbeat_sent_at > 0
                and (started_at - self.last_heartbeat_sent_at) < DEDUP_WINDOW_SECONDS
            ):
                payload = emit_heartbeat_event(
                    HEARTBEAT_STATUS_SKIPPED, reason="duplicate",
                    preview=final_text[:200], duration_ms=duration_ms)
                self._notify_event(payload)
                return {"status": HEARTBEAT_STATUS_SKIPPED, "text": "",
                        "duration_ms": duration_ms, "reason": "duplicate"}

            # 有新内容 → 记录 + 输出
            self.last_heartbeat_text = final_text
            self.last_heartbeat_sent_at = started_at
            self.total_alerts += 1

            payload = emit_heartbeat_event(
                HEARTBEAT_STATUS_SENT, preview=final_text[:200],
                duration_ms=duration_ms)
            self._notify_event(payload)
            return {"status": HEARTBEAT_STATUS_SENT, "text": final_text,
                    "duration_ms": duration_ms, "reason": None}

        except Exception as exc:
            duration_ms = int((time.time() - started_at) * 1000)
            reason = str(exc)
            payload = emit_heartbeat_event(
                HEARTBEAT_STATUS_FAILED, reason=reason, duration_ms=duration_ms)
            self._notify_event(payload)
            log.error("heartbeat failed: %s", reason)
            return {"status": HEARTBEAT_STATUS_FAILED, "text": "",
                    "duration_ms": duration_ms, "reason": reason}

    def _notify_event(self, payload: dict) -> None:
        """通知所有事件监听器 (Gateway 广播用)."""
        for cb in self.on_event:
            try:
                cb(payload)
            except Exception:
                pass

    # -- 后台循环 --

    def _background_loop(self) -> None:
        """后台心跳循环: 每秒检查, 满足条件时执行.

        【参考】OpenClaw heartbeat-runner.ts  startHeartbeatRunner()

        这是心跳系统的核心循环:
          while not stopped:
            if should_run():
              acquire lock (与用户消息互斥)
              run_heartbeat_once()
              release lock
            sleep 1s
        """
        log.info("heartbeat loop started: agent=%s interval=%ds active=%s-%s",
                 self.agent.id, self.interval,
                 self.active_start, self.active_end)

        while not self._stop_event.is_set():
            should, reason = self.should_run()
            if should:
                acquired = self._lock.acquire(blocking=False)
                if not acquired:
                    self._stop_event.wait(1.0)
                    continue

                try:
                    self.running = True
                    self.last_run = time.time()
                    result = self.run_heartbeat_once()
                    # 把结果放入输出队列 (REPL 模式消费)
                    with self._output_lock:
                        self._output_queue.append(result)
                except Exception as exc:
                    log.error("heartbeat runner error: %s", exc)
                finally:
                    self.running = False
                    self._lock.release()

            self._stop_event.wait(1.0)

        log.info("heartbeat loop stopped: agent=%s", self.agent.id)

    def start(self) -> None:
        """启动后台心跳线程."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._background_loop,
            daemon=True,
            name=f"heartbeat-{self.agent.id}",
        )
        self._thread.start()

    def stop(self) -> None:
        """停止后台心跳线程."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None

    def drain_output(self) -> list[dict]:
        """取出所有待输出的心跳结果. 由主线程调用."""
        with self._output_lock:
            results = self._output_queue[:]
            self._output_queue.clear()
            return results


# ============================================================================
# Part 6: HEARTBEAT.md 示例创建
# ============================================================================

def _ensure_sample_heartbeat(agents: dict[str, AgentWithSoulMemory]) -> None:
    """为没有 HEARTBEAT.md 的 Agent 创建示例文件.

    【参考】OpenClaw docs/reference/templates/HEARTBEAT.md

    注意 HEARTBEAT.md 的内容决定了心跳检查什么:
    - 检查每日记忆中的 todo/deadline
    - 检查用户提到的提醒事项
    - 检查未完成任务
    这些检查项直接驱动心跳与 Memory 系统的信息交互.
    """
    sample_heartbeat = """\
# Heartbeat Instructions

Check the following and report ONLY if action is needed:

1. Use memory_search to find any pending tasks, deadlines, or reminders.
2. Review today's memory log (memory_get on today's file) for unfinished items.
3. If the user mentioned a deadline or reminder in recent conversation, check if it is approaching.
4. If you find something actionable, report it concisely.

If nothing needs attention, respond with exactly: HEARTBEAT_OK
"""
    for agent in agents.values():
        path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
        if not path.exists():
            path.write_text(sample_heartbeat, encoding="utf-8")
            print_info(f"Created sample HEARTBEAT.md at {path}")


# ============================================================================
# Part 7: HeartbeatGateway — 继承 SoulMemoryGateway, 增加心跳 RPC
# ============================================================================
#
# 在 s06 的 SoulMemoryGateway 基础上增加:
#   - 每个 agent 启动一个 HeartbeatRunner 后台线程
#   - 新增 RPC: heartbeat.status / heartbeat.trigger
#   - 心跳事件通过 WebSocket 广播给所有客户端
#
# 信息流 (Gateway 模式):
#   HeartbeatRunner (后台)
#       │
#       ├─ 产生心跳消息 → broadcast("heartbeat", payload)
#       │                  → 所有连接的 WebSocket 客户端收到
#       │
#       ├─ 共享 session → 心跳和 WebSocket chat.send 使用同一 session
#       │                → 心跳知道通过 Gateway 的对话内容
#       │
#       └─ 共享 memory → 心跳和用户对话读写同一份记忆
# ============================================================================

class HeartbeatGateway(SoulMemoryGateway):
    """带心跳的 WebSocket 网关 — 继承 s06 SoulMemoryGateway 的全部功能.

    新增:
      - 每个 Agent 一个 HeartbeatRunner 后台线程
      - heartbeat.status RPC: 查询心跳状态
      - heartbeat.trigger RPC: 手动触发心跳
      - 心跳事件广播: 所有客户端收到心跳通知
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
    ) -> None:
        super().__init__(host, port, router, sessions, soul_agents, token)

        self.heartbeat_interval = heartbeat_interval
        self.active_start = active_start
        self.active_end = active_end

        # 为每个 agent 创建 HeartbeatRunner
        self._heartbeat_runners: dict[str, HeartbeatRunner] = {}
        for agent_id, agent in soul_agents.items():
            session_key = f"gateway:{agent_id}:heartbeat"
            runner = HeartbeatRunner(
                agent=agent,
                session_store=sessions,
                session_key=session_key,
                interval_seconds=heartbeat_interval,
                active_start=active_start,
                active_end=active_end,
            )
            # 注册事件回调: 心跳事件 → 广播给所有客户端
            runner.on_event.append(
                lambda payload, aid=agent_id: self._broadcast_heartbeat(aid, payload)
            )
            self._heartbeat_runners[agent_id] = runner

        # 注册新 RPC 方法
        self._methods["heartbeat.status"] = self._handle_heartbeat_status
        self._methods["heartbeat.trigger"] = self._handle_heartbeat_trigger

    def _broadcast_heartbeat(self, agent_id: str, payload: dict) -> None:
        """广播心跳事件给所有连接的客户端.

        【参考】OpenClaw server.impl.ts  broadcast("heartbeat", evt, {dropIfSlow: true})
        """
        payload["agentId"] = agent_id
        event_str = make_event("heartbeat", payload)
        for client in list(self.clients.values()):
            try:
                asyncio.get_event_loop().call_soon_threadsafe(
                    asyncio.ensure_future,
                    client.ws.send(event_str),
                )
            except Exception:
                pass  # dropIfSlow: 发送失败就跳过

    async def _handle_heartbeat_status(self, client: ConnectedClient, params: dict) -> dict:
        """heartbeat.status — 查询指定 agent 的心跳状态."""
        agent_id = params.get("agent_id", self.router.default_agent)
        runner = self._heartbeat_runners.get(agent_id)
        if runner is None:
            return {"error": f"No heartbeat runner for agent: {agent_id}"}

        should, reason = runner.should_run()
        elapsed = time.time() - runner.last_run if runner.last_run > 0 else 0
        next_in = max(0, runner.interval - elapsed)

        return {
            "agent_id": agent_id,
            "enabled": runner._is_enabled(),
            "interval_seconds": runner.interval,
            "active_hours": f"{runner.active_start}-{runner.active_end}",
            "is_active_hours": runner._is_active_hours(),
            "has_heartbeat_file": runner.heartbeat_path.exists(),
            "has_content": runner._heartbeat_has_content(),
            "running": runner.running,
            "last_run_seconds_ago": round(elapsed, 1) if runner.last_run > 0 else None,
            "next_in_seconds": round(next_in, 1),
            "should_run": should,
            "should_run_reason": reason,
            "total_runs": runner.total_runs,
            "total_alerts": runner.total_alerts,
            "last_sent_preview": runner.last_heartbeat_text[:200] if runner.last_heartbeat_text else None,
        }

    async def _handle_heartbeat_trigger(self, client: ConnectedClient, params: dict) -> dict:
        """heartbeat.trigger — 手动触发一次心跳 (跳过 interval 检查)."""
        agent_id = params.get("agent_id", self.router.default_agent)
        runner = self._heartbeat_runners.get(agent_id)
        if runner is None:
            return {"error": f"No heartbeat runner for agent: {agent_id}"}

        # 在线程池中执行 (避免阻塞事件循环)
        result = await asyncio.to_thread(runner.run_heartbeat_once)
        runner.last_run = time.time()
        return result

    async def start(self) -> None:
        """启动网关 + 所有心跳线程."""
        # 启动所有心跳 runner
        for agent_id, runner in self._heartbeat_runners.items():
            runner.start()
            log.info("heartbeat runner started for agent=%s", agent_id)

        try:
            await super().start()
        finally:
            # 停止所有心跳
            for runner in self._heartbeat_runners.values():
                runner.stop()


# ============================================================================
# Part 8: run_repl_with_heartbeat — 扩展 s06 REPL, 加入心跳后台循环
# ============================================================================
#
# 在 s06 run_repl 的基础上增加:
#   - 后台 HeartbeatRunner 线程
#   - /heartbeat 命令: 查看心跳状态
#   - /trigger 命令: 手动触发心跳
#   - 每次等待输入前, 检查并输出心跳消息
#   - 互斥锁: 用户消息和心跳不并发
#
# 信息流 (REPL 模式):
#
#   ┌─────────────────────────────────────────────────────────┐
#   │                    共享资源                              │
#   │  ┌─────────┐  ┌───────────┐  ┌──────────────────────┐  │
#   │  │ Session  │  │  Memory   │  │  Agent workspace     │  │
#   │  │ (对话    │  │ (MEMORY   │  │  ├─ SOUL.md         │  │
#   │  │  历史)   │  │  .md +    │  │  ├─ MEMORY.md       │  │
#   │  │         │  │  daily/)  │  │  ├─ HEARTBEAT.md    │  │
#   │  └────┬────┘  └─────┬─────┘  │  └─ memory/         │  │
#   │       │             │         └──────────────────────┘  │
#   │       │             │                                    │
#   │  ┌────┴─────────────┴────┐    ┌──────────────────────┐  │
#   │  │   用户消息处理         │    │  HeartbeatRunner     │  │
#   │  │   (主线程)            │    │  (后台线程)          │  │
#   │  │                       │    │                      │  │
#   │  │  input() → LLM call  │◄──►│  tick → LLM call    │  │
#   │  │  (soul+memory+tools)  │    │  (soul+memory+tools) │  │
#   │  │                       │    │                      │  │
#   │  │  互斥锁 ◄─────────────┼────► 互斥锁              │  │
#   │  │                       │    │                      │  │
#   │  │  → print_assistant()  │    │  → output queue     │  │
#   │  └───────────────────────┘    │  → drain → print    │  │
#   │                                └──────────────────────┘  │
#   └─────────────────────────────────────────────────────────┘
# ============================================================================

def run_repl_with_heartbeat(
    router: MessageRouter,
    soul_agents: dict[str, AgentWithSoulMemory],
    session_store: S04SessionStore,
    heartbeat_interval: int = DEMO_HEARTBEAT_INTERVAL,
    active_start: str = HEARTBEAT_ACTIVE_START,
    active_end: str = HEARTBEAT_ACTIVE_END,
) -> None:
    """交互式 REPL: s06 全部功能 + 心跳后台循环.

    包含 s06 run_repl 的所有命令 (/soul, /memory, /agents, /switch,
    /bindings, /route) 并新增心跳命令 (/heartbeat, /trigger).
    """
    default_agent_id = router.default_agent
    current_agent = soul_agents.get(default_agent_id)
    if current_agent is None:
        current_agent = next(iter(soul_agents.values()))
    session_key = f"repl:{current_agent.id}:local"

    # 创建心跳 runner — 与用户对话共享 session!
    heartbeat = HeartbeatRunner(
        agent=current_agent,
        session_store=session_store,
        session_key=session_key,
        interval_seconds=heartbeat_interval,
        active_start=active_start,
        active_end=active_end,
    )

    print_info("=" * 70)
    print_info(f"  Mini-Claw REPL  |  Section 07: Heartbeat & Proactive Behavior")
    print_info(f"  Agent: {current_agent.id}")
    print_info(f"  Model: {current_agent.model}")
    print_info(f"  Workspace: {current_agent.workspace_dir}")
    print_info(f"  Heartbeat: every {heartbeat_interval}s "
               f"(active {active_start}-{active_end})")
    print_info("")
    print_info("  Commands (s06 inherited):")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current agent's soul")
    print_info("    /memory            - View memory status")
    print_info("    /route <ch> <sender> [kind] [guild]  - Test routing")
    print_info("    /switch <agent_id> - Switch to a different agent")
    print_info("    /agents            - List all agents")
    print_info("    /bindings          - List all routing bindings")
    print_info("  Commands (s07 new):")
    print_info("    /heartbeat         - View heartbeat status")
    print_info("    /trigger           - Manually trigger a heartbeat")
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
        print_info("HEARTBEAT.md not found or empty (heartbeat will skip LLM calls)")
    print()

    # 启动心跳后台循环
    heartbeat.start()
    print_info(f"Heartbeat started (interval={heartbeat_interval}s)")
    print()

    try:
        while True:
            # ── 心跳输出: 在等待输入前, 显示心跳产生的消息 ──
            for result in heartbeat.drain_output():
                if result["status"] == HEARTBEAT_STATUS_SENT and result["text"]:
                    print_heartbeat(result["text"])
                elif result["status"] == HEARTBEAT_STATUS_FAILED and result.get("reason"):
                    print(f"  {RED}[heartbeat error] {result['reason']}{RESET}")

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

            # ── s06 继承的命令 ──

            if user_input == "/soul":
                sp = current_agent.soul_path
                if sp.exists():
                    print(f"\n{MAGENTA}--- {current_agent.id.upper()} SOUL ---{RESET}")
                    print(sp.read_text(encoding="utf-8").strip())
                    print(f"{MAGENTA}--- end ---{RESET}\n")
                else:
                    print_info(f"No soul file at {sp}\n")
                continue

            if user_input == "/memory":
                mgr = get_memory_manager(current_agent)
                evergreen = mgr.load_evergreen()
                recent = mgr.get_recent_daily(days=7)
                print(f"\n{MAGENTA}--- Memory Status ({current_agent.id}) ---{RESET}")
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
                    has_hb = "hb" if (a.workspace_dir / DEFAULT_HEARTBEAT_FILENAME).exists() else "  "
                    print(f"  {aid:<12} model={a.model:<16} [{has_soul}|{has_hb}]"
                          f" workspace={a.workspace_dir}{marker}")
                continue

            if user_input.startswith("/route "):
                parts = user_input[7:].split()
                if len(parts) < 2:
                    print("  Usage: /route <channel> <sender> [kind] [guild_id]")
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
                    # 停止旧心跳, 切换, 启动新心跳
                    heartbeat.stop()
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
                    print_info(f"Switched to agent: {current_agent.id}")
                    print_info(f"Workspace: {current_agent.workspace_dir}")
                    print_info(f"Heartbeat restarted for {current_agent.id}")
                else:
                    print(f"  Unknown agent: {new_id}."
                          f" Available: {', '.join(soul_agents.keys())}")
                continue

            # ── s07 新增的命令 ──

            if user_input == "/heartbeat":
                should, reason = heartbeat.should_run()
                elapsed = time.time() - heartbeat.last_run if heartbeat.last_run > 0 else 0
                next_in = max(0, heartbeat.interval - elapsed)
                hb_exists = heartbeat.heartbeat_path.exists()
                hb_has_content = heartbeat._heartbeat_has_content()
                active = heartbeat._is_active_hours()
                print(f"\n{BLUE}--- Heartbeat Status ---{RESET}")
                print(f"  Enabled:        {heartbeat._is_enabled()}")
                print(f"  HEARTBEAT.md:   {'exists' if hb_exists else 'not found'}"
                      f" ({'has content' if hb_has_content else 'empty'})")
                print(f"  Active hours:   {heartbeat.active_start}-{heartbeat.active_end}"
                      f" ({'active' if active else 'quiet'})")
                print(f"  Interval:       {heartbeat.interval}s")
                print(f"  Last run:       {elapsed:.0f}s ago" if heartbeat.last_run > 0 else
                      "  Last run:       never")
                print(f"  Next in:        ~{next_in:.0f}s")
                print(f"  Should run:     {should} ({reason})")
                print(f"  Running:        {heartbeat.running}")
                print(f"  Total runs:     {heartbeat.total_runs}")
                print(f"  Total alerts:   {heartbeat.total_alerts}")
                print(f"  ackMaxChars:    {heartbeat.ack_max_chars}")
                if heartbeat.last_heartbeat_text:
                    print(f"  Last sent:      {heartbeat.last_heartbeat_text[:100]!r}")
                print(f"  Session:        {heartbeat.session_key}")
                print(f"                  (shared with user conversation!)")
                print(f"{BLUE}--- end ---{RESET}\n")
                continue

            if user_input == "/trigger":
                print_info("Manually triggering heartbeat...")
                result = heartbeat.run_heartbeat_once()
                if result["status"] == HEARTBEAT_STATUS_SENT and result["text"]:
                    print_heartbeat(result["text"])
                elif result["status"] == HEARTBEAT_STATUS_OK_TOKEN:
                    print_info("Heartbeat returned HEARTBEAT_OK (nothing to report).\n")
                elif result["status"] == HEARTBEAT_STATUS_OK_EMPTY:
                    print_info("Heartbeat returned empty response.\n")
                elif result["status"] == HEARTBEAT_STATUS_SKIPPED:
                    print_info(f"Heartbeat skipped: {result.get('reason', '?')}\n")
                elif result["status"] == HEARTBEAT_STATUS_FAILED:
                    print(f"  {RED}Heartbeat failed: {result.get('reason', '?')}{RESET}\n")
                heartbeat.last_run = time.time()
                continue

            # ── 普通对话: 获取互斥锁, 调用 Agent (s06 run_agent_with_soul_and_memory) ──
            # 互斥锁保证: 用户消息处理期间, 心跳不会并发运行
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
        heartbeat.stop()
        print_info("Heartbeat stopped.")


# ============================================================================
# Part 9: Main 程序入口 — s06 全部模式 + 心跳
# ============================================================================

def main() -> None:
    """程序入口: 兼容 s06 所有运行模式, 且增加心跳支持.

    运行方式:
      python s07_heartbeat.py              # 启动带心跳的网关 (默认)
      python s07_heartbeat.py --test-client # 运行测试客户端 (s06 功能)
      python s07_heartbeat.py --chat       # 交互式对话 (s06 功能)
      python s07_heartbeat.py --repl       # REPL + 心跳后台循环

    心跳参数:
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

    # 解析心跳参数
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
        # 测试客户端 — 直接复用 s06 (网关需要单独启动, 可用本文件默认模式)
        asyncio.run(s06_test_client())

    elif "--chat" in sys.argv:
        # 交互式对话 — 直接复用 s06
        asyncio.run(s06_interactive_chat())

    elif "--repl" in sys.argv:
        # REPL + 心跳 — s07 的核心模式
        session_store = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        run_repl_with_heartbeat(
            router,
            soul_agents,
            session_store,
            heartbeat_interval=heartbeat_interval,
            active_start=active_start,
            active_end=active_end,
        )

    else:
        # 默认: 启动带心跳的网关
        print("=" * 60)
        print("  OpenClaw Gateway — Heartbeat Edition")
        print("  (s07: s06 Soul+Memory Gateway + Heartbeat)")
        print("=" * 60)
        print(f"  Host:        {GATEWAY_HOST}")
        print(f"  Port:        {GATEWAY_PORT}")
        print(f"  Agents:      {', '.join(soul_agents.keys())}")
        print(f"  Bindings:    {len(bindings)} rules")
        print(f"  DM Scope:    {dm_scope}")
        print(f"  Heartbeat:   every {heartbeat_interval}s"
              f" (active {active_start}-{active_end})")
        print()
        print("  New RPC methods (s07):")
        print("    heartbeat.status   - Query heartbeat status for an agent")
        print("    heartbeat.trigger  - Manually trigger a heartbeat")
        print()
        print("  All s06 RPC methods also available:")
        print("    health, chat.send, chat.history, routing.resolve,")
        print("    routing.bindings, sessions.list, identify,")
        print("    memory.status, soul.get")
        print("=" * 60)

        sessions = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        gateway = HeartbeatGateway(
            host=GATEWAY_HOST,
            port=GATEWAY_PORT,
            router=router,
            sessions=sessions,
            soul_agents=soul_agents,
            token=GATEWAY_TOKEN,
            heartbeat_interval=heartbeat_interval,
            active_start=active_start,
            active_end=active_end,
        )
        asyncio.run(gateway.start())


if __name__ == "__main__":
    main()
