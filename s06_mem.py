"""
Section 06: Soul System & Memory Integration with Gateway Framework
"Give each agent a soul, let it remember"

【核心特性】
OpenClaw 最具辨识度的两个特性已经在 s05_gateway.py 的基础上完美整合:

1. Soul System -- SOUL.md 人格注入
   - 每个 Agent 拥有独立的 SOUL.md
   - 在 AgentConfig 中定义，影响该 Agent 的性格和语言风格

2. Memory System -- 双层记忆架构
   - Agent 级别 MEMORY.md: 该 Agent 的常驻记忆（长期事实）
   - Agent 级别 memory/*.md: 按日期组织的每日记忆日志
   - Session 隔离: 不同会话的记忆相互独立
   - 搜索: TF-IDF + 余弦相似度的语义搜索

【与 s05_gateway.py 的完整集成】
  本文件在 s05 的多 Agent 框架基础上：
  ✓ 继承 AgentConfig, MessageRouter, SessionStore 等核心组件
  ✓ 为每个 Agent 扩展 Soul 和 Memory 功能
  ✓ 使用 deepseek_chat_with_tools（与 s05 一致）
  ✓ 保留 s04 的完整工具链
  ✓ Session 通过 s04 SessionStore 持久化
  ✓ 多 Agent 路由由 MessageRouter 管理

【架构图】

  ┌── Message 入站 ──┐
  │                  │
  v                  v
  MessageRouter ──────┐  (s05 核心)
  resolve(...)        │
  │                   │
  ├─ Agent ID ────────┤
  │                   ├─ AgentConfig (扩展含 Soul & Memory)
  └─ Session Key      │  ├─ soul_path: SOUL.md
                      │  ├─ memory_dir: Agent's memory/
                      │  └─ tools: [memory_write, memory_search, ...]
                      │
  ┌─ Build System Prompt ─────────────────┐
  │ [SOUL.md 内容]                         │
  │ [Base system prompt]                   │
  │ [MEMORY.md 常驻记忆]                    │
  │ [Recent memory 近期摘要]               │
  └─────────────────────────────────────┘
                      │
                      v
  ┌─ Agent Loop (deepseek_chat_with_tools) ─┐
  │ Tools:                                   │
  │  - memory_write (写入日记)               │
  │  - memory_search (搜索历史记忆)          │
  │  - [其他工具来自 s04 TOOLS_OPENAI]      │
  └──────────────────────────────────────┘
                      │
                      v
  Session 持久化 (SessionStore)

【运行方式】

  1. 启动网关服务器（支持 Memory & Soul）:
     python agents/s06_mem.py --server

  2. 交互式对话（自动测试路由和记忆）:
     python agents/s06_mem.py --chat

  3. REPL（本地测试，无需网关）:
     python agents/s06_mem.py --repl

【依赖】
  pip install python-dotenv websockets
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import asyncio
import json
import math
import os
import re
import sys
import time
import uuid
import logging
from collections import Counter
from datetime import date, datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection
from dotenv import load_dotenv

# 导入 s05_gateway.py 的核心组件
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

# 从 s05 导入路由和网关框架
from s05_gateway import (
    AgentConfig,
    Binding,
    MessageRouter,
    build_session_key,
    RoutingGateway,
    load_routing_config,
    make_result,
    make_error,
    make_event,
)

# 从 s04 导入工具和 session 管理
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

# LLM 配置（与 s05 一致）
MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat")

# 网关配置
GATEWAY_HOST = os.getenv("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "18789"))
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")

# workspace 根目录
WORKSPACE_DIR = Path(__file__).resolve().parent.parent / "workspace"
SESSIONS_DIR = WORKSPACE_DIR / ".sessions"

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway-with-memory")

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
BLUE = "\033[34m"


def colored_prompt() -> str:
    return f"{CYAN}{BOLD}You > {RESET}"


def print_assistant(text: str) -> None:
    print(f"\n{GREEN}{BOLD}Assistant:{RESET} {text}\n")


def print_info(text: str) -> None:
    print(f"{DIM}{text}{RESET}")


def print_tool(name: str, detail: str) -> None:
    print(f"  {MAGENTA}[tool:{name}]{RESET} {DIM}{detail}{RESET}")


def print_agent(agent_id: str) -> None:
    """打印当前 Agent 信息"""
    print(f"{BLUE}[Agent: {agent_id}]{RESET}")


# ---------------------------------------------------------------------------
# Part 1: Extended AgentConfig with Soul & Memory
# ---------------------------------------------------------------------------

@dataclass
class AgentWithSoulMemory(AgentConfig):
    """
    扩展 s05 的 AgentConfig，增加 Soul 和 Memory 功能。

    每个 Agent 可以有独立的：
    - SOUL.md: 定义该 Agent 的人格、价值观、说话风格
    - memory/: 该 Agent 的记忆目录
    - MEMORY.md: 该 Agent 的常驻记忆
    """
    soul_path: Path | None = None          # SOUL.md 路径
    memory_root: Path | None = None        # memory/ 目录路径

    def __post_init__(self) -> None:
        """初始化 Soul 和 Memory 路径"""
        if self.soul_path is None:
            self.soul_path = WORKSPACE_DIR / f"{self.id}_SOUL.md"
        if self.memory_root is None:
            self.memory_root = WORKSPACE_DIR / f"{self.id}_memory"


# ---------------------------------------------------------------------------
# Part 2: Soul System -- 人格注入
# ---------------------------------------------------------------------------

class SoulSystem:
    """Agent 人格加载器，支持每个 Agent 独立的 SOUL.md。

    OpenClaw 的做法:
      1. 每个 Agent 有独立的 SOUL.md (如 alice_SOUL.md)
      2. 加载后作为该 Agent system prompt 的最前面部分注入
      3. 影响该 Agent 的说话风格、价值观、思维方式
      4. 多个 Agent 可以有完全不同的人格
    """

    def __init__(self, soul_path: Path):
        self.soul_path = soul_path

    def load_soul(self) -> str:
        """加载 SOUL.md 内容。文件不存在则返回空字符串。"""
        if self.soul_path.exists():
            try:
                content = self.soul_path.read_text(encoding="utf-8").strip()
                return content
            except Exception as e:
                log.warning(f"Failed to load soul from {self.soul_path}: {e}")
                return ""
        return ""

    def build_system_prompt(self, base_prompt: str) -> str:
        """组合 soul + base system prompt。

        最终结构:
          [SOUL.md 内容]
          ---
          [Base system prompt]

        人格定义在最前面，优先级最高，影响整个对话的 context.
        """
        soul = self.load_soul()
        if soul:
            return f"{soul}\n\n---\n\n{base_prompt}"
        return base_prompt


# ---------------------------------------------------------------------------
# Part 3: Memory System -- 双层记忆
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    """简单分词：转小写，按非字母数字拆分，去掉短词。"""
    tokens = re.findall(r"[a-z0-9\u4e00-\u9fff]+", text.lower())
    return [t for t in tokens if len(t) > 1]


def _cosine_similarity(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    """计算两个稀疏向量的余弦相似度。"""
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
    """Agent 级别的双层记忆存储。

    架构:
      workspace/
        {agent_id}_MEMORY.md        <-- Agent 的常驻记忆
        {agent_id}_memory/
          2026-02-24.md             <-- 该 Agent 的每日记忆
          2026-02-23.md
          ...

    每个 Agent 有独立的记忆空间，不会互相污染。
    """

    def __init__(self, memory_root: Path):
        self.memory_root = memory_root
        self.evergreen_path = memory_root / "MEMORY.md"
        self.daily_dir = memory_root / "memory"
        # 确保目录存在
        self.daily_dir.mkdir(parents=True, exist_ok=True)

    # -- 写入 --

    def write_memory(self, content: str, category: str = "general") -> str:
        """写入当天的记忆文件。

        Agent 通过 memory_write 工具调用此方法。
        每条记忆带时间戳和分类标签，追加到当天的日志文件。

        返回写入路径，方便 agent 告知用户。
        """
        today = date.today().isoformat()
        path = self.daily_dir / f"{today}.md"

        timestamp = datetime.now().strftime("%H:%M:%S")
        entry = f"\n## [{timestamp}] {category}\n\n{content}\n"

        # 如果文件不存在，写入日期标题
        if not path.exists():
            header = f"# Memory Log: {today}\n"
            path.write_text(header, encoding="utf-8")

        # 追加记忆条目
        with open(path, "a", encoding="utf-8") as f:
            f.write(entry)

        # 返回相对路径，可用于日志记录
        rel_path = path.relative_to(WORKSPACE_DIR)
        return str(rel_path)

    # -- 读取 --

    def load_evergreen(self) -> str:
        """加载 MEMORY.md 常驻记忆。"""
        if self.evergreen_path.exists():
            try:
                return self.evergreen_path.read_text(encoding="utf-8").strip()
            except Exception as e:
                log.warning(f"Failed to load evergreen memory: {e}")
                return ""
        return ""

    def get_recent_memories(self, days: int = 7) -> list[dict]:
        """获取最近 N 天的记忆。

        返回 [{path, date, content}] 列表，按日期倒序。
        """
        results = []
        today = date.today()
        for i in range(days):
            d = today - timedelta(days=i)
            path = self.daily_dir / f"{d.isoformat()}.md"
            if path.exists():
                try:
                    content = path.read_text(encoding="utf-8").strip()
                    rel_path = path.relative_to(WORKSPACE_DIR)
                    results.append({
                        "path": str(rel_path),
                        "date": d.isoformat(),
                        "content": content,
                    })
                except Exception as e:
                    log.warning(f"Failed to read memory file {path}: {e}")
        return results

    # -- 搜索 --

    def _load_all_chunks(self) -> list[dict]:
        """加载所有记忆文件，拆分成段落 (chunk)。

        每个 chunk 是一个 {path, text, line_start, line_end} 字典。
        使用按 markdown heading 拆分的策略，保持逻辑清晰。
        """
        chunks = []

        # 加载 MEMORY.md（常驻记忆）
        if self.evergreen_path.exists():
            try:
                content = self.evergreen_path.read_text(encoding="utf-8")
                rel_path = self.evergreen_path.relative_to(WORKSPACE_DIR)
                for chunk in self._split_by_heading(content, str(rel_path)):
                    chunks.append(chunk)
            except Exception as e:
                log.warning(f"Failed to load evergreen memory chunks: {e}")

        # 加载所有每日记忆文件
        if self.daily_dir.exists():
            for md_file in sorted(self.daily_dir.glob("*.md"), reverse=True):
                try:
                    content = md_file.read_text(encoding="utf-8")
                    rel_path = md_file.relative_to(WORKSPACE_DIR)
                    for chunk in self._split_by_heading(content, str(rel_path)):
                        chunks.append(chunk)
                except Exception as e:
                    log.warning(f"Failed to load memory file {md_file}: {e}")

        return chunks

    @staticmethod
    def _split_by_heading(content: str, path: str) -> list[dict]:
        """按 markdown heading 拆分文本为 chunk。"""
        lines = content.split("\n")
        chunks = []
        current_lines: list[str] = []
        current_start = 1

        for i, line in enumerate(lines):
            # 遇到 heading 开始新 chunk
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

        # 最后一个 chunk
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
        """搜索记忆，返回最相关的 top_k 个结果。

        使用 TF-IDF + 余弦相似度:
          1. 对所有记忆 chunk 建立词频统计
          2. 计算 IDF (逆文档频率)
          3. 对 query 和每个 chunk 计算 TF-IDF 向量
          4. 用余弦相似度排序

        OpenClaw 生产版用 embedding model (如 text-embedding-3-small)
        把文本映射到高维向量，再用 sqlite-vec 做近似最近邻搜索。
        TF-IDF 是一个合理的教学替代：原理相同 (文本 -> 向量 -> 相似度)，
        只是向量质量不如 embedding。
        """
        chunks = self._load_all_chunks()
        if not chunks:
            return []

        # 建立文档集合的词频
        doc_freq: Counter = Counter()
        chunk_tokens_list = []
        for chunk in chunks:
            tokens = _tokenize(chunk["text"])
            unique_tokens = set(tokens)
            for t in unique_tokens:
                doc_freq[t] += 1
            chunk_tokens_list.append(tokens)

        n_docs = len(chunks)

        # 计算 IDF
        def _idf(term: str) -> float:
            df = doc_freq.get(term, 0)
            if df == 0:
                return 0.0
            return math.log(n_docs / df)

        # query 的 TF-IDF 向量
        query_tokens = _tokenize(query)
        query_tf = Counter(query_tokens)
        query_vec = {t: (count / max(len(query_tokens), 1)) * _idf(t)
                     for t, count in query_tf.items()}

        # 对每个 chunk 计算相似度
        scored = []
        for i, chunk in enumerate(chunks):
            tokens = chunk_tokens_list[i]
            if not tokens:
                continue
            tf = Counter(tokens)
            chunk_vec = {t: (count / len(tokens)) * _idf(t)
                         for t, count in tf.items()}
            score = _cosine_similarity(query_vec, chunk_vec)
            if score > 0.01:  # 过滤掉几乎不相关的结果
                scored.append({
                    "path": chunk["path"],
                    "line_start": chunk["line_start"],
                    "line_end": chunk["line_end"],
                    "score": round(score, 4),
                    "snippet": chunk["text"][:300],
                })

        # 按相似度排序，取 top_k
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]


# ---------------------------------------------------------------------------
# Part 4: 扩展工具 -- Memory tools for agents
# ---------------------------------------------------------------------------

def build_memory_tools() -> list[dict]:
    """构建 memory 工具定义。

    这些工具会被添加到 s04 的 TOOLS_OPENAI 中，
    每个 Agent 在调用时会独立操作自己的 MemoryStore。
    """
    return [
        {
            "name": "memory_write",
            "description": (
                "Write a memory to persistent storage. Use this to remember important "
                "information the user shares: preferences, facts, decisions, names, dates. "
                "Each memory is timestamped and categorized."
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
                        "description": (
                            "Category tag for the memory. Examples: "
                            "preference, fact, decision, todo, person."
                        ),
                    },
                },
                "required": ["content"],
            },
        },
        {
            "name": "memory_search",
            "description": (
                "Search through stored memories using keyword matching. "
                "Use this before answering questions about prior conversations, "
                "user preferences, past decisions, or any previously discussed topics. "
                "Returns relevant memory snippets with source paths and relevance scores."
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
                        "description": "Max number of results to return. Default 5.",
                    },
                },
                "required": ["query"],
            },
        },
    ]


# 全局 memory store 缓存（按 agent_id 索引）
_memory_stores: dict[str, MemoryStore] = {}


def get_memory_store(agent_id: str, memory_root: Path) -> MemoryStore:
    """获取或创建 Agent 的 MemoryStore。"""
    if agent_id not in _memory_stores:
        _memory_stores[agent_id] = MemoryStore(memory_root)
    return _memory_stores[agent_id]


def handle_memory_tool(
    tool_name: str,
    params: dict,
    agent_id: str,
    memory_root: Path,
) -> str:
    """处理 memory 工具调用。

    参数:
        tool_name: 工具名称 ("memory_write" 或 "memory_search")
        params: 工具参数
        agent_id: 调用该工具的 Agent ID
        memory_root: 该 Agent 的 memory 根目录

    返回:
        JSON 格式的工具执行结果
    """
    store = get_memory_store(agent_id, memory_root)

    if tool_name == "memory_write":
        content = params.get("content", "")
        category = params.get("category", "general")
        if not content.strip():
            return json.dumps({"error": "Empty content"})
        path = store.write_memory(content, category)
        return json.dumps({
            "status": "saved",
            "path": path,
            "category": category,
        })

    elif tool_name == "memory_search":
        query = params.get("query", "")
        top_k = params.get("top_k", 5)
        if not query.strip():
            return json.dumps({"results": [], "error": "Empty query"})
        results = store.search_memory(query, top_k=top_k)
        return json.dumps({
            "results": results,
            "total_found": len(results),
        })

    else:
        return json.dumps({"error": f"Unknown memory tool: {tool_name}"})


# ---------------------------------------------------------------------------
# Part 5: System Prompt 构建（融合 Soul + Memory）
# ---------------------------------------------------------------------------

def build_agent_system_prompt(agent: AgentWithSoulMemory, base_prompt: str) -> str:
    """构建完整的 Agent system prompt，融合 soul + base + memory。

    分层结构:
      [SOUL.md 内容]           <-- 人格定义（最高优先级）
      ---
      [Base system prompt]     <-- 功能说明
      ---
      ## Evergreen Memory      <-- 常驻记忆
      [MEMORY.md 内容]
      ---
      ## Recent Memory Context <-- 近期记忆摘要
      [最近 3 天的记忆片段]

    参数:
        agent: 扩展的 AgentWithSoulMemory
        base_prompt: 基础 system prompt（来自 s04）

    返回:
        完整的 system prompt
    """
    # 加载该 Agent 的 Soul
    soul_system = SoulSystem(agent.soul_path)
    prompt = soul_system.build_system_prompt(base_prompt)

    # 加载该 Agent 的常驻记忆
    memory_store = get_memory_store(agent.id, agent.memory_root)
    evergreen = memory_store.load_evergreen()
    if evergreen:
        prompt += f"\n\n---\n\n## Evergreen Memory\n\n{evergreen}"

    # 加载近期记忆摘要 (最近 3 天)
    recent = memory_store.get_recent_memories(days=3)
    if recent:
        prompt += "\n\n---\n\n## Recent Memory Context\n"
        for entry in recent:
            snippet = entry["content"][:500]
            prompt += f"\n### {entry['date']}\n{snippet}\n"

    return prompt


# ---------------------------------------------------------------------------
# Part 6: Agent Runner with Soul & Memory Integration
# ---------------------------------------------------------------------------

def run_agent_with_soul_and_memory(
    agent: AgentWithSoulMemory,
    session_store: S04SessionStore,
    session_key: str,
    user_text: str,
) -> str:
    """
    处理一轮用户输入，调用 LLM（含工具循环和记忆操作），返回最终文本回复。

    与 s05 的 run_agent_with_tools 一致，但增加:
    - Soul system prompt 注入
    - Memory 工具支持（memory_write, memory_search）
    - Memory store 初始化

    参数:
        agent: AgentWithSoulMemory 配置
        session_store: s04 SessionStore，持久化会话
        session_key: 会话键
        user_text: 用户输入

    返回:
        助手的最终文本回复
    """
    # 确保 Agent 的 memory 目录存在
    agent.memory_root.mkdir(parents=True, exist_ok=True)

    # 加载会话历史
    session_data = session_store.load_session(session_key)
    messages = session_data["history"]
    messages.append({"role": "user", "content": user_text})

    # 构建融合 Soul + Memory 的 system prompt
    # 基础提示包括当前日期和工具说明
    base_prompt = f"{S04_SYSTEM_PROMPT}\nCurrent date: {date.today().isoformat()}\nPersonality: {agent.system_prompt}"
    system_prompt = build_agent_system_prompt(agent, base_prompt)

    # 组合工具：s04 的工具 + memory 工具
    all_tools = TOOLS_OPENAI + build_memory_tools()

    all_assistant_blocks: list = []

    # Agent 内循环：处理可能的连续工具调用
    while True:
        resp = deepseek_chat_with_tools(
            messages,
            all_tools,
            model=agent.model,
            system_prompt=system_prompt,
            max_tokens=4096,
        )

        content = resp.get("content") or ""
        tool_calls = resp.get("tool_calls") or []
        finish_reason = resp.get("finish_reason") or "stop"

        if content:
            all_assistant_blocks.append({"type": "text", "text": content})

        for tc in tool_calls:
            try:
                tc_args = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"]
            except json.JSONDecodeError:
                tc_args = {}
            all_assistant_blocks.append({
                "type": "tool_use",
                "id": tc["id"],
                "name": tc["name"],
                "input": tc_args,
            })

        if tool_calls:
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

                log.info("  [tool] %s(%s)", tc["name"], json.dumps(args, ensure_ascii=False)[:80])

                # 特殊处理 memory 工具
                if tc["name"] in ("memory_write", "memory_search"):
                    result = handle_memory_tool(
                        tc["name"],
                        args,
                        agent_id=agent.id,
                        memory_root=agent.memory_root,
                    )
                else:
                    # 委派给 s04 的工具处理器
                    result = process_tool_call(tc["name"], args)

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                }
                messages.append(tool_msg)

                all_assistant_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": tc["id"],
                    "output": result,
                })

            continue

        if content:
            messages.append({"role": "assistant", "content": content})
        final_text = content
        break

    # 持久化会话
    session_store.save_turn(session_key, user_text, all_assistant_blocks)
    return final_text


# ---------------------------------------------------------------------------
# Part 7: Configuration & Agent Creation
# ---------------------------------------------------------------------------

def create_agents_with_soul_memory(
    config_path: str | None = None,
) -> dict[str, AgentWithSoulMemory]:
    """
    从配置加载 Agent，并扩展为 AgentWithSoulMemory。

    参数:
        config_path: 配置文件路径（可选）

    返回:
        {agent_id: AgentWithSoulMemory} 字典
    """
    agents, _, _, _ = load_routing_config(config_path)

    # 转换为 AgentWithSoulMemory
    agents_with_memory: dict[str, AgentWithSoulMemory] = {}
    for agent_id, agent in agents.items():
        agent_mem = AgentWithSoulMemory(
            id=agent.id,
            model=agent.model,
            system_prompt=agent.system_prompt,
            tools=agent.tools,
        )
        agents_with_memory[agent_id] = agent_mem
        log.info(f"Created agent {agent_id} with soul and memory")

    return agents_with_memory


# ---------------------------------------------------------------------------
# Part 8: Run Modes (REPL, Chat, Server)
# ---------------------------------------------------------------------------

def run_repl(agent: AgentWithSoulMemory, session_store: S04SessionStore) -> None:
    """
    交互式 REPL 模式（单 Agent）。

    用于本地测试 Soul 和 Memory 功能，无需网关。
    """
    session_key = f"repl:{agent.id}:local"

    print_info("=" * 70)
    print_info(f"  Mini-Claw REPL  |  Section 06: Soul & Memory")
    print_info(f"  Agent: {agent.id}")
    print_info(f"  Model: {agent.model}")
    print_info(f"  Workspace: {WORKSPACE_DIR}")
    print_info("")
    print_info("  Commands:")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current soul")
    print_info("    /memory            - View memory status")
    print_info("=" * 70)
    print()

    # 显示 Soul 状态
    soul_system = SoulSystem(agent.soul_path)
    soul_content = soul_system.load_soul()
    if soul_content:
        print_info(f"Soul loaded from {agent.soul_path}")
        first_line = soul_content.split("\n")[0].strip()
        print_info(f"Preview: {first_line}\n")
    else:
        print_info(f"No soul found at {agent.soul_path}")
        print_info("Create one to give this agent personality!\n")

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

        # 内置命令
        if user_input == "/soul":
            soul = soul_system.load_soul()
            if soul:
                print(f"\n{MAGENTA}--- {agent.id.upper()} SOUL ---{RESET}")
                print(soul)
                print(f"{MAGENTA}--- end ---{RESET}\n")
            else:
                print_info(f"No soul file at {agent.soul_path}\n")
            continue

        if user_input == "/memory":
            memory_store = get_memory_store(agent.id, agent.memory_root)
            evergreen = memory_store.load_evergreen()
            recent = memory_store.get_recent_memories(days=7)
            print(f"\n{MAGENTA}--- Memory Status ({agent.id}) ---{RESET}")
            if evergreen:
                print(f"MEMORY.md: {len(evergreen)} chars")
            else:
                print("MEMORY.md: (not found)")
            print(f"Recent daily logs: {len(recent)} files")
            for entry in recent:
                lines = entry["content"].count("\n") + 1
                print(f"  {entry['date']}: {lines} lines")
            print(f"{MAGENTA}--- end ---{RESET}\n")
            continue

        # 处理用户输入
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


def main() -> None:
    """主入口点。"""
    # 检查环境
    if not os.getenv("DEEPSEEK_API_KEY") and not os.getenv("ANTHROPIC_API_KEY"):
        print(f"{YELLOW}Error: DEEPSEEK_API_KEY or ANTHROPIC_API_KEY not set.{RESET}")
        print(f"{DIM}Please set your API key in .env file.{RESET}")
        sys.exit(1)

    # 确保 workspace 和 sessions 目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # 初始化 session store
    session_store = S04SessionStore(SESSIONS_DIR)

    # 创建 Agent（带 Soul 和 Memory）
    agents = create_agents_with_soul_memory()
    if not agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    # 默认使用第一个 Agent
    default_agent = next(iter(agents.values()))

    # 创建示例 SOUL 文件（如果不存在）
    if not default_agent.soul_path.exists():
        sample_soul = (
            "# Soul\n\n"
            "You are Koda, a thoughtful AI assistant.\n\n"
            "## Personality\n"
            "- Warm but not overly enthusiastic\n"
            "- Prefer concise, clear explanations\n"
            "- Use analogies from nature and engineering\n\n"
            "## Values\n"
            "- Honesty over comfort\n"
            "- Depth over breadth\n"
            "- Action over speculation\n\n"
            "## Language Style\n"
            "- Direct and clear\n"
            "- No filler phrases\n"
            "- End complex explanations with a one-line summary\n"
        )
        default_agent.soul_path.write_text(sample_soul, encoding="utf-8")
        print_info(f"Created sample SOUL file for {default_agent.id}")

    # 解析命令行参数
    if len(sys.argv) > 1:
        if sys.argv[1] == "--repl":
            run_repl(default_agent, session_store)
        elif sys.argv[1] == "--chat":
            # TODO: 交互式聊天模式（多 Agent）
            print("Chat mode not yet implemented. Using REPL instead.")
            run_repl(default_agent, session_store)
        elif sys.argv[1] == "--server":
            # TODO: WebSocket 网关服务器模式
            print("Server mode not yet implemented. Using REPL instead.")
            run_repl(default_agent, session_store)
        else:
            print(f"Usage: {sys.argv[0]} [--repl|--chat|--server]")
            sys.exit(1)
    else:
        # 默认使用 REPL 模式
        run_repl(default_agent, session_store)


if __name__ == "__main__":
    main()
