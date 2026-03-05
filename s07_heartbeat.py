"""
Section 07 — Heartbeat
"Let the agent pulse on its own"

本文件在 s06_mem (Soul & Memory) 之上, 加入 OpenClaw 的 Heartbeat 机制:

  定时轮询 — 每隔固定间隔 (默认 30m), 主动让 Agent 运行一轮 LLM 对话,
  检查 HEARTBEAT.md (可选清单), 只在有实质内容时才输出, 否则静默应答 HEARTBEAT_OK.

  ── 核心概念 ──────────────────────────────────────
  1. HEARTBEAT.md
     - 可选文件, 放在 Agent workspace 中
     - Agent 每次心跳时读取, 作为 "to-do checklist"
     - 文件为空/只有标题 → 跳过 API 调用 (省钱)
     - 文件不存在 → 仍然运行, LLM 自行决定

  2. HEARTBEAT_OK Token
     - LLM 无事可报时回复 "HEARTBEAT_OK"
     - 出现在回复开头/结尾时被剥离, 剩余 ≤ ackMaxChars → 静默
     - 出现在中间 → 不做特殊处理

  3. HeartbeatRunner (定时调度器)
     - 按 interval (默认 30m) 定时触发
     - 优先级唤醒队列: manual > interval > retry
     - 防并发: 正在运行时跳过, 排队请求合并

  4. Active Hours (活跃时段)
     - 限制心跳只在指定时间窗口运行 (如 09:00-22:00)

  5. 重复抑制
     - 24h 内相同内容不重复发送

  6. Visibility 控制
     - showOk: 是否发送 HEARTBEAT_OK (默认 false)
     - showAlerts: 是否发送警报内容 (默认 true)

  ── 架构图 ──────────────────────────────────────

  HeartbeatRunner
      │ timer fires (every 30m)
      v
  requestHeartbeatNow()
      │ priority queue + coalesce
      v
  run_heartbeat_once(agent)
      │
      ├─ [Guard] disabled?           → skip
      ├─ [Guard] outside active hrs? → skip
      ├─ [Guard] empty HEARTBEAT.md? → skip (save $)
      │
      ├─ Resolve session
      ├─ Build heartbeat prompt
      ├─ Invoke LLM (reuse s06 run_agent_with_soul_and_memory)
      │
      ├─ strip_heartbeat_token(response)
      │   ├─ response == "HEARTBEAT_OK" → silent ack
      │   ├─ remaining ≤ ackMaxChars   → silent ack
      │   └─ remaining has content     → deliver alert
      │
      ├─ Duplicate check (24h window)
      │
      └─ emit_heartbeat_event(status)

  ── 对标 OpenClaw 源码 ──────────────────────────
  【参考】src/infra/heartbeat-runner.ts      - 主执行引擎
  【参考】src/infra/heartbeat-wake.ts        - 唤醒调度
  【参考】src/auto-reply/heartbeat.ts        - Token 处理
  【参考】src/auto-reply/tokens.ts           - HEARTBEAT_OK 常量
  【参考】src/infra/heartbeat-events.ts      - 事件系统
  【参考】src/infra/heartbeat-active-hours.ts - 活跃时段
  【参考】src/infra/heartbeat-visibility.ts  - 可见性控制
  【参考】docs/gateway/heartbeat.md          - 用户文档

  ── 运行方式 ──────────────────────────────────────

  python s07_heartbeat.py              # 默认 REPL (带心跳)
  python s07_heartbeat.py --repl       # 交互式本地测试
  python s07_heartbeat.py --once       # 执行一次心跳并退出

  ── 依赖 ──────────────────────────────────────────
  pip install python-dotenv websockets
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import json
import os
import re
import sys
import time
import logging
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# 路径设置 — 确保能找到同目录的模块
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 从 s06_mem 导入 Soul & Memory 框架 (不重写)
# ---------------------------------------------------------------------------
from s06_mem import (
    # Agent 相关
    AgentWithSoulMemory,
    build_agent_system_prompt,
    create_agents_with_soul_memory,
    run_agent_with_soul_and_memory,
    # Memory 相关
    get_memory_manager,
    MemoryIndexManager,
    handle_memory_tool,
    build_memory_tools,
    MEMORY_TOOL_NAMES,
    load_workspace_bootstrap_files,
    # 配置
    WORKSPACE_DIR,
    SESSIONS_DIR,
    # UI
    CYAN, GREEN, YELLOW, DIM, RESET, BOLD, MAGENTA, BLUE,
    colored_prompt, print_assistant, print_info, print_tool, print_agent,
)

# ---------------------------------------------------------------------------
# 从 s05_gateway 导入路由框架
# ---------------------------------------------------------------------------
from s05_gateway import (
    AgentConfig,
    Binding,
    MessageRouter,
    build_session_key,
    load_routing_config,
)

# ---------------------------------------------------------------------------
# 从 s04 导入工具和 session 管理
# ---------------------------------------------------------------------------
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

# 日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway-heartbeat")

# ============================================================================
# Part 1: Heartbeat Constants & Token
# ============================================================================
#
# 【参考】src/auto-reply/tokens.ts           HEARTBEAT_TOKEN = "HEARTBEAT_OK"
# 【参考】src/auto-reply/heartbeat.ts         DEFAULT_HEARTBEAT_EVERY = "30m"
# 【参考】src/auto-reply/heartbeat.ts         DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300
# 【参考】src/auto-reply/heartbeat.ts         HEARTBEAT_PROMPT
# 【参考】src/infra/heartbeat-runner.ts       DEFAULT_HEARTBEAT_TARGET = "last"
# ============================================================================

HEARTBEAT_TOKEN = "HEARTBEAT_OK"

DEFAULT_HEARTBEAT_EVERY = "30m"
DEFAULT_HEARTBEAT_EVERY_MS = 30 * 60 * 1000  # 30 minutes in ms

DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300

# 默认心跳提示 — 与原始 OpenClaw 完全一致
# 【参考】src/auto-reply/heartbeat.ts  HEARTBEAT_PROMPT
HEARTBEAT_PROMPT = (
    "Read HEARTBEAT.md if it exists (workspace context). "
    "Follow it strictly. Do not infer or repeat old tasks from prior chats. "
    "If nothing needs attention, reply HEARTBEAT_OK."
)

DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md"

DEFAULT_HEARTBEAT_TARGET = "last"

# Exec event prompt — 用于异步命令完成通知
# 【参考】src/infra/heartbeat-runner.ts  EXEC_EVENT_PROMPT
EXEC_EVENT_PROMPT = (
    "An async command you ran earlier has completed. "
    "The result is shown in the system messages above. "
    "Please relay the command output to the user in a helpful way. "
    "If the command succeeded, share the relevant output. "
    "If it failed, explain what went wrong."
)


# ============================================================================
# Part 2: HeartbeatConfig — 心跳配置数据结构
# ============================================================================
#
# 【参考】src/config/types.agent-defaults.ts  HeartbeatConfig
# 【参考】docs/gateway/heartbeat.md  "Config" section
#
# 配置层级 (对标原始 OpenClaw):
#   1. agents.defaults.heartbeat      → 全局默认
#   2. agents.list[].heartbeat        → 每个 Agent 覆盖
# ============================================================================

@dataclass
class HeartbeatConfig:
    """心跳配置, 对标 OpenClaw HeartbeatConfig.

    【参考】src/config/types.agent-defaults.ts
    """
    every: str = DEFAULT_HEARTBEAT_EVERY             # 间隔, 如 "30m", "1h"
    model: str | None = None                          # 模型覆盖
    target: str = DEFAULT_HEARTBEAT_TARGET            # "last" | "none" | channel_id
    to: str | None = None                             # 接收者覆盖
    account_id: str | None = None                     # 多账户 channel id
    prompt: str | None = None                         # 自定义提示
    ack_max_chars: int = DEFAULT_HEARTBEAT_ACK_MAX_CHARS  # HEARTBEAT_OK 后最大字符数
    session: str | None = None                        # session key 覆盖
    include_reasoning: bool = False                   # 是否发送 Reasoning: 消息
    active_hours: ActiveHoursConfig | None = None     # 活跃时段


@dataclass
class ActiveHoursConfig:
    """活跃时段配置.

    【参考】src/infra/heartbeat-active-hours.ts
    """
    start: str = "09:00"   # HH:MM, 包含
    end: str = "22:00"     # HH:MM, 不包含 (支持 "24:00")
    timezone: str | None = None  # IANA 时区 / "user" / "local"


# ============================================================================
# Part 3: Duration Parser — 解析时间间隔字符串
# ============================================================================
#
# 【参考】src/cli/parse-duration.ts  parseDurationMs()
# ============================================================================

_DURATION_PATTERN = re.compile(
    r"(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?",
    re.IGNORECASE,
)


def parse_duration_ms(raw: str, *, default_unit: str = "m") -> int:
    """解析时间间隔字符串为毫秒.

    支持格式: "30m", "1h", "1h30m", "90s", "5" (默认单位分钟)

    【参考】src/cli/parse-duration.ts  parseDurationMs()
    """
    trimmed = raw.strip()
    if not trimmed:
        raise ValueError("Empty duration")

    # 纯数字 → 按默认单位
    if trimmed.isdigit():
        val = int(trimmed)
        if default_unit == "s":
            return val * 1000
        elif default_unit == "h":
            return val * 3600 * 1000
        else:  # default "m"
            return val * 60 * 1000

    m = _DURATION_PATTERN.fullmatch(trimmed)
    if not m or not any(m.groups()):
        raise ValueError(f"Invalid duration: {raw}")

    hours = int(m.group(1) or 0)
    minutes = int(m.group(2) or 0)
    seconds = int(m.group(3) or 0)
    return (hours * 3600 + minutes * 60 + seconds) * 1000


def resolve_heartbeat_interval_ms(config: HeartbeatConfig | None) -> int | None:
    """解析心跳间隔为毫秒, 无效或 0 返回 None.

    【参考】src/infra/heartbeat-runner.ts  resolveHeartbeatIntervalMs()
    """
    raw = config.every if config else DEFAULT_HEARTBEAT_EVERY
    if not raw or not raw.strip():
        return None
    try:
        ms = parse_duration_ms(raw.strip(), default_unit="m")
    except ValueError:
        return None
    return ms if ms > 0 else None


# ============================================================================
# Part 4: HEARTBEAT.md 内容检测
# ============================================================================
#
# 【参考】src/auto-reply/heartbeat.ts  isHeartbeatContentEffectivelyEmpty()
#
# 逻辑: 如果 HEARTBEAT.md 只有空行 + markdown 标题 + 空列表项 → 视为空
#       跳过 API 调用, 省钱.
# ============================================================================

def is_heartbeat_content_effectively_empty(content: str | None) -> bool:
    """检测 HEARTBEAT.md 是否 "实质为空" — 只有标题和空行.

    【参考】src/auto-reply/heartbeat.ts  isHeartbeatContentEffectivelyEmpty()

    规则:
      - None → False (文件不存在不算空, LLM 仍可运行)
      - 只有空行 / markdown 标题 (# xxx) / 空列表项 → True
      - 有实质内容行 → False
    """
    if content is None:
        return False
    if not isinstance(content, str):
        return False

    for line in content.split("\n"):
        trimmed = line.strip()
        # 空行
        if not trimmed:
            continue
        # markdown ATX 标题 (# 后跟空格或行尾, 不含 #TODO)
        if re.match(r"^#+(\s|$)", trimmed):
            continue
        # 空列表项: "- [ ]", "* [ ]", "- "
        if re.match(r"^[-*+]\s*(\[[\sXx]?\]\s*)?$", trimmed):
            continue
        # 有实质内容
        return False

    return True


# ============================================================================
# Part 5: Heartbeat Token Stripping — HEARTBEAT_OK 剥离
# ============================================================================
#
# 【参考】src/auto-reply/heartbeat.ts  stripHeartbeatToken()
# 【参考】src/auto-reply/heartbeat.ts  stripTokenAtEdges()
#
# 核心逻辑:
#   1. HEARTBEAT_OK 在回复开头 → 剥离 token, 保留后面的内容
#   2. HEARTBEAT_OK 在回复结尾 (±4个非字母字符) → 剥离
#   3. HEARTBEAT_OK 在中间 → 不做处理
#   4. 剥离后剩余 ≤ ackMaxChars → shouldSkip=True (静默)
#   5. 剥离后剩余 > ackMaxChars → shouldSkip=False (有内容要发)
# ============================================================================

@dataclass
class StripResult:
    """Token 剥离结果."""
    should_skip: bool    # 是否应跳过发送
    text: str            # 剥离后的文本
    did_strip: bool      # 是否实际剥离了 token


def _strip_token_at_edges(raw: str) -> tuple[str, bool]:
    """从文本开头和结尾剥离 HEARTBEAT_OK token.

    【参考】src/auto-reply/heartbeat.ts  stripTokenAtEdges()
    """
    text = raw.strip()
    if not text:
        return "", False

    token = HEARTBEAT_TOKEN
    if token not in text:
        return text, False

    did_strip = False
    # 结尾正则: HEARTBEAT_OK 后跟 0-4 个非单词字符到行尾
    end_pattern = re.compile(re.escape(token) + r"[^\w]{0,4}$")

    changed = True
    while changed:
        changed = False
        text = text.strip()

        # 开头剥离
        if text.startswith(token):
            text = text[len(token):].lstrip()
            did_strip = True
            changed = True
            continue

        # 结尾剥离
        m = end_pattern.search(text)
        if m:
            idx = text.rfind(token)
            before = text[:idx].rstrip()
            if not before:
                text = ""
            else:
                after = text[idx + len(token):].lstrip()
                text = f"{before}{after}".rstrip()
            did_strip = True
            changed = True

    # 压缩空白
    text = re.sub(r"\s+", " ", text).strip()
    return text, did_strip


def _strip_markup(text: str) -> str:
    """去除轻量标记 (HTML 标签 / Markdown 加粗等).

    【参考】src/auto-reply/heartbeat.ts  stripMarkup()
    """
    # 去掉 HTML 标签
    text = re.sub(r"<[^>]*>", " ", text)
    # &nbsp;
    text = re.sub(r"&nbsp;", " ", text, flags=re.IGNORECASE)
    # 去除开头结尾的 markdown 装饰符
    text = re.sub(r"^[*`~_]+", "", text)
    text = re.sub(r"[*`~_]+$", "", text)
    return text


def strip_heartbeat_token(
    raw: str | None,
    *,
    mode: Literal["heartbeat", "message"] = "message",
    max_ack_chars: int | None = None,
) -> StripResult:
    """剥离回复中的 HEARTBEAT_OK token, 决定是否应跳过发送.

    【参考】src/auto-reply/heartbeat.ts  stripHeartbeatToken()

    参数:
      raw: LLM 的原始回复文本
      mode: "heartbeat" (心跳运行) 或 "message" (普通消息)
      max_ack_chars: 允许的最大 ack 字符数 (默认 300)

    返回:
      StripResult(should_skip, text, did_strip)
    """
    if not raw:
        return StripResult(should_skip=True, text="", did_strip=False)

    trimmed = raw.strip()
    if not trimmed:
        return StripResult(should_skip=True, text="", did_strip=False)

    ack_max = max_ack_chars if max_ack_chars is not None else DEFAULT_HEARTBEAT_ACK_MAX_CHARS
    ack_max = max(0, ack_max)

    # 标准化轻量标记, 确保 <b>HEARTBEAT_OK</b> 也能被识别
    trimmed_normalized = _strip_markup(trimmed)

    has_token = (
        HEARTBEAT_TOKEN in trimmed
        or HEARTBEAT_TOKEN in trimmed_normalized
    )
    if not has_token:
        return StripResult(should_skip=False, text=trimmed, did_strip=False)

    # 尝试从原文和标准化版本两个方向剥离
    stripped_orig_text, stripped_orig = _strip_token_at_edges(trimmed)
    stripped_norm_text, stripped_norm = _strip_token_at_edges(trimmed_normalized)

    # 优先使用原文版本 (如果它成功剥离并有内容)
    if stripped_orig and stripped_orig_text:
        picked_text, picked_did = stripped_orig_text, True
    else:
        picked_text, picked_did = stripped_norm_text, stripped_norm

    if not picked_did:
        return StripResult(should_skip=False, text=trimmed, did_strip=False)

    # 剥离后无内容 → 纯 ack
    if not picked_text:
        return StripResult(should_skip=True, text="", did_strip=True)

    rest = picked_text.strip()

    # heartbeat 模式: 剩余字符 ≤ ackMaxChars → 视为 ack
    if mode == "heartbeat" and len(rest) <= ack_max:
        return StripResult(should_skip=True, text="", did_strip=True)

    return StripResult(should_skip=False, text=rest, did_strip=True)


# ============================================================================
# Part 6: Active Hours — 活跃时段检查
# ============================================================================
#
# 【参考】src/infra/heartbeat-active-hours.ts  isWithinActiveHours()
#
# 如果配置了 activeHours, 心跳只在时间窗口内运行.
# 窗口外 → skip, 等下一个定时 tick.
# ============================================================================

_TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]|24):([0-5]\d)$")


def _parse_active_hours_time(raw: str | None, *, allow_24: bool = False) -> int | None:
    """解析 HH:MM 为分钟数 (0-1440).

    【参考】src/infra/heartbeat-active-hours.ts  parseActiveHoursTime()
    """
    if not raw or not _TIME_PATTERN.match(raw):
        return None
    hour_str, minute_str = raw.split(":")
    hour, minute = int(hour_str), int(minute_str)
    if hour == 24:
        if not allow_24 or minute != 0:
            return None
        return 24 * 60
    return hour * 60 + minute


def _resolve_current_minutes(now_ms: float, tz_name: str | None) -> int | None:
    """获取指定时区的当前时间 (分钟).

    教学简化: 使用 Python datetime + zoneinfo.
    """
    try:
        from zoneinfo import ZoneInfo
        if tz_name:
            tz = ZoneInfo(tz_name)
        else:
            tz = None  # 系统时区
        dt = datetime.fromtimestamp(now_ms / 1000.0, tz=tz)
        return dt.hour * 60 + dt.minute
    except Exception:
        # 回退到系统本地时间
        dt = datetime.now()
        return dt.hour * 60 + dt.minute


def is_within_active_hours(
    active_hours: ActiveHoursConfig | None,
    now_ms: float | None = None,
) -> bool:
    """检查当前时间是否在活跃时段内.

    【参考】src/infra/heartbeat-active-hours.ts  isWithinActiveHours()

    规则:
      - 无配置 → True (始终允许)
      - 解析失败 → True (安全默认)
      - start==end → True
      - end > start → 正常范围 [start, end)
      - end < start → 跨午夜范围 [start, 24:00) ∪ [00:00, end)
    """
    if not active_hours:
        return True

    start_min = _parse_active_hours_time(active_hours.start, allow_24=False)
    end_min = _parse_active_hours_time(active_hours.end, allow_24=True)

    if start_min is None or end_min is None:
        return True
    if start_min == end_min:
        return True

    ts = now_ms if now_ms is not None else time.time() * 1000
    current_min = _resolve_current_minutes(ts, active_hours.timezone)
    if current_min is None:
        return True

    # 正常范围
    if end_min > start_min:
        return start_min <= current_min < end_min
    # 跨午夜
    return current_min >= start_min or current_min < end_min


# ============================================================================
# Part 7: Heartbeat Prompt Resolution
# ============================================================================
#
# 【参考】src/auto-reply/heartbeat.ts  resolveHeartbeatPrompt()
# 【参考】src/infra/heartbeat-runner.ts  resolveHeartbeatPrompt()
# ============================================================================

def resolve_heartbeat_prompt(config: HeartbeatConfig | None) -> str:
    """解析心跳提示文本.

    【参考】src/auto-reply/heartbeat.ts  resolveHeartbeatPrompt()
    """
    if config and config.prompt:
        trimmed = config.prompt.strip()
        if trimmed:
            return trimmed
    return HEARTBEAT_PROMPT


# ============================================================================
# Part 8: Heartbeat Event System — 事件跟踪
# ============================================================================
#
# 【参考】src/infra/heartbeat-events.ts  HeartbeatEventPayload
# 【参考】src/infra/heartbeat-events.ts  emitHeartbeatEvent()
#
# 心跳每次运行后发出事件, 记录 status / duration / preview 等.
# 教学版使用 callback list 模拟事件系统.
# ============================================================================

HeartbeatStatus = Literal["sent", "ok-empty", "ok-token", "skipped", "failed"]
IndicatorType = Literal["ok", "alert", "error"]


@dataclass
class HeartbeatEvent:
    """心跳事件, 对标 HeartbeatEventPayload.

    【参考】src/infra/heartbeat-events.ts
    """
    ts: float                               # 时间戳 (ms)
    status: HeartbeatStatus                  # 事件状态
    to: str | None = None                    # 发送目标
    account_id: str | None = None            # 账户 ID
    preview: str | None = None               # 内容预览 (前 200 字符)
    duration_ms: float | None = None         # 耗时
    has_media: bool = False                   # 是否有媒体
    reason: str | None = None                # 跳过/失败原因
    channel: str | None = None               # 频道
    silent: bool = False                      # 是否静默
    indicator_type: IndicatorType | None = None  # UI 指示器类型


def resolve_indicator_type(status: HeartbeatStatus) -> IndicatorType | None:
    """根据状态解析 UI 指示器类型.

    【参考】src/infra/heartbeat-events.ts  resolveIndicatorType()
    """
    if status in ("ok-empty", "ok-token"):
        return "ok"
    if status == "sent":
        return "alert"
    if status == "failed":
        return "error"
    return None  # "skipped" → 无指示器


# 全局事件存储与监听器
_last_heartbeat_event: HeartbeatEvent | None = None
_heartbeat_listeners: list[Callable[[HeartbeatEvent], None]] = []


def emit_heartbeat_event(
    status: HeartbeatStatus,
    *,
    reason: str | None = None,
    preview: str | None = None,
    duration_ms: float | None = None,
    channel: str | None = None,
    account_id: str | None = None,
    has_media: bool = False,
    silent: bool = False,
    to: str | None = None,
) -> HeartbeatEvent:
    """发出心跳事件.

    【参考】src/infra/heartbeat-events.ts  emitHeartbeatEvent()
    """
    global _last_heartbeat_event

    evt = HeartbeatEvent(
        ts=time.time() * 1000,
        status=status,
        reason=reason,
        preview=preview[:200] if preview else None,
        duration_ms=duration_ms,
        channel=channel,
        account_id=account_id,
        has_media=has_media,
        silent=silent,
        to=to,
        indicator_type=resolve_indicator_type(status),
    )
    _last_heartbeat_event = evt

    for listener in _heartbeat_listeners:
        try:
            listener(evt)
        except Exception:
            pass

    return evt


def on_heartbeat_event(listener: Callable[[HeartbeatEvent], None]) -> Callable[[], None]:
    """注册心跳事件监听器, 返回取消函数.

    【参考】src/infra/heartbeat-events.ts  onHeartbeatEvent()
    """
    _heartbeat_listeners.append(listener)
    def dispose():
        try:
            _heartbeat_listeners.remove(listener)
        except ValueError:
            pass
    return dispose


def get_last_heartbeat_event() -> HeartbeatEvent | None:
    """获取最近的心跳事件."""
    return _last_heartbeat_event


# ============================================================================
# Part 9: Heartbeat Visibility — 可见性控制
# ============================================================================
#
# 【参考】src/infra/heartbeat-visibility.ts  resolveHeartbeatVisibility()
#
# 教学简化: 不做多层 channel 配置, 使用全局默认.
# ============================================================================

@dataclass
class HeartbeatVisibility:
    """心跳可见性配置.

    【参考】src/infra/heartbeat-visibility.ts  ResolvedHeartbeatVisibility
    """
    show_ok: bool = False       # 发送 HEARTBEAT_OK ack (默认不发)
    show_alerts: bool = True    # 发送告警内容 (默认发送)
    use_indicator: bool = True  # 发出 indicator 事件 (默认发出)


# ============================================================================
# Part 10: Heartbeat Run Result — 运行结果
# ============================================================================
#
# 【参考】src/infra/heartbeat-wake.ts  HeartbeatRunResult
# ============================================================================

@dataclass
class HeartbeatRunResult:
    """心跳运行结果, 对标 HeartbeatRunResult.

    【参考】src/infra/heartbeat-wake.ts
    """
    status: Literal["ran", "skipped", "failed"]
    duration_ms: float = 0
    reason: str | None = None


# ============================================================================
# Part 11: run_heartbeat_once — 主执行函数
# ============================================================================
#
# 【参考】src/infra/heartbeat-runner.ts  runHeartbeatOnce()
#
# 完整执行流程:
#   1. Guard 检查 (disabled, active hours, empty HEARTBEAT.md)
#   2. 加载 session & HEARTBEAT.md
#   3. 构建心跳 prompt (默认 or 自定义 or cron event)
#   4. 调用 LLM (复用 s06 的 run_agent_with_soul_and_memory)
#   5. 剥离 HEARTBEAT_OK token
#   6. 判断是否应发送 (visibility + duplicate check)
#   7. 发出事件
# ============================================================================

# 用于重复检测的 session 级存储
_heartbeat_state: dict[str, dict[str, Any]] = {}


def run_heartbeat_once(
    agent: AgentWithSoulMemory,
    session_store: S04SessionStore,
    config: HeartbeatConfig | None = None,
    *,
    reason: str | None = None,
    visibility: HeartbeatVisibility | None = None,
) -> HeartbeatRunResult:
    """执行一次心跳, 对标 runHeartbeatOnce().

    【参考】src/infra/heartbeat-runner.ts  runHeartbeatOnce()

    完整流程:
      1. Guard: disabled / active hours / empty HEARTBEAT.md
      2. 构建心跳 prompt
      3. 调用 LLM (复用 s06 run_agent_with_soul_and_memory)
      4. 剥离 HEARTBEAT_OK
      5. Duplicate check (24h 窗口)
      6. 发出事件
    """
    cfg = config or HeartbeatConfig()
    vis = visibility or HeartbeatVisibility()
    started_at = time.time() * 1000  # ms

    # --- Guard 1: interval 解析 ---
    interval_ms = resolve_heartbeat_interval_ms(cfg)
    if not interval_ms:
        return HeartbeatRunResult(status="skipped", reason="disabled")

    # --- Guard 2: Active hours ---
    if not is_within_active_hours(cfg.active_hours, started_at):
        return HeartbeatRunResult(status="skipped", reason="quiet-hours")

    # --- Guard 3: All visibility flags off → 跳过 (不调用 API) ---
    # 【参考】heartbeat-runner.ts L507-516
    if not vis.show_alerts and not vis.show_ok and not vis.use_indicator:
        emit_heartbeat_event(
            "skipped",
            reason="alerts-disabled",
            duration_ms=time.time() * 1000 - started_at,
        )
        return HeartbeatRunResult(status="skipped", reason="alerts-disabled")

    # --- Guard 4: HEARTBEAT.md 空内容检查 ---
    # 【参考】heartbeat-runner.ts L431-454
    heartbeat_path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
    try:
        heartbeat_content = heartbeat_path.read_text(encoding="utf-8")
        if is_heartbeat_content_effectively_empty(heartbeat_content):
            # 排除特殊唤醒原因 (exec-event, cron:*, wake, hook:*)
            is_special = (
                reason == "exec-event"
                or (reason and reason.startswith("cron:"))
                or reason == "wake"
                or (reason and reason.startswith("hook:"))
            )
            if not is_special:
                emit_heartbeat_event(
                    "skipped",
                    reason="empty-heartbeat-file",
                    duration_ms=time.time() * 1000 - started_at,
                )
                return HeartbeatRunResult(
                    status="skipped",
                    reason="empty-heartbeat-file",
                )
    except (FileNotFoundError, PermissionError):
        # 文件不存在 → 正常, 继续执行
        # 【参考】heartbeat-runner.ts L451-453
        pass

    # --- 构建心跳 prompt ---
    prompt = resolve_heartbeat_prompt(cfg)

    # 附加当前时间 (对标 appendCronStyleCurrentTimeLine)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    prompt_with_time = f"{prompt}\n\nCurrent time: {now_str}"

    # --- Session key for heartbeat ---
    session_key = f"heartbeat:{agent.id}:main"

    # --- 调用 LLM (复用 s06 的 run_agent_with_soul_and_memory) ---
    # 【参考】heartbeat-runner.ts L548-553  getReplyFromConfig()
    try:
        response = run_agent_with_soul_and_memory(
            agent,
            session_store,
            session_key,
            prompt_with_time,
        )
    except Exception as err:
        error_msg = str(err)
        emit_heartbeat_event(
            "failed",
            reason=error_msg,
            duration_ms=time.time() * 1000 - started_at,
        )
        log.error("heartbeat failed: %s", error_msg)
        return HeartbeatRunResult(
            status="failed",
            reason=error_msg,
            duration_ms=time.time() * 1000 - started_at,
        )

    duration = time.time() * 1000 - started_at

    # --- 处理空回复 ---
    # 【参考】heartbeat-runner.ts L560-580
    if not response or not response.strip():
        emit_heartbeat_event(
            "ok-empty",
            reason=reason,
            duration_ms=duration,
            silent=True,
            indicator_type="ok" if vis.use_indicator else None,
        )
        return HeartbeatRunResult(status="ran", duration_ms=duration)

    # --- 剥离 HEARTBEAT_OK token ---
    # 【参考】heartbeat-runner.ts L582-614
    stripped = strip_heartbeat_token(
        response,
        mode="heartbeat",
        max_ack_chars=cfg.ack_max_chars,
    )

    if stripped.should_skip:
        # HEARTBEAT_OK → 静默
        emit_heartbeat_event(
            "ok-token",
            reason=reason,
            duration_ms=duration,
            silent=not vis.show_ok,
            indicator_type="ok" if vis.use_indicator else None,
        )
        if vis.show_ok:
            # 配置为显示 OK → 输出
            log.info("heartbeat [%s]: HEARTBEAT_OK (visible)", agent.id)
        return HeartbeatRunResult(status="ran", duration_ms=duration)

    alert_text = stripped.text

    # --- Duplicate detection (24h 窗口) ---
    # 【参考】heartbeat-runner.ts L620-649
    state_key = f"{agent.id}:{session_key}"
    prev_state = _heartbeat_state.get(state_key, {})
    prev_text = prev_state.get("last_text", "")
    prev_at = prev_state.get("last_sent_at", 0)
    is_duplicate = (
        bool(prev_text.strip())
        and alert_text.strip() == prev_text.strip()
        and (started_at - prev_at) < 24 * 60 * 60 * 1000
    )

    if is_duplicate:
        emit_heartbeat_event(
            "skipped",
            reason="duplicate",
            preview=alert_text[:200],
            duration_ms=duration,
        )
        return HeartbeatRunResult(status="ran", duration_ms=duration)

    # --- Visibility: showAlerts check ---
    # 【参考】heartbeat-runner.ts L671-688
    if not vis.show_alerts:
        emit_heartbeat_event(
            "skipped",
            reason="alerts-disabled",
            preview=alert_text[:200],
            duration_ms=duration,
            indicator_type="alert" if vis.use_indicator else None,
        )
        return HeartbeatRunResult(status="ran", duration_ms=duration)

    # --- 有内容 → 发送 (教学版直接打印) ---
    # 记录 state 用于后续 dedup
    _heartbeat_state[state_key] = {
        "last_text": alert_text,
        "last_sent_at": started_at,
    }

    emit_heartbeat_event(
        "sent",
        preview=alert_text[:200],
        duration_ms=duration,
        indicator_type="alert" if vis.use_indicator else None,
    )

    return HeartbeatRunResult(status="ran", duration_ms=duration)


# ============================================================================
# Part 12: HeartbeatRunner — 定时调度器
# ============================================================================
#
# 【参考】src/infra/heartbeat-runner.ts  startHeartbeatRunner()
# 【参考】src/infra/heartbeat-wake.ts    requestHeartbeatNow()
#
# 使用 threading.Timer 实现定时调度:
#   - 每隔 interval 触发一次 run_heartbeat_once
#   - 支持 requestHeartbeatNow() 立即触发
#   - 防并发: 正在运行时排队
#   - 优先级唤醒: manual > interval > retry
# ============================================================================

# 唤醒原因优先级 (对标原始 OpenClaw)
# 【参考】src/infra/heartbeat-wake.ts  REASON_PRIORITY
REASON_PRIORITY = {
    "retry": 0,
    "interval": 1,
    "default": 2,
    "action": 3,  # manual, exec-event, hook:*
}

DEFAULT_COALESCE_MS = 250
DEFAULT_RETRY_MS = 1000


def _resolve_reason_priority(reason: str) -> int:
    """解析唤醒原因的优先级.

    【参考】src/infra/heartbeat-wake.ts  resolveReasonPriority()
    """
    if reason == "retry":
        return REASON_PRIORITY["retry"]
    if reason == "interval":
        return REASON_PRIORITY["interval"]
    if reason in ("manual", "exec-event") or reason.startswith("hook:"):
        return REASON_PRIORITY["action"]
    return REASON_PRIORITY["default"]


class HeartbeatRunner:
    """心跳定时调度器, 对标 HeartbeatRunner.

    【参考】src/infra/heartbeat-runner.ts  startHeartbeatRunner()
    【参考】src/infra/heartbeat-wake.ts    (wake handler & priority queue)

    核心职责:
      1. 按 interval 定时触发 run_heartbeat_once
      2. 管理优先级唤醒队列
      3. 防并发 (running 标记)
      4. 支持 config 热更新

    使用:
      runner = HeartbeatRunner(agent, session_store, config)
      runner.start()
      ...
      runner.stop()
    """

    def __init__(
        self,
        agent: AgentWithSoulMemory,
        session_store: S04SessionStore,
        config: HeartbeatConfig | None = None,
        visibility: HeartbeatVisibility | None = None,
        on_alert: Callable[[str, HeartbeatEvent], None] | None = None,
    ):
        self.agent = agent
        self.session_store = session_store
        self.config = config or HeartbeatConfig()
        self.visibility = visibility or HeartbeatVisibility()
        self.on_alert = on_alert  # 告警回调 (文本, 事件)

        self._stopped = False
        self._running = False
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

        # 优先级唤醒队列 (对标 pendingWake)
        # 【参考】src/infra/heartbeat-wake.ts  PendingWakeReason
        self._pending_reason: str | None = None
        self._pending_priority: int = -1
        self._pending_at: float = 0

        # 运行统计
        self._last_run_ms: float | None = None
        self._run_count: int = 0

    @property
    def interval_ms(self) -> int | None:
        return resolve_heartbeat_interval_ms(self.config)

    @property
    def interval_seconds(self) -> float | None:
        ms = self.interval_ms
        return ms / 1000.0 if ms else None

    def start(self) -> None:
        """启动心跳调度器."""
        interval = self.interval_seconds
        if not interval:
            log.info("heartbeat: disabled (interval=0)")
            return

        self._stopped = False
        log.info(
            "heartbeat: started (every=%s, interval=%.0fs, agent=%s)",
            self.config.every, interval, self.agent.id,
        )
        self._schedule_next()

    def stop(self) -> None:
        """停止心跳调度器.

        【参考】src/infra/heartbeat-runner.ts  cleanup()
        """
        self._stopped = True
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None
        log.info("heartbeat: stopped (agent=%s)", self.agent.id)

    def request_now(self, reason: str = "manual") -> None:
        """立即请求一次心跳 (优先级唤醒).

        【参考】src/infra/heartbeat-wake.ts  requestHeartbeatNow()
        """
        self._queue_pending_reason(reason)
        self._schedule_now()

    def update_config(self, config: HeartbeatConfig) -> None:
        """热更新配置.

        【参考】src/infra/heartbeat-runner.ts  updateConfig()
        """
        self.config = config
        if not self._stopped:
            self._schedule_next()

    def _queue_pending_reason(self, reason: str | None = None) -> None:
        """入队唤醒原因 (按优先级).

        【参考】src/infra/heartbeat-wake.ts  queuePendingWakeReason()
        """
        normalized = (reason or "requested").strip() or "requested"
        priority = _resolve_reason_priority(normalized)
        now = time.time() * 1000

        with self._lock:
            if self._pending_reason is None:
                self._pending_reason = normalized
                self._pending_priority = priority
                self._pending_at = now
            elif priority > self._pending_priority:
                self._pending_reason = normalized
                self._pending_priority = priority
                self._pending_at = now
            elif priority == self._pending_priority and now >= self._pending_at:
                self._pending_reason = normalized
                self._pending_at = now

    def _consume_pending_reason(self) -> str | None:
        """消费待处理的唤醒原因."""
        with self._lock:
            reason = self._pending_reason
            self._pending_reason = None
            self._pending_priority = -1
            self._pending_at = 0
            return reason

    def _schedule_next(self) -> None:
        """调度下一次心跳.

        【参考】src/infra/heartbeat-runner.ts  scheduleNext()
        """
        if self._stopped:
            return

        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None

        interval = self.interval_seconds
        if not interval:
            return

        self._timer = threading.Timer(interval, self._on_timer)
        self._timer.daemon = True
        self._timer.start()

    def _schedule_now(self) -> None:
        """立即调度 (合并延迟).

        【参考】src/infra/heartbeat-wake.ts  schedule()
        """
        if self._stopped:
            return

        coalesce_s = DEFAULT_COALESCE_MS / 1000.0

        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None

        self._timer = threading.Timer(coalesce_s, self._on_timer)
        self._timer.daemon = True
        self._timer.start()

    def _on_timer(self) -> None:
        """定时器回调 — 执行心跳.

        【参考】src/infra/heartbeat-wake.ts  schedule() callback
        """
        if self._stopped:
            return

        # 防并发
        if self._running:
            self._queue_pending_reason("interval")
            self._schedule_next()
            return

        self._running = True
        reason = self._consume_pending_reason() or "interval"

        try:
            result = run_heartbeat_once(
                self.agent,
                self.session_store,
                self.config,
                reason=reason,
                visibility=self.visibility,
            )

            self._last_run_ms = time.time() * 1000
            self._run_count += 1

            # 日志
            if result.status == "ran":
                last_evt = get_last_heartbeat_event()
                if last_evt and last_evt.status == "sent" and last_evt.preview:
                    log.info(
                        "heartbeat [%s]: ALERT — %s",
                        self.agent.id,
                        last_evt.preview[:100],
                    )
                    # 回调
                    if self.on_alert and last_evt.preview:
                        self.on_alert(last_evt.preview, last_evt)
                elif last_evt and last_evt.status in ("ok-empty", "ok-token"):
                    log.info("heartbeat [%s]: OK (silent)", self.agent.id)
                elif last_evt and last_evt.status == "skipped":
                    log.info(
                        "heartbeat [%s]: skipped (%s)",
                        self.agent.id, last_evt.reason,
                    )
            elif result.status == "skipped":
                log.info(
                    "heartbeat [%s]: skipped (%s)",
                    self.agent.id, result.reason,
                )
            elif result.status == "failed":
                log.error(
                    "heartbeat [%s]: FAILED — %s",
                    self.agent.id, result.reason,
                )

        except Exception as err:
            log.error("heartbeat runner error: %s", err)
        finally:
            self._running = False
            # 调度下一次
            if not self._stopped:
                self._schedule_next()

    def get_summary(self) -> dict[str, Any]:
        """获取心跳状态摘要.

        【参考】src/infra/heartbeat-runner.ts  resolveHeartbeatSummaryForAgent()
        """
        interval = self.interval_ms
        return {
            "enabled": interval is not None and not self._stopped,
            "every": self.config.every,
            "every_ms": interval,
            "prompt": resolve_heartbeat_prompt(self.config),
            "target": self.config.target,
            "model": self.config.model,
            "ack_max_chars": self.config.ack_max_chars,
            "run_count": self._run_count,
            "last_run_ms": self._last_run_ms,
            "active_hours": (
                {
                    "start": self.config.active_hours.start,
                    "end": self.config.active_hours.end,
                    "timezone": self.config.active_hours.timezone,
                }
                if self.config.active_hours else None
            ),
        }


# ============================================================================
# Part 13: REPL Mode — 带心跳的交互式测试
# ============================================================================

RED = "\033[31m"


def run_repl_with_heartbeat(
    agent: AgentWithSoulMemory,
    session_store: S04SessionStore,
    config: HeartbeatConfig | None = None,
) -> None:
    """交互式 REPL, 后台运行心跳.

    在 s06 REPL 基础上增加:
      - 后台心跳线程
      - /heartbeat 命令 (查看状态)
      - /hb-now 命令 (立即触发)
      - /hb-config 命令 (查看配置)
    """
    cfg = config or HeartbeatConfig()
    session_key = f"repl:{agent.id}:local"

    # 心跳告警回调 — 在 REPL 中打印
    def on_alert(text: str, evt: HeartbeatEvent) -> None:
        print(f"\n{RED}{BOLD}[HEARTBEAT ALERT]{RESET} {text}\n")
        # 重新打印 prompt
        print(colored_prompt(), end="", flush=True)

    # 注册事件监听器 — 用于 REPL 内显示
    def event_listener(evt: HeartbeatEvent) -> None:
        status_color = {
            "sent": RED,
            "ok-empty": DIM,
            "ok-token": DIM,
            "skipped": YELLOW,
            "failed": RED,
        }.get(evt.status, "")
        if evt.status not in ("ok-empty", "ok-token"):
            log.debug(
                "heartbeat event: %s%s%s (%.0fms) %s",
                status_color, evt.status, RESET,
                evt.duration_ms or 0,
                evt.reason or "",
            )

    dispose_listener = on_heartbeat_event(event_listener)

    # 启动心跳 runner
    runner = HeartbeatRunner(
        agent, session_store, cfg,
        on_alert=on_alert,
    )

    print_info("=" * 70)
    print_info(f"  Mini-Claw REPL  |  Section 07: Heartbeat")
    print_info(f"  Agent: {agent.id}")
    print_info(f"  Model: {agent.model}")
    print_info(f"  Workspace: {agent.workspace_dir}")
    print_info(f"  Heartbeat: every {cfg.every}")
    if cfg.active_hours:
        print_info(
            f"  Active hours: {cfg.active_hours.start}-{cfg.active_hours.end}"
            f" ({cfg.active_hours.timezone or 'local'})"
        )
    print_info("")
    print_info("  Commands:")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current soul")
    print_info("    /memory            - View memory status")
    print_info("    /heartbeat         - View heartbeat status")
    print_info("    /hb-now            - Trigger heartbeat immediately")
    print_info("    /hb-config         - View heartbeat config")
    print_info("=" * 70)
    print()

    # 显示 HEARTBEAT.md 状态
    hb_path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
    if hb_path.exists():
        hb_content = hb_path.read_text(encoding="utf-8").strip()
        if is_heartbeat_content_effectively_empty(hb_content):
            print_info(f"HEARTBEAT.md exists but is effectively empty (skips API calls)")
        else:
            first_line = hb_content.split("\n")[0].strip()
            print_info(f"HEARTBEAT.md loaded: {first_line}")
    else:
        print_info(f"No HEARTBEAT.md at {hb_path}")
        print_info("Create one to define heartbeat checklist!\n")

    # 显示 Soul 状态
    soul_path = agent.soul_path
    if soul_path.exists():
        soul_content = soul_path.read_text(encoding="utf-8").strip()
        first_line = soul_content.split("\n")[0].strip()
        print_info(f"Soul loaded: {first_line}\n")
    else:
        print_info(f"No soul found at {soul_path}\n")

    # 启动心跳
    runner.start()

    try:
        while True:
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

            # ---- 内置命令 ----

            if user_input == "/soul":
                sp = agent.soul_path
                if sp.exists():
                    print(f"\n{MAGENTA}--- {agent.id.upper()} SOUL ---{RESET}")
                    print(sp.read_text(encoding="utf-8").strip())
                    print(f"{MAGENTA}--- end ---{RESET}\n")
                else:
                    print_info(f"No soul file at {sp}\n")
                continue

            if user_input == "/memory":
                mgr = get_memory_manager(agent)
                evergreen = mgr.load_evergreen()
                recent = mgr.get_recent_daily(days=7)
                print(f"\n{MAGENTA}--- Memory Status ({agent.id}) ---{RESET}")
                print(f"Workspace: {agent.workspace_dir}")
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
                summary = runner.get_summary()
                last_evt = get_last_heartbeat_event()
                print(f"\n{MAGENTA}--- Heartbeat Status ({agent.id}) ---{RESET}")
                print(f"Enabled: {summary['enabled']}")
                print(f"Interval: {summary['every']} ({summary['every_ms']}ms)")
                print(f"Runs: {summary['run_count']}")
                if summary['last_run_ms']:
                    ago = (time.time() * 1000 - summary['last_run_ms']) / 1000
                    print(f"Last run: {ago:.0f}s ago")
                if last_evt:
                    print(f"Last event: {last_evt.status}"
                          f" ({last_evt.duration_ms:.0f}ms)"
                          if last_evt.duration_ms else
                          f"Last event: {last_evt.status}")
                    if last_evt.preview:
                        print(f"Preview: {last_evt.preview[:100]}")
                    if last_evt.reason:
                        print(f"Reason: {last_evt.reason}")
                hb_path = agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
                if hb_path.exists():
                    content = hb_path.read_text(encoding="utf-8").strip()
                    empty = is_heartbeat_content_effectively_empty(content)
                    print(f"HEARTBEAT.md: {'empty (skips API)' if empty else f'{len(content)} chars'}")
                else:
                    print("HEARTBEAT.md: (not found)")
                if summary['active_hours']:
                    ah = summary['active_hours']
                    print(f"Active hours: {ah['start']}-{ah['end']} ({ah['timezone'] or 'local'})")
                print(f"{MAGENTA}--- end ---{RESET}\n")
                continue

            if user_input == "/hb-now":
                print_info("Triggering heartbeat now...")
                runner.request_now("manual")
                continue

            if user_input == "/hb-config":
                summary = runner.get_summary()
                print(f"\n{MAGENTA}--- Heartbeat Config ---{RESET}")
                print(json.dumps(summary, indent=2, default=str))
                print(f"{MAGENTA}--- end ---{RESET}\n")
                continue

            # ---- 正常对话 ----
            try:
                print(f"\n{BLUE}[Agent: {agent.id}]{RESET}")
                response = run_agent_with_soul_and_memory(
                    agent,
                    session_store,
                    session_key,
                    user_input,
                )
                if response:
                    print_assistant(response)
            except Exception as e:
                print(f"\n{YELLOW}Error: {e}{RESET}\n")
                log.exception(f"Error in agent loop: {e}")

    finally:
        runner.stop()
        dispose_listener()


# ============================================================================
# Part 14: One-shot Mode — 执行一次心跳
# ============================================================================

def run_once_mode(
    agent: AgentWithSoulMemory,
    session_store: S04SessionStore,
    config: HeartbeatConfig | None = None,
) -> None:
    """执行一次心跳并退出, 用于调试和 cron 集成."""
    cfg = config or HeartbeatConfig()

    print_info(f"Running heartbeat once for agent: {agent.id}")
    print_info(f"Workspace: {agent.workspace_dir}")
    print_info(f"Prompt: {resolve_heartbeat_prompt(cfg)[:80]}...")
    print()

    result = run_heartbeat_once(agent, session_store, cfg, reason="manual")

    print_info(f"\nResult: {result.status}")
    if result.reason:
        print_info(f"Reason: {result.reason}")
    print_info(f"Duration: {result.duration_ms:.0f}ms")

    last_evt = get_last_heartbeat_event()
    if last_evt:
        print_info(f"Event: {last_evt.status}")
        if last_evt.preview:
            print(f"\n{GREEN}{BOLD}Heartbeat output:{RESET}")
            print(last_evt.preview)
            print()


# ============================================================================
# Part 15: Main Entry Point
# ============================================================================

def main() -> None:
    """主入口点."""
    # 检查环境
    if not os.getenv("DEEPSEEK_API_KEY") and not os.getenv("ANTHROPIC_API_KEY"):
        print(f"{YELLOW}Error: DEEPSEEK_API_KEY or ANTHROPIC_API_KEY not set.{RESET}")
        print(f"{DIM}Please set your API key in .env file.{RESET}")
        sys.exit(1)

    # 确保目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # 初始化 session store
    session_store = S04SessionStore(
        store_path=SESSIONS_DIR / "sessions.json",
        transcript_dir=SESSIONS_DIR / "transcripts",
    )

    # 创建 Agent (带 Soul 和 Memory, 继承自 s06)
    agents = create_agents_with_soul_memory()
    if not agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    default_agent = next(iter(agents.values()))

    # 创建示例 HEARTBEAT.md (如果不存在)
    # 【参考】docs/gateway/heartbeat.md  "HEARTBEAT.md (optional)" section
    hb_path = default_agent.workspace_dir / DEFAULT_HEARTBEAT_FILENAME
    if not hb_path.exists():
        sample_heartbeat = """\
# Heartbeat checklist

- Quick scan: anything urgent in memory or prior conversations?
- If it's daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and note it in memory.
"""
        hb_path.write_text(sample_heartbeat, encoding="utf-8")
        print_info(f"Created sample HEARTBEAT.md at {hb_path}")

    # 创建示例 SOUL.md (如果不存在, 复用 s06 的逻辑)
    if not default_agent.soul_path.exists():
        sample_soul = """\
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" \
and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing \
or boring. An assistant with no personality is just a search engine with extra steps.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. \
Update them. They're how you persist.
"""
        default_agent.soul_path.write_text(sample_soul, encoding="utf-8")
        print_info(f"Created sample SOUL.md at {default_agent.soul_path}")

    # 心跳配置 — 教学默认使用较短间隔以便演示
    heartbeat_config = HeartbeatConfig(
        every=os.getenv("HEARTBEAT_EVERY", "5m"),  # 教学默认 5m 便于演示
        prompt=os.getenv("HEARTBEAT_PROMPT", None),
    )

    # 解析命令行参数
    if len(sys.argv) > 1:
        if sys.argv[1] in ("--repl", ):
            run_repl_with_heartbeat(default_agent, session_store, heartbeat_config)
        elif sys.argv[1] == "--once":
            run_once_mode(default_agent, session_store, heartbeat_config)
        else:
            print(f"Usage: {sys.argv[0]} [--repl|--once]")
            print(f"  --repl   Interactive REPL with background heartbeat")
            print(f"  --once   Run one heartbeat cycle and exit")
            sys.exit(1)
    else:
        # 默认 REPL
        run_repl_with_heartbeat(default_agent, session_store, heartbeat_config)


if __name__ == "__main__":
    main()
