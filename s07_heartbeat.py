"""
Section 07: Heartbeat & Proactive Behavior
"Not just reactive — proactive"

本文件在 s06_soul_memory 的 Soul+Memory 框架之上, 加入 OpenClaw 最独特的特性:
心跳系统 (Heartbeat), 让 agent 在没有用户消息时也能主动行动.

传统 chatbot 只能被动回复; OpenClaw 的 agent 像一个真正的助手,
会定期 "检查一下" 是否有需要汇报的事情.

【与 s06 的关系】
  s05_gateway.py    → 多 Agent 路由 + WebSocket 网关
  s06_soul_memory.py → Soul (人格) + Memory (记忆)
  s07_heartbeat.py   → Heartbeat (心跳) — 本文件

【参考】OpenClaw 源码
  - src/infra/heartbeat-runner.ts      HeartbeatRunner + runHeartbeatOnce
  - src/auto-reply/heartbeat.ts        HEARTBEAT_PROMPT + stripHeartbeatToken
  - src/infra/heartbeat-active-hours.ts isWithinActiveHours
  - src/infra/heartbeat-events.ts      事件发射 + 指示器类型
  - src/infra/heartbeat-wake.ts        唤醒 + 调度
  - src/infra/heartbeat-visibility.ts  可见性 (showOk / showAlerts)
  - src/auto-reply/tokens.ts           HEARTBEAT_TOKEN = "HEARTBEAT_OK"

在 OpenClaw 中:
  - HeartbeatRunner: 后台定时器, 周期性触发 agent 执行
  - HEARTBEAT.md: 定义心跳时要检查的内容 (workspace bootstrap file)
  - Active Hours: 只在配置的时间窗口内运行 (不在凌晨打扰用户)
  - HEARTBEAT_OK: agent 认为没事可报时的静默信号, 不发送给用户
  - 互斥锁: 心跳让位于用户消息 (主通道优先)
  - 去重: 24 小时内不发送重复内容 (session 级 lastHeartbeatText)
  - ackMaxChars: HEARTBEAT_OK 附带少量文字 (≤300 chars) 也视为静默

OpenClaw 的 6 步检查链 (runHeartbeatOnce):
  [1] heartbeat 是否启用? (agent 配置 + 间隔有效)
  [2] 是否在活跃时段? (activeHours 配置)
  [3] 主通道是否空闲? (CommandLane.Main 队列深度 = 0)
  [4] HEARTBEAT.md 是否存在且有实质内容? (跳过纯 heading/空 checkbox)
  [5] 解析心跳 session (复用 agent 的主 session)
  [6] 调用 agent, 处理响应 (strip token → dedup → deliver)

HEARTBEAT.md 示例 (放在 workspace/{agent_id}/ 下):

    # Heartbeat Instructions

    Check the following and report ONLY if action is needed:

    1. Are there any pending reminders for the user?
    2. Review today's memory log for unfinished tasks.
    3. If the user mentioned a deadline, check if it's approaching.

    If nothing needs attention, respond with exactly: HEARTBEAT_OK

架构图:

  +--- HeartbeatRunner (background thread) ------+
  |  schedule:                                    |
  |  [1] enabled? (interval > 0)                 |
  |  [2] active hours? --------+                 |
  |  [3] main lane idle?       |                 |
  |  [4] HEARTBEAT.md content? |                 |
  +----+-----------------------+-----------------+
       |                       |
       v                (mutual exclusion)
    runHeartbeatOnce()         |
       |                       v
       v                  User Message
    Agent LLM call         (takes priority)
       |
       v
    Response handling
    /              \\
  HEARTBEAT_OK     Content
  (suppress)        |
                    v
               Dedup check (24h)
                    |
                    v
               Output to user

运行方式:
    python s07_heartbeat.py --repl

依赖:
    pip install python-dotenv websockets
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
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

# 从 s06 导入 Soul+Memory 框架 (本文件是 s06 的递进)
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

# 从 s05 导入路由基础设施
from s05_gateway import (
    MessageRouter,
    Binding,
)

# 从 s04 导入 session 管理
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

# LLM 配置
MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat")

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
# 【参考】OpenClaw src/auto-reply/heartbeat.ts
#   - HEARTBEAT_TOKEN = "HEARTBEAT_OK"
#   - stripHeartbeatToken(): 从响应中移除 token
#   - ackMaxChars: token 附带少量文字也视为静默
#
# 【参考】OpenClaw src/auto-reply/tokens.ts
#   export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
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
# 生产版默认心跳 prompt (与原始 OpenClaw 一致)
HEARTBEAT_PROMPT = (
    "Read HEARTBEAT.md if it exists (workspace context). "
    "Follow it strictly. Do not infer or repeat old tasks from prior chats. "
    "If nothing needs attention, reply HEARTBEAT_OK."
)

# HEARTBEAT.md 默认文件名
DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md"


def strip_heartbeat_token(
    text: str | None,
    *,
    ack_max_chars: int = DEFAULT_ACK_MAX_CHARS,
) -> dict:
    """从 agent 响应中剥离 HEARTBEAT_OK 标记.

    【参考】OpenClaw src/auto-reply/heartbeat.ts  stripHeartbeatToken()

    逻辑:
      1. 如果文本为空 → should_skip=True
      2. 移除 HTML/Markdown 包裹 (如 <b>HEARTBEAT_OK</b>, **HEARTBEAT_OK**)
      3. 从文本前后移除 HEARTBEAT_OK token (支持连续移除)
      4. 移除后剩余文本为空 → should_skip=True
      5. 剩余文本 ≤ ackMaxChars → should_skip=True (少量注释也视为静默)
      6. 否则返回去掉 token 后的实质内容

    返回:
      {"should_skip": bool, "text": str, "did_strip": bool}
    """
    if not text:
        return {"should_skip": True, "text": "", "did_strip": False}

    trimmed = text.strip()
    if not trimmed:
        return {"should_skip": True, "text": "", "did_strip": False}

    # 移除 HTML/Markdown 包裹
    # 【参考】OpenClaw heartbeat.ts  stripMarkup()
    def strip_markup(s: str) -> str:
        s = re.sub(r"<[^>]*>", " ", s)         # HTML tags
        s = re.sub(r"&nbsp;", " ", s, flags=re.IGNORECASE)
        s = re.sub(r"^[*`~_]+", "", s)          # Markdown 前缀
        s = re.sub(r"[*`~_]+$", "", s)          # Markdown 后缀
        return s

    normalized = strip_markup(trimmed)
    has_token = HEARTBEAT_OK_TOKEN in trimmed or HEARTBEAT_OK_TOKEN in normalized

    if not has_token:
        return {"should_skip": False, "text": trimmed, "did_strip": False}

    # 从前后反复剥离 token
    # 【参考】OpenClaw heartbeat.ts  stripTokenAtEdges()
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
            # 尾部: token + 最多 4 个非单词字符
            pattern = re.escape(HEARTBEAT_OK_TOKEN) + r"[^\w]{0,4}$"
            m = re.search(pattern, s)
            if m:
                before = s[:m.start()].rstrip()
                did_strip = True
                changed = True
                s = before
        collapsed = re.sub(r"\s+", " ", s).strip()
        return collapsed, did_strip

    stripped_orig, did_orig = strip_edges(trimmed)
    stripped_norm, did_norm = strip_edges(normalized)

    # 优先使用原始文本的剥离结果 (保留格式)
    if did_orig and stripped_orig:
        rest = stripped_orig
    elif did_norm:
        rest = stripped_norm
    else:
        return {"should_skip": False, "text": trimmed, "did_strip": False}

    did_strip = did_orig or did_norm

    if not rest:
        return {"should_skip": True, "text": "", "did_strip": did_strip}

    # ackMaxChars: 少量附带文字也视为静默
    # 【参考】OpenClaw heartbeat.ts  mode === "heartbeat" && rest.length <= maxAckChars
    if len(rest) <= ack_max_chars:
        return {"should_skip": True, "text": "", "did_strip": did_strip}

    return {"should_skip": False, "text": rest, "did_strip": did_strip}


# ============================================================================
# Part 2: HEARTBEAT.md 内容检查
# ============================================================================
#
# 【参考】OpenClaw src/auto-reply/heartbeat.ts  isHeartbeatContentEffectivelyEmpty()
#
# 判断 HEARTBEAT.md 是否"实质为空":
#   - 纯空行 → 空
#   - 纯 heading (# xxx) → 空 (ATX heading 要求 # 后有空格)
#   - 空 checkbox (- [ ]) → 空
#   - 有任何其他内容 → 非空
# ============================================================================

def is_heartbeat_content_effectively_empty(content: str | None) -> bool:
    """检查 HEARTBEAT.md 内容是否实质为空.

    【参考】OpenClaw src/auto-reply/heartbeat.ts  isHeartbeatContentEffectivelyEmpty()

    文件不存在时返回 False (让 LLM 自行决定), 只在文件存在但无内容时返回 True.
    """
    if content is None:
        return False
    if not isinstance(content, str):
        return False

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        # 跳过 markdown heading (# 后面必须有空格或 EOL, 与原始 OpenClaw 一致)
        if re.match(r"^#+(\s|$)", stripped):
            continue
        # 跳过空 checkbox  - [ ]  * [ ]  + [ ]  或纯 list marker  -
        if re.match(r"^[-*+]\s*(\[[\sXx]?\]\s*)?$", stripped):
            continue
        # 有实质内容
        return False

    return True


def load_heartbeat_file(workspace_dir: Path) -> str | None:
    """加载 HEARTBEAT.md 文件内容.

    返回文件内容字符串, 文件不存在时返回 None.
    """
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
#
# 支持:
#   - "HH:MM" 格式 (24 小时制)
#   - 跨午夜时段 (如 22:00 - 06:00)
#   - end 支持 "24:00" 表示午夜
# ============================================================================

def parse_active_hours_time(raw: str, *, allow_24: bool = False) -> int | None:
    """解析 "HH:MM" 格式的时间, 返回分钟数 (0-1440).

    【参考】OpenClaw heartbeat-active-hours.ts  parseActiveHoursTime()
    """
    m = re.match(r"^([01]\d|2[0-3]|24):([0-5]\d)$", raw.strip())
    if not m:
        # 也支持纯小时数 (兼容旧格式)
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
    """检查当前时间是否在活跃时段内.

    【参考】OpenClaw src/infra/heartbeat-active-hours.ts  isWithinActiveHours()

    支持跨午夜时段: 如 22:00 - 06:00 表示晚 10 点到早 6 点.
    """
    start_min = parse_active_hours_time(active_start, allow_24=False)
    end_min = parse_active_hours_time(active_end, allow_24=True)

    if start_min is None or end_min is None:
        # 解析失败, 默认允许运行
        return True
    if start_min == end_min:
        # 起止相同 = 全天允许
        return True

    if now is None:
        now = datetime.now()
    current_min = now.hour * 60 + now.minute

    if end_min > start_min:
        # 不跨午夜: 09:00 - 22:00
        return start_min <= current_min < end_min
    else:
        # 跨午夜: 22:00 - 06:00
        return current_min >= start_min or current_min < end_min


# ============================================================================
# Part 4: Heartbeat Event — 心跳事件 (简化版)
# ============================================================================
#
# 【参考】OpenClaw src/infra/heartbeat-events.ts
#   - HeartbeatEventPayload: status, to, preview, durationMs, reason, channel
#   - emitHeartbeatEvent(): 发射事件到 listener
#   - resolveIndicatorType(): ok / alert / error
# ============================================================================

# 心跳事件状态, 与 OpenClaw 一致
HEARTBEAT_STATUS_SENT = "sent"           # 有内容, 已发送
HEARTBEAT_STATUS_OK_EMPTY = "ok-empty"   # LLM 返回空 → 静默
HEARTBEAT_STATUS_OK_TOKEN = "ok-token"   # LLM 返回 HEARTBEAT_OK → 静默
HEARTBEAT_STATUS_SKIPPED = "skipped"     # 被检查链跳过
HEARTBEAT_STATUS_FAILED = "failed"       # 出错


def emit_heartbeat_event(
    status: str,
    *,
    reason: str | None = None,
    preview: str | None = None,
    duration_ms: int | None = None,
) -> None:
    """发射心跳事件 (教学简化版: 打印日志).

    【参考】OpenClaw src/infra/heartbeat-events.ts  emitHeartbeatEvent()

    生产版 OpenClaw 通过事件总线通知 UI 指示器;
    教学版仅记录日志, 方便调试.
    """
    parts = [f"status={status}"]
    if reason:
        parts.append(f"reason={reason}")
    if preview:
        parts.append(f"preview={preview[:80]!r}")
    if duration_ms is not None:
        parts.append(f"duration={duration_ms}ms")

    log.info("heartbeat-event: %s", ", ".join(parts))


# ============================================================================
# Part 5: HeartbeatRunner — 心跳引擎
# ============================================================================
#
# 【参考】OpenClaw src/infra/heartbeat-runner.ts
#   - startHeartbeatRunner(): 创建后台调度器
#   - runHeartbeatOnce(): 单次心跳执行
#   - resolveHeartbeatSession(): 解析心跳使用的 session
#   - normalizeHeartbeatReply(): 处理响应
#
# 核心流程:
#   1. 后台线程每秒检查 should_run()
#   2. 满足条件时获取互斥锁
#   3. 调用 LLM (带 HEARTBEAT.md 上下文)
#   4. 处理响应: strip token → dedup → 输出
#   5. 记录 lastHeartbeatText 用于去重
# ============================================================================

class HeartbeatRunner:
    """心跳运行器: 让 agent 定期检查并主动汇报.

    【参考】OpenClaw src/infra/heartbeat-runner.ts

    核心概念:
      - interval: 检查间隔 (秒)
      - active_hours: 活跃时段 (HH:MM 格式, 支持跨午夜)
      - heartbeat_path: HEARTBEAT.md 路径, 定义检查内容
      - main_lane_lock: 与用户消息互斥的锁
      - last_heartbeat_text: 上一次发送的心跳文本 (用于 24h 去重)
      - ack_max_chars: HEARTBEAT_OK 附带文本视为静默的字符阈值

    6 步检查链:
      [1] heartbeat 是否启用? (interval > 0 且 HEARTBEAT.md 路径有效)
      [2] 间隔是否已过?
      [3] 是否在活跃时段?
      [4] HEARTBEAT.md 是否存在且有实质内容?
      [5] 主通道是否空闲? (互斥锁)
      [6] agent 是否空闲? (不在运行中)
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

        # HEARTBEAT.md 路径
        self.heartbeat_path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME

        # 运行时状态
        self.last_run: float = 0.0
        self.running = False

        # 去重: 记录上次发送的心跳文本和时间
        # 【参考】OpenClaw heartbeat-runner.ts  entry.lastHeartbeatText / lastHeartbeatSentAt
        self.last_heartbeat_text: str = ""
        self.last_heartbeat_sent_at: float = 0.0

        # 互斥锁: 心跳和用户消息共享
        # 【参考】OpenClaw 通过 CommandLane 队列深度判断; 教学版用 threading.Lock
        self._lock = threading.Lock()

        # 后台线程控制
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # 心跳产生的消息队列, 由主线程消费
        self._output_queue: list[str] = []
        self._output_lock = threading.Lock()

    # -- 6 步检查链 --

    def _is_enabled(self) -> bool:
        """[1] heartbeat 是否启用?

        【参考】OpenClaw heartbeat-runner.ts  isHeartbeatEnabledForAgent()

        检查: interval > 0 且心跳路径有效.
        """
        return self.interval > 0

    def _interval_elapsed(self) -> bool:
        """[2] 距离上次运行是否已过足够时间?

        【参考】OpenClaw heartbeat-runner.ts  agent.nextDueMs <= now
        """
        return (time.time() - self.last_run) >= self.interval

    def _is_active_hours(self) -> bool:
        """[3] 当前是否在活跃时段?

        【参考】OpenClaw src/infra/heartbeat-active-hours.ts  isWithinActiveHours()

        支持跨午夜时段和 HH:MM 格式.
        """
        return is_within_active_hours(self.active_start, self.active_end)

    def _heartbeat_has_content(self) -> bool:
        """[4] HEARTBEAT.md 是否存在且有实质内容?

        【参考】OpenClaw src/auto-reply/heartbeat.ts  isHeartbeatContentEffectivelyEmpty()

        跳过: 纯空行, 纯 heading (# xxx), 空 checkbox (- [ ]).
        """
        content = load_heartbeat_file(self.agent.workspace_dir)
        if content is None:
            return False
        return not is_heartbeat_content_effectively_empty(content)

    def _main_lane_idle(self) -> bool:
        """[5] 主通道是否空闲?

        【参考】OpenClaw heartbeat-runner.ts  getQueueSize(CommandLane.Main) > 0

        教学版: 尝试非阻塞获取锁, 成功说明没有用户消息在处理.
        """
        acquired = self._lock.acquire(blocking=False)
        if acquired:
            self._lock.release()
            return True
        return False

    def should_run(self) -> tuple[bool, str]:
        """6 步检查链, 返回 (是否运行, 原因).

        【参考】OpenClaw heartbeat-runner.ts  runHeartbeatOnce() 的检查顺序

        每一步失败都返回 skipped + 具体原因, 与 OpenClaw 的 HeartbeatRunResult 对齐.
        """
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

    # -- 心跳执行 --

    def run_heartbeat_once(self) -> dict:
        """执行一次心跳, 返回结果.

        【参考】OpenClaw heartbeat-runner.ts  runHeartbeatOnce()

        流程:
          1. 构建心跳 system prompt (复用 s06 的 build_agent_system_prompt)
          2. 注入 HEARTBEAT.md 作为额外上下文
          3. 调用 LLM (单轮, 带工具支持)
          4. 处理响应:
             - strip HEARTBEAT_OK token
             - 去重检查 (24h 内相同内容不重发)
          5. 返回 {status, text, duration_ms}

        返回:
          {"status": "sent"|"ok-empty"|"ok-token"|"skipped"|"failed",
           "text": str, "duration_ms": int, "reason": str|None}
        """
        started_at = time.time()

        try:
            # 构建心跳 prompt
            # 【参考】OpenClaw heartbeat-runner.ts
            #   ctx.Body = appendCronStyleCurrentTimeLine(prompt, cfg, startedAt)
            #   ctx.Provider = "heartbeat"
            heartbeat_content = load_heartbeat_file(self.agent.workspace_dir)
            heartbeat_prompt = HEARTBEAT_PROMPT
            if heartbeat_content:
                heartbeat_prompt += (
                    f"\n\n--- HEARTBEAT.md ---\n{heartbeat_content.strip()}\n--- end ---"
                )

            # 构建 system prompt (复用 s06 的构建逻辑)
            system_prompt = build_agent_system_prompt(self.agent, S04_SYSTEM_PROMPT)

            # 准备 messages (使用心跳 session 的历史)
            session_data = self.session_store.load_session(self.session_key)
            messages = session_data["history"]
            messages.append({"role": "user", "content": heartbeat_prompt})

            # 组合工具: s04 工具 + memory 工具
            all_tools = TOOLS_OPENAI + build_memory_tools()

            # 调用 LLM (单轮, 不做工具循环 — 心跳场景简化)
            # 【参考】OpenClaw getReplyFromConfig(ctx, {isHeartbeat: true})
            resp = deepseek_chat_with_tools(
                messages,
                all_tools,
                model=self.agent.model,
                system_prompt=system_prompt,
                max_tokens=1024,
            )

            response_text = resp.get("content") or ""
            tool_calls = resp.get("tool_calls") or []

            # 处理工具调用 (心跳中也可能调用 memory_search)
            if tool_calls:
                assistant_msg: dict = {"role": "assistant", "content": response_text}
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

                    if tc["name"] in MEMORY_TOOL_NAMES:
                        result = handle_memory_tool(tc["name"], args, self.agent)
                    else:
                        result = process_tool_call(tc["name"], args)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })

                # 二次调用获取最终文本
                resp2 = deepseek_chat_with_tools(
                    messages,
                    all_tools,
                    model=self.agent.model,
                    system_prompt=system_prompt,
                    max_tokens=1024,
                )
                response_text = resp2.get("content") or ""

            duration_ms = int((time.time() - started_at) * 1000)

            if not response_text.strip():
                emit_heartbeat_event(
                    HEARTBEAT_STATUS_OK_EMPTY,
                    duration_ms=duration_ms,
                )
                return {"status": HEARTBEAT_STATUS_OK_EMPTY, "text": "",
                        "duration_ms": duration_ms, "reason": None}

            # Strip HEARTBEAT_OK token
            # 【参考】OpenClaw heartbeat-runner.ts  normalizeHeartbeatReply()
            stripped = strip_heartbeat_token(
                response_text,
                ack_max_chars=self.ack_max_chars,
            )

            if stripped["should_skip"]:
                emit_heartbeat_event(
                    HEARTBEAT_STATUS_OK_TOKEN,
                    duration_ms=duration_ms,
                )
                return {"status": HEARTBEAT_STATUS_OK_TOKEN, "text": "",
                        "duration_ms": duration_ms, "reason": None}

            final_text = stripped["text"]

            # 去重检查 (24h 内不重发相同内容)
            # 【参考】OpenClaw heartbeat-runner.ts  isDuplicateMain
            #   prevHeartbeatText.trim() === normalized.text.trim()
            #   && startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000
            if (
                self.last_heartbeat_text.strip()
                and final_text.strip() == self.last_heartbeat_text.strip()
                and self.last_heartbeat_sent_at > 0
                and (started_at - self.last_heartbeat_sent_at) < DEDUP_WINDOW_SECONDS
            ):
                emit_heartbeat_event(
                    HEARTBEAT_STATUS_SKIPPED,
                    reason="duplicate",
                    preview=final_text[:200],
                    duration_ms=duration_ms,
                )
                return {"status": HEARTBEAT_STATUS_SKIPPED, "text": "",
                        "duration_ms": duration_ms, "reason": "duplicate"}

            # 记录本次发送的内容 (用于下次去重)
            self.last_heartbeat_text = final_text
            self.last_heartbeat_sent_at = started_at

            emit_heartbeat_event(
                HEARTBEAT_STATUS_SENT,
                preview=final_text[:200],
                duration_ms=duration_ms,
            )
            return {"status": HEARTBEAT_STATUS_SENT, "text": final_text,
                    "duration_ms": duration_ms, "reason": None}

        except Exception as exc:
            duration_ms = int((time.time() - started_at) * 1000)
            reason = str(exc)
            emit_heartbeat_event(
                HEARTBEAT_STATUS_FAILED,
                reason=reason,
                duration_ms=duration_ms,
            )
            log.error("heartbeat failed: %s", reason)
            return {"status": HEARTBEAT_STATUS_FAILED, "text": "",
                    "duration_ms": duration_ms, "reason": reason}

    # -- 后台线程 --

    def _background_loop(self) -> None:
        """后台心跳循环.

        【参考】OpenClaw heartbeat-runner.ts  startHeartbeatRunner() 的调度逻辑

        以 1 秒间隔检查 should_run(), 满足条件时执行心跳.
        这样即使 interval 是 60 秒, 停止信号也能在 1 秒内响应.
        """
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
                    if result["status"] == HEARTBEAT_STATUS_SENT and result["text"]:
                        with self._output_lock:
                            self._output_queue.append(result["text"])
                    elif result["status"] == HEARTBEAT_STATUS_FAILED and result.get("reason"):
                        with self._output_lock:
                            self._output_queue.append(
                                f"[heartbeat error: {result['reason']}]"
                            )
                except Exception as exc:
                    log.error("heartbeat runner error: %s", exc)
                finally:
                    self.running = False
                    self._lock.release()

            self._stop_event.wait(1.0)

    def start(self) -> None:
        """启动后台心跳线程."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._background_loop,
            daemon=True,
            name="heartbeat-runner",
        )
        self._thread.start()

    def stop(self) -> None:
        """停止后台心跳线程.

        【参考】OpenClaw heartbeat-runner.ts  cleanup()
        """
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None

    def drain_output(self) -> list[str]:
        """取出所有待输出的心跳消息. 由主线程调用."""
        with self._output_lock:
            messages = self._output_queue[:]
            self._output_queue.clear()
            return messages


# ============================================================================
# Part 6: HEARTBEAT.md 示例创建
# ============================================================================

def _ensure_sample_heartbeat(agents: dict[str, AgentWithSoulMemory]) -> None:
    """为没有 HEARTBEAT.md 的 Agent 创建示例文件.

    【参考】OpenClaw docs/reference/templates/HEARTBEAT.md
    """
    sample_heartbeat = """\
# Heartbeat Instructions

Check the following and report ONLY if action is needed:

1. Review today's memory log for any unfinished tasks or pending items.
2. If the user mentioned a deadline or reminder, check if it is approaching.
3. If there are new daily memories, summarize any actionable items.

If nothing needs attention, respond with exactly: HEARTBEAT_OK
"""
    for agent in agents.values():
        path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
        if not path.exists():
            path.write_text(sample_heartbeat, encoding="utf-8")
            print_info(f"Created sample HEARTBEAT.md at {path}")


# ============================================================================
# Part 7: REPL — 交互式 REPL (s06 REPL + 心跳扩展)
# ============================================================================
#
# 在 s06 的 run_repl 基础上增加:
#   - 后台心跳线程
#   - /heartbeat 命令: 查看心跳状态
#   - /trigger 命令: 手动触发心跳
#   - 用户输入前检查心跳输出队列
#   - 互斥锁保护用户消息和心跳不并发
# ============================================================================

def run_repl_with_heartbeat(
    router: MessageRouter,
    soul_agents: dict[str, AgentWithSoulMemory],
    session_store: S04SessionStore,
    heartbeat_interval: int = DEMO_HEARTBEAT_INTERVAL,
    active_start: str = HEARTBEAT_ACTIVE_START,
    active_end: str = HEARTBEAT_ACTIVE_END,
) -> None:
    """交互式 REPL: s06 路由 + Soul/Memory + 心跳.

    整合 s06 的 run_repl 和心跳系统:
      1. 后台线程运行 HeartbeatRunner, 周期性触发 agent
      2. 主线程运行交互式 REPL, 处理用户输入
      3. 两者共享互斥锁, 确保不同时运行
      4. 主线程在每次等待用户输入前, 检查并输出心跳消息
    """
    default_agent_id = router.default_agent
    current_agent = soul_agents.get(default_agent_id)
    if current_agent is None:
        current_agent = next(iter(soul_agents.values()))
    session_key = f"repl:{current_agent.id}:local"

    # 创建心跳 runner
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
    print_info("  Commands:")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current agent's soul")
    print_info("    /memory            - View memory status")
    print_info("    /heartbeat         - View heartbeat status")
    print_info("    /trigger           - Manually trigger a heartbeat")
    print_info("    /switch <agent_id> - Switch to a different agent")
    print_info("    /agents            - List all agents")
    print_info("    /bindings          - List all routing bindings")
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
        print_info("HEARTBEAT.md not found or empty (heartbeat disabled)")
    print()

    # 启动心跳
    heartbeat.start()
    print_info(f"Heartbeat started (interval={heartbeat_interval}s)")
    print()

    try:
        while True:
            # 输出心跳消息 (在等待用户输入前)
            for msg in heartbeat.drain_output():
                print_heartbeat(msg)

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

            # -- 内置命令 --

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
                print(f"  ackMaxChars:    {heartbeat.ack_max_chars}")
                if heartbeat.last_heartbeat_text:
                    print(f"  Last sent:      {heartbeat.last_heartbeat_text[:100]!r}")
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

            if user_input.startswith("/switch "):
                new_id = user_input[8:].strip()
                if new_id in soul_agents:
                    # 停止旧心跳, 切换 agent, 启动新心跳
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

            # -- 普通对话: 获取互斥锁, 调用 Agent --
            # 如果心跳正在运行, 等待它完成
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
# Part 8: Main 程序入口
# ============================================================================

def main() -> None:
    """程序入口: 启动带心跳的 REPL.

    运行方式:
      python s07_heartbeat.py --repl     # 交互式 REPL (推荐)
      python s07_heartbeat.py            # 默认也启动 REPL
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

    # 确保 workspace 和 sessions 目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # 加载配置, 创建 Agent (复用 s06 的创建逻辑)
    soul_agents, bindings, default_agent, dm_scope = create_agents_with_soul_memory(config_path)
    if not soul_agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    # 创建示例文件 (Soul + Heartbeat)
    _ensure_sample_soul(soul_agents)
    _ensure_sample_heartbeat(soul_agents)

    # 构建路由器
    router = MessageRouter(soul_agents, bindings, default_agent, dm_scope)

    # 初始化 session store (复用 s06 的方式)
    session_store = S04SessionStore(
        store_path=SESSIONS_DIR / "sessions.json",
        transcript_dir=SESSIONS_DIR / "transcripts",
    )

    # 启动 REPL (带心跳)
    run_repl_with_heartbeat(
        router,
        soul_agents,
        session_store,
        heartbeat_interval=heartbeat_interval,
        active_start=active_start,
        active_end=active_end,
    )


if __name__ == "__main__":
    main()
