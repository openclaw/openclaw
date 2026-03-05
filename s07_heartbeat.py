"""
Section 08: Heartbeat & Proactive Behavior
"Not just reactive - proactive"

OpenClaw 最独特的特性: heartbeat 系统让 agent 在没有用户消息时也能主动行动.
传统 chatbot 只能被动回复; OpenClaw 的 agent 像一个真正的助手,
会定期 "检查一下" 是否有需要汇报的事情.

在 OpenClaw 中:
  - HeartbeatRunner: 后台定时器, 周期性触发 agent 执行
  - HEARTBEAT.md: 定义心跳时要检查的内容
  - Active Hours: 只在配置的时间窗口内运行 (不在凌晨打扰用户)
  - HEARTBEAT_OK: agent 认为没事可报时的静默信号, 不发送给用户
  - 互斥锁: 心跳让位于用户消息 (主通道优先)
  - 去重: 24小时内不发送重复内容

OpenClaw 的 6 步检查链 (should_run):
  [1] heartbeat 是否启用?
  [2] 间隔是否已过?
  [3] 是否在活跃时段?
  [4] HEARTBEAT.md 是否存在且有内容?
  [5] 主通道是否空闲? (没有正在处理的用户消息)
  [6] agent 当前是否空闲? (没有在运行中)

HEARTBEAT.md 示例 (放在 workspace/ 下):

    # Heartbeat Instructions

    Check the following and report ONLY if action is needed:

    1. Are there any pending reminders for the user?
    2. Review today's memory log for unfinished tasks.
    3. If the user mentioned a deadline, check if it's approaching.

    If nothing needs attention, respond with exactly: HEARTBEAT_OK

架构图:

  +--- HeartbeatRunner (background thread) ---+
  |  every 30s:                                |
  |  [1] enabled?                              |
  |  [2] interval elapsed?                     |
  |  [3] active hours?                         |
  |  [4] HEARTBEAT.md exists?                  |
  |  [5] main lane idle? ---+                  |
  |  [6] not running?       |                  |
  +-------------------------+------------------+
           |                |
           v          (mutual exclusion)
    Run agent with              |
    HEARTBEAT.md context        |
           |                    |
           v                    v
    Response check         User Message
    /            |              |
  HEARTBEAT_OK   Content       v
  (suppress)     |         Agent Loop
                 v         (takes priority)
            Dedup check
                 |
                 v
            Send to channel

运行方式:
    cd openclaw0
    python agents/s07_heartbeat.py

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
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from anthropic import Anthropic

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

# 心跳间隔: 生产环境默认 30 分钟, 演示用 60 秒方便观察
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "60"))

# 活跃时段: 只在这个时间范围内运行心跳 (24小时制)
HEARTBEAT_ACTIVE_START = int(os.getenv("HEARTBEAT_ACTIVE_START", "9"))
HEARTBEAT_ACTIVE_END = int(os.getenv("HEARTBEAT_ACTIVE_END", "22"))

# OpenClaw 中的静默信号: agent 没有需要汇报的内容时返回这个
HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK"

# 去重窗口: 24 小时内不发送相同内容
DEDUP_WINDOW_SECONDS = 24 * 60 * 60

BASE_SYSTEM_PROMPT = (
    "You are a helpful AI assistant running on the openclaw0 framework.\n"
    "Current date and time: {datetime}\n"
    "You have access to memory tools to store and recall information."
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


def colored_prompt() -> str:
    return f"{CYAN}{BOLD}You > {RESET}"


def print_assistant(text: str) -> None:
    print(f"\n{GREEN}{BOLD}Assistant:{RESET} {text}\n")


def print_info(text: str) -> None:
    print(f"{DIM}{text}{RESET}")


def print_tool(name: str, detail: str) -> None:
    print(f"  {MAGENTA}[tool:{name}]{RESET} {DIM}{detail}{RESET}")


def print_heartbeat(text: str) -> None:
    """心跳消息用蓝色标记, 与普通回复区分."""
    print(f"\n{BLUE}{BOLD}[Heartbeat]{RESET} {text}\n")


# ---------------------------------------------------------------------------
# Soul System (复用 s07 的实现)
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
# Memory System (复用 s07 的核心实现)
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
# Heartbeat Runner -- 心跳引擎
# ---------------------------------------------------------------------------
# OpenClaw 的心跳系统是其最独特的设计:
#   - 后台线程周期性检查 "是否有事要做"
#   - 6 步检查链确保不在错误时机运行
#   - HEARTBEAT_OK 机制让 agent 自行判断是否需要汇报
#   - 互斥锁确保不干扰用户对话
#   - 去重避免重复通知
#
# 生产版 OpenClaw 还支持:
#   - cron 表达式定义触发时间
#   - 多 agent 独立心跳配置
#   - 系统事件 (如异步命令完成) 触发特殊心跳
#   - 心跳消息路由到不同渠道
# ---------------------------------------------------------------------------

class HeartbeatRunner:
    """心跳运行器: 让 agent 定期检查并主动汇报.

    核心概念:
      - interval: 检查间隔 (秒)
      - active_hours: 活跃时段 (小时)
      - heartbeat_path: HEARTBEAT.md 路径, 定义检查内容
      - main_lane_lock: 与用户消息互斥的锁
      - dedup_cache: 内容哈希 -> 时间戳, 用于 24h 去重
    """

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

        # 互斥锁: 心跳和用户消息共享这把锁
        # 用户消息处理时持有锁, 心跳尝试获取失败则跳过本轮
        self._lock = threading.Lock()

        # 控制后台线程
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # 心跳产生的消息会放入这个队列, 由主线程输出
        self._output_queue: list[str] = []
        self._output_lock = threading.Lock()

    # -- 6 步检查链 --

    def _is_enabled(self) -> bool:
        """[1] heartbeat 是否启用? 通过文件存在性判断."""
        return self.heartbeat_path.exists()

    def _interval_elapsed(self) -> bool:
        """[2] 距离上次运行是否已过足够时间?"""
        return (time.time() - self.last_run) >= self.interval

    def _is_active_hours(self) -> bool:
        """[3] 当前是否在活跃时段?

        OpenClaw 支持跨午夜的时段 (如 22:00 - 06:00),
        并且支持配置时区. 本节简化为本地时间的小时比较.
        """
        current_hour = datetime.now().hour
        if self.active_start <= self.active_end:
            # 不跨午夜: 09:00 - 22:00
            return self.active_start <= current_hour < self.active_end
        else:
            # 跨午夜: 22:00 - 06:00
            return current_hour >= self.active_start or current_hour < self.active_end

    def _heartbeat_has_content(self) -> bool:
        """[4] HEARTBEAT.md 是否存在且有实质内容?

        OpenClaw 的 isHeartbeatContentEffectivelyEmpty() 会跳过:
        - 纯空行
        - 纯 heading 行 (# xxx)
        - 空 checkbox (- [ ])
        只有真正有指令的行才算 "有内容".
        """
        if not self.heartbeat_path.exists():
            return False
        content = self.heartbeat_path.read_text(encoding="utf-8")
        for line in content.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            # 跳过纯 heading
            if re.match(r"^#+(\s|$)", stripped):
                continue
            # 跳过空 checkbox
            if re.match(r"^[-*+]\s*(\[[\sXx]?\]\s*)?$", stripped):
                continue
            # 有实质内容
            return True
        return False

    def _main_lane_idle(self) -> bool:
        """[5] 主通道是否空闲?

        尝试获取锁 (非阻塞), 获取成功说明没有用户消息在处理.
        注意: 这里获取后立刻释放, 实际运行时还会再获取.

        OpenClaw 通过 CommandLane 的队列深度来判断,
        如果 main lane 有待处理的消息, 心跳让位.
        """
        acquired = self._lock.acquire(blocking=False)
        if acquired:
            self._lock.release()
            return True
        return False

    def should_run(self) -> tuple[bool, str]:
        """6 步检查链, 返回 (是否运行, 原因).

        OpenClaw 的 runHeartbeatOnce() 按相同顺序检查,
        每一步失败都返回 skipped + 具体原因.
        """
        if not self._is_enabled():
            return False, "disabled (no HEARTBEAT.md)"
        if not self._interval_elapsed():
            return False, "interval not elapsed"
        if not self._is_active_hours():
            return False, "outside active hours"
        if not self._heartbeat_has_content():
            return False, "HEARTBEAT.md has no actionable content"
        if not self._main_lane_idle():
            return False, "main lane busy (user message in progress)"
        if self.running:
            return False, "heartbeat already running"
        return True, "ok"

    # -- 去重 --

    def _content_hash(self, content: str) -> str:
        """计算内容哈希, 用于 24h 去重."""
        normalized = content.strip().lower()
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    def is_duplicate(self, content: str) -> bool:
        """检查同样内容是否在 24h 内已发送过.

        OpenClaw 在 heartbeat runner 中维护类似的缓存,
        防止相同的提醒/通知重复发送.
        """
        h = self._content_hash(content)
        now = time.time()

        # 清理过期条目
        expired = [k for k, v in self.dedup_cache.items()
                   if now - v > DEDUP_WINDOW_SECONDS]
        for k in expired:
            del self.dedup_cache[k]

        if h in self.dedup_cache:
            return True

        self.dedup_cache[h] = now
        return False

    # -- 心跳执行 --

    def _strip_heartbeat_ok(self, text: str) -> tuple[bool, str]:
        """检查并剥离 HEARTBEAT_OK 标记.

        OpenClaw 的 stripHeartbeatToken() 更复杂:
        - 处理 HTML/Markdown 包裹 (<b>HEARTBEAT_OK</b>)
        - 处理前后缀 (HEARTBEAT_OK. / HEARTBEAT_OK!!!)
        - 支持 ackMaxChars: 附带少量文字的 OK 也视为静默

        本节简化为: 包含 HEARTBEAT_OK 且无其他实质内容 -> 静默.
        """
        stripped = text.strip()
        if not stripped:
            return True, ""

        # 移除 HEARTBEAT_OK 标记
        without_token = stripped.replace(HEARTBEAT_OK_TOKEN, "").strip()

        # 如果移除后没有实质内容, 认为是静默
        # 允许少量标点残留 (模型可能写 "HEARTBEAT_OK." 之类)
        if not without_token or len(without_token) <= 5:
            return True, ""

        # 有实质内容, 返回去掉标记后的文本
        if HEARTBEAT_OK_TOKEN in stripped:
            return False, without_token
        return False, stripped

    def run_heartbeat_turn(self, agent_fn) -> str | None:
        """执行一次心跳.

        流程:
          1. 加载 HEARTBEAT.md 作为上下文
          2. 调用 agent (带心跳 prompt)
          3. 检查响应:
             - 包含 HEARTBEAT_OK -> 静默, 不输出
             - 有实质内容 -> 去重检查 -> 输出
          4. 返回输出文本, 或 None (静默)
        """
        heartbeat_content = self.heartbeat_path.read_text(encoding="utf-8").strip()

        # 构建心跳 prompt
        # OpenClaw 的默认心跳 prompt:
        # "Read HEARTBEAT.md if it exists. Follow it strictly.
        #  Do not infer or repeat old tasks from prior chats.
        #  If nothing needs attention, reply HEARTBEAT_OK."
        heartbeat_prompt = (
            "This is a scheduled heartbeat check. "
            "Follow the HEARTBEAT.md instructions below strictly.\n"
            "Do NOT infer or repeat old tasks from prior context.\n"
            "If nothing needs attention, respond with exactly: HEARTBEAT_OK\n\n"
            f"--- HEARTBEAT.md ---\n{heartbeat_content}\n--- end ---"
        )

        # 调用 agent
        response_text = agent_fn(heartbeat_prompt)
        if not response_text:
            return None

        # 检查 HEARTBEAT_OK
        is_ok, cleaned = self._strip_heartbeat_ok(response_text)
        if is_ok:
            return None

        # 去重检查
        if self.is_duplicate(cleaned):
            return None

        return cleaned

    # -- 后台线程 --

    def _background_loop(self, agent_fn) -> None:
        """后台心跳循环.

        以 1 秒间隔检查 should_run(), 满足条件时执行心跳.
        这样即使 interval 是 60 秒, 停止信号也能在 1 秒内响应.
        """
        while not self._stop_event.is_set():
            should, reason = self.should_run()
            if should:
                # 尝试获取锁 (与用户消息互斥)
                acquired = self._lock.acquire(blocking=False)
                if not acquired:
                    # 用户消息正在处理, 跳过本轮
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
                    # 心跳失败不应该影响整个系统
                    with self._output_lock:
                        self._output_queue.append(
                            f"[heartbeat error: {exc}]"
                        )
                finally:
                    self.running = False
                    self._lock.release()

            # 每秒检查一次
            self._stop_event.wait(1.0)

    def start(self, agent_fn) -> None:
        """启动后台心跳线程."""
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
        """停止后台心跳线程."""
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
]

TOOL_HANDLERS = {
    "memory_write": lambda p: json.dumps({
        "status": "saved",
        "path": memory_store.write_memory(p.get("content", ""), p.get("category", "general")),
    }),
    "memory_search": lambda p: json.dumps({
        "results": memory_store.search_memory(p.get("query", ""), p.get("top_k", 5)),
    }),
}


# ---------------------------------------------------------------------------
# System Prompt 构建
# ---------------------------------------------------------------------------

soul_system = SoulSystem(WORKSPACE_DIR)


def build_system_prompt() -> str:
    """构建完整 system prompt: soul + base + memory context."""
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

    return prompt


# ---------------------------------------------------------------------------
# Agent 执行函数 (供心跳调用)
# ---------------------------------------------------------------------------
# 心跳需要一个 "agent_fn" -- 输入 prompt, 输出文本回复.
# 这里把它封装成一个可复用的函数, 心跳线程和用户对话都能调用.
# ---------------------------------------------------------------------------

def run_agent_single_turn(prompt: str) -> str:
    """执行单轮 agent 调用 (无工具), 用于心跳.

    心跳场景不需要工具 (检查 + 汇报), 所以只做单轮无工具调用.
    这样可以降低心跳的 token 消耗, 也避免心跳期间写入记忆等副作用.
    """
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
# 核心: Agent 循环 + Heartbeat
# ---------------------------------------------------------------------------
# 最终整合:
#   1. 后台线程运行 HeartbeatRunner, 周期性触发 agent
#   2. 主线程运行交互式 REPL, 处理用户输入
#   3. 两者共享互斥锁, 确保不同时运行
#   4. 主线程在每次等待用户输入前, 检查并输出心跳消息
# ---------------------------------------------------------------------------

def agent_loop(heartbeat: HeartbeatRunner) -> None:
    """主 agent 循环 -- 带 Heartbeat 的 REPL."""

    messages: list[dict] = []

    print_info("=" * 60)
    print_info("  Mini-Claw  |  Section 07: Heartbeat & Proactive Behavior")
    print_info(f"  Model: {MODEL_ID}")
    print_info(f"  Workspace: {WORKSPACE_DIR}")
    print_info(f"  Heartbeat: every {HEARTBEAT_INTERVAL}s "
               f"(active {HEARTBEAT_ACTIVE_START}:00-{HEARTBEAT_ACTIVE_END}:00)")
    print_info("  Type 'quit' or 'exit' to leave.")
    print_info("  Type '/heartbeat' to see heartbeat status.")
    print_info("  Type '/trigger' to manually trigger a heartbeat.")
    print_info("=" * 60)
    print()

    while True:
        # -- 在等待用户输入前, 输出心跳消息 --
        for msg in heartbeat.drain_output():
            print_heartbeat(msg)

        # -- 用户输入 --
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

        # -- 内置命令 --
        if user_input == "/heartbeat":
            should, reason = heartbeat.should_run()
            elapsed = time.time() - heartbeat.last_run
            next_in = max(0, heartbeat.interval - elapsed)
            print(f"\n{BLUE}--- Heartbeat Status ---{RESET}")
            print(f"  Enabled: {heartbeat._is_enabled()}")
            print(f"  Active hours: {heartbeat._is_active_hours()}")
            print(f"  Interval: {heartbeat.interval}s")
            print(f"  Last run: {elapsed:.0f}s ago")
            print(f"  Next in: ~{next_in:.0f}s")
            print(f"  Should run: {should} ({reason})")
            print(f"  Dedup cache: {len(heartbeat.dedup_cache)} entries")
            print(f"  Running: {heartbeat.running}")
            print(f"{BLUE}--- end ---{RESET}\n")
            continue

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
        # 如果心跳正在运行, 这里会等待它完成
        heartbeat._lock.acquire()
        try:
            messages.append({"role": "user", "content": user_input})
            system_prompt = build_system_prompt()

            # Agent 内循环
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
# 入口
# ---------------------------------------------------------------------------

def main() -> None:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print(f"{YELLOW}Error: ANTHROPIC_API_KEY not set.{RESET}")
        print(f"{DIM}Copy .env.example to .env and fill in your key.{RESET}")
        sys.exit(1)

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # 如果 SOUL.md 不存在, 创建示例
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

    # 如果 HEARTBEAT.md 不存在, 创建示例
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

    print_info("")

    # 创建 heartbeat runner
    heartbeat = HeartbeatRunner(
        interval_seconds=HEARTBEAT_INTERVAL,
        active_hours=(HEARTBEAT_ACTIVE_START, HEARTBEAT_ACTIVE_END),
        heartbeat_path=heartbeat_path,
    )

    # 启动后台心跳线程
    heartbeat.start(run_agent_single_turn)
    print_info(f"Heartbeat started (interval={HEARTBEAT_INTERVAL}s)")
    print_info("")

    try:
        agent_loop(heartbeat)
    finally:
        # 停止心跳线程
        heartbeat.stop()
        print_info("Heartbeat stopped.")


if __name__ == "__main__":
    main()
