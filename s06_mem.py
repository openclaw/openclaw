"""
Section 06 — Soul & Memory
"Give it a soul, let it remember"

本文件在 s05_gateway 的网关 + 路由框架之上, 加入 OpenClaw 最具辨识度的两层:

  1. Soul System
     - 每个 Agent 拥有独立的 workspace, 内含 SOUL.md
     - SOUL.md 作为 "project context file" 注入 system prompt
     - 【参考】src/agents/workspace.ts  loadWorkspaceBootstrapFiles()
     - 【参考】src/agents/system-prompt.ts  buildAgentSystemPrompt()

  2. Memory System
     - 双层 Markdown 记忆: MEMORY.md (长期) + memory/YYYY-MM-DD.md (每日)
     - 工具: memory_search (语义搜索) + memory_get (精确行读取)
     - 搜索: TF-IDF + BM25 keyword 的混合检索 (教学简化, 对标 hybrid search)
     - 刷新: 简化版 memory flush — session 过长时自动提醒写入记忆
     - 【参考】src/memory/manager.ts
     - 【参考】src/agents/tools/memory-tool.ts
     - 【参考】docs/concepts/memory.md

  ── 架构图 ──────────────────────────────────────

  Message 入站
      │
      v
  MessageRouter.resolve()           ← s05_gateway
      ├─ AgentConfig  ──┐
      └─ session_key    │
                        v
  Agent workspace/              ← 本文件新增
      ├─ SOUL.md                  人格
      ├─ MEMORY.md                长期记忆
      └─ memory/YYYY-MM-DD.md    每日记忆

  buildAgentSystemPrompt()
      │  ┌──────────────────────────────────────────┐
      │  │ 1. Base system prompt (identity+tools)   │
      │  │ 2. ## Memory Recall (mandatory step)     │
      │  │ 3. ## Time / Workspace                   │
      │  │ 4. ## Project Context Files              │
      │  │    ├ SOUL.md  (embody its persona)       │
      │  │    └ MEMORY.md (long-term reference)     │
      │  └──────────────────────────────────────────┘
      v
  run_agent_with_soul_and_memory()
      Tools = s04 tools + memory_search + memory_get
      │
      v
  SessionStore.save_turn()          ← s04

  ── 运行方式 (与 s05_gateway 完全对齐, 且增加 Soul/Memory) ──

  1. 服务器模式 (启动带 Soul+Memory 的网关):
     python agents/s06_mem.py

  2. 测试客户端 (自动化演示路由 + Soul/Memory):
     python agents/s06_mem.py --test-client

  3. 交互式对话 (自由提问, 验证 Soul/Memory + 会话记录和工具调用):
     python agents/s06_mem.py --chat

  4. 交互式 REPL (本地测试路由 + Soul/Memory, 无需网关):
     python agents/s06_mem.py --repl

  ── 依赖 ──────────────────────────────────────────
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

# 从 s05 导入路由框架 + 网关基础设施 (gateway/session 机制不变)
from s05_gateway import (
    AgentConfig,
    Binding,
    MessageRouter,
    build_session_key,
    load_routing_config,
    # JSON-RPC 协议
    JSONRPC_VERSION,
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INTERNAL_ERROR,
    AUTH_ERROR,
    make_result,
    make_error,
    make_event,
    # 客户端状态
    ConnectedClient,
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


# ============================================================================
# Part 1: Agent Workspace — 每个 Agent 拥有独立的 workspace
# ============================================================================
#
# 【参考】OpenClaw src/agents/agent-scope.ts  resolveAgentWorkspaceDir()
#
# 原始 OpenClaw 的做法:
#   默认 Agent  → ~/.openclaw/workspace/
#   其他 Agent  → ~/.openclaw/state/workspace-{agentId}/
#
# 每个 workspace 的文件布局:
#   SOUL.md              人格 (bootstrap file)
#   MEMORY.md            长期记忆 (bootstrap file, 也被 memory_search 索引)
#   memory/              每日记忆目录
#     YYYY-MM-DD.md      每日追加日志
#
# 教学版: workspace/{agentId}/  作为每个 Agent 的独立根.
# ============================================================================


@dataclass
class AgentWithSoulMemory(AgentConfig):
    """扩展 s05 AgentConfig, 为每个 Agent 加入独立 workspace.

    workspace_dir 是该 Agent 的文件根, 里面放 SOUL.md / MEMORY.md / memory/ .
    """
    workspace_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.workspace_dir is None:
            self.workspace_dir = WORKSPACE_DIR / self.id
        # 确保目录存在
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        (self.workspace_dir / "memory").mkdir(exist_ok=True)

    # 便捷属性 — 与原始 OpenClaw workspace 一致的路径
    @property
    def soul_path(self) -> Path:
        return self.workspace_dir / "SOUL.md"

    @property
    def memory_md_path(self) -> Path:
        return self.workspace_dir / "MEMORY.md"

    @property
    def memory_dir(self) -> Path:
        return self.workspace_dir / "memory"


# ============================================================================
# Part 2: Workspace Bootstrap — 加载 project context files
# ============================================================================
#
# 【参考】OpenClaw src/agents/workspace.ts  loadWorkspaceBootstrapFiles()
# 【参考】OpenClaw src/agents/system-prompt.ts  lines 562-571
#
# 原始 OpenClaw 的 bootstrap file 加载顺序:
#   AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md
#   → HEARTBEAT.md → BOOTSTRAP.md → MEMORY.md
#
# 注入规则:
#   - 每个文件最大 bootstrapMaxChars (默认 20000)
#   - 超出时截断: 保留 70% head + 20% tail
#   - 总注入量不超过 bootstrapTotalMaxChars (默认 24000)
#   - Sub-agent 只拿 AGENTS.md + TOOLS.md (SOUL.md 被过滤)
#
# 教学版只处理 SOUL.md 和 MEMORY.md 两个核心文件.
# ============================================================================

# 默认限制, 与原始 OpenClaw 一致
BOOTSTRAP_MAX_CHARS = 20_000       # 单文件最大字符数
BOOTSTRAP_TOTAL_MAX_CHARS = 24_000 # 所有文件总字符数


def _truncate_bootstrap(content: str, max_chars: int = BOOTSTRAP_MAX_CHARS) -> str:
    """截断 bootstrap file: 保留 70% head + 20% tail.

    【参考】OpenClaw src/agents/pi-embedded-helpers/bootstrap.ts
    """
    if len(content) <= max_chars:
        return content
    head_budget = int(max_chars * 0.70)
    tail_budget = int(max_chars * 0.20)
    head = content[:head_budget]
    tail = content[-tail_budget:] if tail_budget > 0 else ""
    return f"{head}\n\n[...truncated...]\n\n{tail}"


def load_workspace_bootstrap_files(workspace_dir: Path) -> list[dict[str, str]]:
    """加载 workspace 中的 bootstrap files.

    返回 [{name, content}] 列表, 按原始 OpenClaw 的加载顺序.
    只处理 SOUL.md 和 MEMORY.md — 教学版的核心两个文件.
    """
    files: list[dict[str, str]] = []
    total_chars = 0

    for name in ("SOUL.md", "MEMORY.md"):
        path = workspace_dir / name
        if not path.exists():
            continue
        if path.is_symlink():
            # 【参考】原始 OpenClaw 拒绝 symlink
            log.warning("Skipping symlink: %s", path)
            continue
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except Exception as e:
            log.warning("Failed to read %s: %s", path, e)
            continue
        if not raw:
            continue

        content = _truncate_bootstrap(raw)
        if total_chars + len(content) > BOOTSTRAP_TOTAL_MAX_CHARS:
            budget = max(0, BOOTSTRAP_TOTAL_MAX_CHARS - total_chars)
            if budget <= 0:
                break
            content = _truncate_bootstrap(raw, budget)
        files.append({"name": name, "content": content})
        total_chars += len(content)

    return files


# ============================================================================
# Part 3: Memory Index Manager — 双层记忆 + 混合搜索
# ============================================================================
#
# 【参考】OpenClaw src/memory/manager.ts
# 【参考】OpenClaw src/memory/internal.ts (MemoryChunk)
# 【参考】docs/concepts/memory.md  "Hybrid search"
#
# 原始 OpenClaw 的搜索架构:
#   1. 分块: ~400 tokens, 80 token overlap
#   2. 向量搜索: embedding + cosine similarity (权重 0.7)
#   3. 关键词搜索: FTS5 BM25 ranking (权重 0.3)
#   4. 混合: finalScore = 0.7 * vectorScore + 0.3 * textScore
#   5. 默认: maxResults=6, minScore=0.35, maxSnippetChars=700
#
# 教学简化:
#   - TF-IDF cosine 代替 embedding (向量搜索)
#   - BM25-like keyword match 代替 FTS5 (关键词搜索)
#   - 混合权重相同: 0.7 / 0.3
#   - 分块: 按 markdown heading 拆分 (简化, 但逻辑等效)
# ============================================================================

# --- 混合搜索配置 (对标 OpenClaw defaults) ---
SEARCH_MAX_RESULTS = 6
SEARCH_MIN_SCORE = 0.35
SEARCH_MAX_SNIPPET_CHARS = 700
HYBRID_VECTOR_WEIGHT = 0.7
HYBRID_TEXT_WEIGHT = 0.3
HYBRID_CANDIDATE_MULTIPLIER = 4


def _tokenize(text: str) -> list[str]:
    """分词: 小写 + 按非字母数字拆分. 保留中文单字和英文 2+ 字符."""
    return [t for t in re.findall(r"[a-z0-9\u4e00-\u9fff]+", text.lower())
            if len(t) > 1 or "\u4e00" <= t <= "\u9fff"]


def _cosine_sim(a: dict[str, float], b: dict[str, float]) -> float:
    """稀疏向量余弦相似度."""
    common = set(a) & set(b)
    if not common:
        return 0.0
    dot = sum(a[k] * b[k] for k in common)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def _bm25_score(query_tokens: list[str], doc_tokens: list[str],
                doc_freq: Counter, n_docs: int,
                k1: float = 1.2, b: float = 0.75, avgdl: float = 100.0) -> float:
    """单文档 BM25 分数 (Okapi BM25).

    【参考】OpenClaw 用 SQLite FTS5 内置的 BM25; 这里手写等效公式.
    """
    dl = len(doc_tokens)
    tf_doc = Counter(doc_tokens)
    score = 0.0
    for term in set(query_tokens):
        tf = tf_doc.get(term, 0)
        if tf == 0:
            continue
        df = doc_freq.get(term, 0)
        idf = math.log((n_docs - df + 0.5) / (df + 0.5) + 1.0)
        tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / max(avgdl, 1)))
        score += idf * tf_norm
    return score


class MemoryIndexManager:
    """Agent 的记忆索引管理器.

    对标 OpenClaw MemoryIndexManager (src/memory/manager.ts).

    目录结构 (agent workspace 内):
      MEMORY.md          长期记忆 (curated, 可选)
      memory/
        2026-03-04.md    每日追加日志
        2026-03-03.md
        ...

    搜索流程:
      1. 收集所有 .md 文件 → 拆分为 chunk
      2. TF-IDF 向量搜索 (代替 embedding)
      3. BM25 关键词搜索 (代替 FTS5)
      4. 混合: 0.7 * vectorScore + 0.3 * textScore
      5. 过滤 minScore, 截取 maxResults
    """

    def __init__(self, workspace_dir: Path):
        self.workspace_dir = workspace_dir
        self.memory_md = workspace_dir / "MEMORY.md"
        self.memory_dir = workspace_dir / "memory"
        self.memory_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 写入

    def write_daily(self, content: str, category: str = "general") -> str:
        """追加到今天的 memory/YYYY-MM-DD.md.

        【参考】docs/concepts/memory.md — "When to write memory"
        每日日志是 append-only 的.
        """
        today = date.today().isoformat()
        path = self.memory_dir / f"{today}.md"

        ts = datetime.now().strftime("%H:%M:%S")
        entry = f"\n## [{ts}] {category}\n\n{content}\n"

        if not path.exists():
            path.write_text(f"# Memory Log: {today}\n", encoding="utf-8")
        with open(path, "a", encoding="utf-8") as f:
            f.write(entry)

        return f"memory/{today}.md"

    # ------------------------------------------------------------------ 读取

    def read_file(self, rel_path: str,
                  from_line: int | None = None,
                  n_lines: int | None = None) -> dict:
        """安全读取 workspace 内的记忆文件.

        【参考】OpenClaw src/agents/tools/memory-tool.ts  createMemoryGetTool()
        """
        # 安全校验: 只允许 MEMORY.md / memory.md 或 memory/ 下的 .md
        normalized = rel_path.replace("\\", "/")
        allowed = (
            normalized in ("MEMORY.md", "memory.md")
            or normalized.startswith("memory/")
        )
        if not allowed or ".." in normalized:
            return {"path": rel_path, "text": "", "error": "Access denied"}

        full = self.workspace_dir / normalized
        if not full.exists():
            return {"path": rel_path, "text": "", "error": f"Not found: {rel_path}"}
        if full.is_symlink():
            return {"path": rel_path, "text": "", "error": "Symlinks rejected"}

        try:
            text = full.read_text(encoding="utf-8")
        except Exception as e:
            return {"path": rel_path, "text": "", "error": str(e)}

        lines = text.split("\n")
        if from_line is not None:
            start = max(0, from_line - 1)
            end = (start + n_lines) if n_lines else len(lines)
            lines = lines[start:end]

        return {"path": rel_path, "text": "\n".join(lines), "totalLines": len(lines)}

    def load_evergreen(self) -> str:
        """读取 MEMORY.md (长期记忆)."""
        for name in ("MEMORY.md", "memory.md"):
            p = self.workspace_dir / name
            if p.exists() and not p.is_symlink():
                try:
                    return p.read_text(encoding="utf-8").strip()
                except Exception:
                    pass
        return ""

    def get_recent_daily(self, days: int = 3) -> list[dict]:
        """获取最近 N 天的每日日志."""
        results = []
        today = date.today()
        for i in range(days):
            d = today - timedelta(days=i)
            path = self.memory_dir / f"{d.isoformat()}.md"
            if path.exists():
                try:
                    content = path.read_text(encoding="utf-8").strip()
                    results.append({
                        "path": f"memory/{d.isoformat()}.md",
                        "date": d.isoformat(),
                        "content": content,
                    })
                except Exception:
                    pass
        return results

    # ------------------------------------------------------------------ 索引

    def _collect_memory_files(self) -> list[Path]:
        """收集 workspace 中所有可索引的 .md 文件.

        【参考】OpenClaw src/memory/sync-memory-files.ts
        """
        files: list[Path] = []
        # MEMORY.md / memory.md
        for name in ("MEMORY.md", "memory.md"):
            p = self.workspace_dir / name
            if p.exists() and not p.is_symlink():
                files.append(p)
                break  # 只取一个, 与原始 OpenClaw dedup 一致
        # memory/**/*.md
        if self.memory_dir.exists():
            for md in sorted(self.memory_dir.glob("**/*.md"), reverse=True):
                if not md.is_symlink():
                    files.append(md)
        return files

    def _chunk_file(self, path: Path) -> list[dict]:
        """将文件拆分为 chunk.

        【参考】OpenClaw src/memory/internal.ts  chunkMarkdown()
        原始使用 ~400 token / 80 token overlap 的滑动窗口;
        教学版按 markdown heading 拆分 (逻辑等效, 实现更简单).
        每个 chunk 包含 path / startLine / endLine / text.
        """
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:
            return []

        rel = str(path.relative_to(self.workspace_dir))
        lines = content.split("\n")
        chunks: list[dict] = []
        buf: list[str] = []
        buf_start = 1

        for i, line in enumerate(lines):
            if line.startswith("#") and buf:
                text = "\n".join(buf).strip()
                if text:
                    chunks.append({
                        "path": rel, "text": text,
                        "startLine": buf_start,
                        "endLine": buf_start + len(buf) - 1,
                        "source": "memory",
                    })
                buf = [line]
                buf_start = i + 1
            else:
                buf.append(line)

        if buf:
            text = "\n".join(buf).strip()
            if text:
                chunks.append({
                    "path": rel, "text": text,
                    "startLine": buf_start,
                    "endLine": buf_start + len(buf) - 1,
                    "source": "memory",
                })
        return chunks

    def _build_index(self) -> list[dict]:
        """构建全量 chunk 索引."""
        chunks: list[dict] = []
        for f in self._collect_memory_files():
            chunks.extend(self._chunk_file(f))
        return chunks

    # ------------------------------------------------------------------ 搜索

    def search(self, query: str, *,
               max_results: int = SEARCH_MAX_RESULTS,
               min_score: float = SEARCH_MIN_SCORE) -> list[dict]:
        """混合搜索: TF-IDF vector + BM25 keyword.

        【参考】OpenClaw src/memory/hybrid.ts  mergeHybridResults()

        流程:
          1. 构建全量 chunk 索引
          2. TF-IDF 余弦相似度 (向量搜索, 权重 0.7)
          3. BM25 (关键词搜索, 权重 0.3)
          4. finalScore = 0.7 * vectorScore + 0.3 * textScore
          5. 过滤 minScore → 取 maxResults
        """
        chunks = self._build_index()
        if not chunks:
            return []

        # --- 分词与统计 ---
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        doc_freq: Counter = Counter()
        all_tokens: list[list[str]] = []
        total_len = 0
        for c in chunks:
            toks = _tokenize(c["text"])
            all_tokens.append(toks)
            for t in set(toks):
                doc_freq[t] += 1
            total_len += len(toks)
        n_docs = len(chunks)
        avgdl = total_len / max(n_docs, 1)

        # --- TF-IDF 向量搜索 ---
        def _idf(term: str) -> float:
            df = doc_freq.get(term, 0)
            return math.log(n_docs / df) if df else 0.0

        q_tf = Counter(query_tokens)
        q_vec = {t: (cnt / len(query_tokens)) * _idf(t)
                 for t, cnt in q_tf.items()}

        vector_scores: list[float] = []
        for toks in all_tokens:
            if not toks:
                vector_scores.append(0.0)
                continue
            tf = Counter(toks)
            c_vec = {t: (cnt / len(toks)) * _idf(t) for t, cnt in tf.items()}
            vector_scores.append(_cosine_sim(q_vec, c_vec))

        # --- BM25 关键词搜索 ---
        bm25_raw: list[float] = []
        for toks in all_tokens:
            bm25_raw.append(_bm25_score(query_tokens, toks, doc_freq, n_docs,
                                        avgdl=avgdl))

        # 归一化 BM25 到 0..1  (与 OpenClaw textScore = 1/(1+rank) 类似)
        max_bm25 = max(bm25_raw) if bm25_raw else 1.0
        text_scores = [(s / max_bm25 if max_bm25 > 0 else 0.0) for s in bm25_raw]

        # --- 混合 ---
        results: list[dict] = []
        for i, chunk in enumerate(chunks):
            score = (HYBRID_VECTOR_WEIGHT * vector_scores[i]
                     + HYBRID_TEXT_WEIGHT * text_scores[i])
            if score < min_score:
                continue
            snippet = chunk["text"][:SEARCH_MAX_SNIPPET_CHARS]
            citation = (f"{chunk['path']}#L{chunk['startLine']}"
                        if chunk["startLine"] == chunk["endLine"]
                        else f"{chunk['path']}#L{chunk['startLine']}-L{chunk['endLine']}")
            results.append({
                "path": chunk["path"],
                "startLine": chunk["startLine"],
                "endLine": chunk["endLine"],
                "score": round(score, 4),
                "snippet": snippet,
                "source": chunk["source"],
                "citation": citation,
            })

        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:max_results]


# --- 全局 manager 缓存 ---
_managers: dict[str, MemoryIndexManager] = {}


def get_memory_manager(agent: AgentWithSoulMemory) -> MemoryIndexManager:
    if agent.id not in _managers:
        _managers[agent.id] = MemoryIndexManager(agent.workspace_dir)
    return _managers[agent.id]


# ============================================================================
# Part 4: Memory Tools — memory_search + memory_get
# ============================================================================
#
# 【参考】OpenClaw src/agents/tools/memory-tool.ts
#         createMemorySearchTool() + createMemoryGetTool()
#
# 原始 OpenClaw 没有 memory_write 工具 — agent 通过 bash 工具编辑文件.
# 教学版保留 memory_write 作为便捷入口, 标注差异.
# ============================================================================

MEMORY_TOOL_NAMES = {"memory_search", "memory_get", "memory_write"}


def build_memory_tools() -> list[dict]:
    """构建 memory 工具定义 (OpenAI/DeepSeek function-calling 格式).

    【参考】OpenClaw src/agents/tools/memory-tool.ts
    格式需与 s04 TOOLS_OPENAI 一致: {type: "function", function: {name, description, parameters}}
    """
    raw = [
        {
            "name": "memory_search",
            "description": (
                "Mandatory recall step: semantically search MEMORY.md + memory/*.md "
                "before answering questions about prior work, decisions, dates, people, "
                "preferences, or todos; returns top snippets with path + lines. "
                "Use memory_get after to pull only the needed lines and keep context small."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query.",
                    },
                    "maxResults": {
                        "type": "integer",
                        "description": f"Max results (default {SEARCH_MAX_RESULTS}).",
                    },
                    "minScore": {
                        "type": "number",
                        "description": f"Min relevance 0-1 (default {SEARCH_MIN_SCORE}).",
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "memory_get",
            "description": (
                "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; "
                "use after memory_search to pull only the needed lines and keep context small."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path (e.g. 'MEMORY.md', 'memory/2026-03-04.md').",
                    },
                    "from": {
                        "type": "integer",
                        "description": "Start line (1-indexed). Omit to read whole file.",
                    },
                    "lines": {
                        "type": "integer",
                        "description": "Number of lines to read.",
                    },
                },
                "required": ["path"],
            },
        },
        {
            "name": "memory_write",
            "description": (
                "Append a timestamped entry to today's memory/YYYY-MM-DD.md. "
                "Use for preferences, facts, decisions. "
                "(Teaching shortcut — production OpenClaw writes via bash tools.)"
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
                        "description": "Tag: preference / fact / decision / todo / person.",
                    },
                },
                "required": ["content"],
            },
        },
    ]
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in raw
    ]


def handle_memory_tool(tool_name: str, params: dict,
                       agent: AgentWithSoulMemory) -> str:
    """分发 memory 工具调用.

    返回 JSON 字符串, 与 process_tool_call 签名一致.
    """
    mgr = get_memory_manager(agent)

    if tool_name == "memory_search":
        query = params.get("query", "")
        if not query.strip():
            return json.dumps({"results": [], "error": "Empty query"})
        max_r = params.get("maxResults", SEARCH_MAX_RESULTS)
        min_s = params.get("minScore", SEARCH_MIN_SCORE)
        results = mgr.search(query, max_results=max_r, min_score=min_s)
        return json.dumps({
            "results": results,
            "provider": "tfidf+bm25",
            "model": "hybrid-local",
        })

    if tool_name == "memory_get":
        path = params.get("path", "")
        if not path.strip():
            return json.dumps({"path": "", "text": "", "error": "Path required"})
        result = mgr.read_file(
            path,
            from_line=params.get("from"),
            n_lines=params.get("lines"),
        )
        return json.dumps(result)

    if tool_name == "memory_write":
        content = params.get("content", "")
        if not content.strip():
            return json.dumps({"error": "Empty content"})
        cat = params.get("category", "general")
        rel = mgr.write_daily(content, cat)
        return json.dumps({"status": "saved", "path": rel, "category": cat})

    return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ============================================================================
# Part 5: System Prompt 构建 — 对标 OpenClaw buildAgentSystemPrompt()
# ============================================================================
#
# 【参考】OpenClaw src/agents/system-prompt.ts (lines 380-612)
#
# 原始 OpenClaw 的 system prompt 构建顺序:
#   1. Identity line
#   2. Tooling section
#   3. Safety section
#   4. Memory Recall section (if memory tools available)
#   5. Time / Workspace section
#   6. "Project context files" header
#      → "If SOUL.md is present, embody its persona..."
#      → SOUL.md content
#      → MEMORY.md content
#   7. Silent replies / Heartbeats
#
# 关键: SOUL.md 不是 prepend 到最前面, 而是作为 "project context file"
#       注入到 system prompt 的后半部分. 前面是功能性指令.
# ============================================================================

# Memory flush 默认提示
# 【参考】docs/concepts/memory.md  "Automatic memory flush"
MEMORY_FLUSH_PROMPT = (
    "Pre-compaction memory flush. Store durable memories now "
    "(use memory/YYYY-MM-DD.md; create memory/ if needed). "
    "IMPORTANT: If the file already exists, APPEND new content only "
    "and do not overwrite existing entries."
)


def build_agent_system_prompt(agent: AgentWithSoulMemory, base_prompt: str) -> str:
    """构建完整 system prompt, 对标 OpenClaw buildAgentSystemPrompt().

    分层结构 (严格遵循原始 OpenClaw 的顺序):
      ┌──────────────────────────────────────────────┐
      │ 1. Base system prompt (identity + tools)     │
      │ 2. Personality line                          │
      │ 3. ## Memory Recall (mandatory step)         │
      │ 4. ## Time / Workspace                       │
      │ 5. ## Project Context Files                  │
      │    → SOUL.md content                         │
      │    → MEMORY.md content (bootstrap excerpt)   │
      └──────────────────────────────────────────────┘
    """
    parts: list[str] = []

    # --- 1. Base system prompt ---
    parts.append(base_prompt)

    # --- 2. Personality ---
    if agent.system_prompt:
        parts.append(f"\nPersonality: {agent.system_prompt}")

    # --- 3. Memory Recall ---
    parts.append(
        "\n## Memory Recall\n"
        "Before answering anything about prior work, decisions, dates, people, "
        "preferences, or todos: run memory_search on MEMORY.md + memory/*.md; "
        "then use memory_get to pull only the needed lines. "
        "If low confidence after search, say you checked.\n"
        "Citations: include Source: <path#Lstart-Lend> when it helps the user "
        "verify memory snippets."
    )

    # --- 4. Time / Workspace ---
    parts.append(
        f"\n## Time\nCurrent date: {date.today().isoformat()}\n"
        f"\n## Workspace\nWorking directory: {agent.workspace_dir}\n"
        "Treat this directory as the single global workspace for memory files."
    )

    # --- 5. Project context files ---
    bootstrap_files = load_workspace_bootstrap_files(agent.workspace_dir)
    if bootstrap_files:
        header = "\n## Project Context Files\n"
        header += ("The following project context files have been loaded from the workspace.\n"
                    "If SOUL.md is present, embody its persona — speak, think, and "
                    "respond in the style it defines.\n")
        parts.append(header)
        for bf in bootstrap_files:
            parts.append(f"\n### {bf['name']}\n\n{bf['content']}")

    # --- 6. Recent memory context (今日+昨日 headline awareness) ---
    mgr = get_memory_manager(agent)
    recent = mgr.get_recent_daily(days=2)
    if recent:
        lines = ["\n## Recent Memory (Awareness Only)"]
        for entry in recent:
            snippet = entry["content"][:500]
            lines.append(f"\n### {entry['date']}\n{snippet}")
        parts.append("\n".join(lines))

    return "\n".join(parts)


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
    # 加载会话历史
    session_data = session_store.load_session(session_key)
    messages = session_data["history"]
    messages.append({"role": "user", "content": user_text})

    # 构建融合 Soul + Memory 的 system prompt
    system_prompt = build_agent_system_prompt(agent, S04_SYSTEM_PROMPT)

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
                if tc["name"] in MEMORY_TOOL_NAMES:
                    result = handle_memory_tool(tc["name"], args, agent)
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
) -> tuple[dict[str, AgentWithSoulMemory], list[Binding], str, str]:
    """从配置加载 Agent, 扩展为 AgentWithSoulMemory.

    每个 Agent 获得独立的 workspace 目录: WORKSPACE_DIR/{agent_id}/

    返回:
        (agents_dict, bindings, default_agent_id, dm_scope)
        与 s05 的 load_routing_config 返回签名对齐, 但 agents 已升级为 AgentWithSoulMemory.
    """
    agents, bindings, default_agent, dm_scope = load_routing_config(config_path)

    result: dict[str, AgentWithSoulMemory] = {}
    for aid, acfg in agents.items():
        a = AgentWithSoulMemory(
            id=acfg.id,
            model=acfg.model,
            system_prompt=acfg.system_prompt,
            tools=acfg.tools,
        )
        result[aid] = a
        log.info("agent %s  workspace=%s", aid, a.workspace_dir)

    return result, bindings, default_agent, dm_scope


def _ensure_sample_soul(agents: dict[str, AgentWithSoulMemory]) -> None:
    """为没有 SOUL.md 的 Agent 创建示例文件.

    【参考】docs/reference/templates/SOUL.md
    """
    sample_soul = """\
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" \
and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing \
or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the \
context. Search for it. _Then_ ask if you're stuck.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough \
when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. \
Update them. They're how you persist.
"""
    for agent in agents.values():
        if not agent.soul_path.exists():
            agent.soul_path.write_text(sample_soul, encoding="utf-8")
            print_info(f"Created sample SOUL.md at {agent.soul_path}")


# ============================================================================
# Part 8: SoulMemoryGateway — 带 Soul+Memory 的 WebSocket 网关服务器
# ============================================================================
#
# 对标 s05_gateway.py 的 RoutingGateway, 但使用 run_agent_with_soul_and_memory
# 替代 run_agent_with_tools, 从而在 WebSocket 网关层集成 Soul 和 Memory.
#
# 与 s05 的 RoutingGateway 相比:
#   - chat.send 使用 run_agent_with_soul_and_memory (带 Soul/Memory)
#   - 新增 memory.status 方法: 查询 Agent 的 Memory 状态
#   - 新增 soul.get 方法: 查看 Agent 的 SOUL.md
#   - 路由解析后自动将 AgentConfig 升级为 AgentWithSoulMemory
#   - 其他所有方法 (health, identify, chat.history, routing.*, sessions.*)
#     与 s05 完全一致
# ============================================================================


class SoulMemoryGateway:
    """
    【参考】OpenClaw src/gateway/server.impl.ts

    带 Soul+Memory 功能的网关服务器.
    在 s05 RoutingGateway 的基础上增加:
    - Soul system prompt 注入
    - Memory 工具支持 (memory_search / memory_get / memory_write)
    - Memory 状态查询和 Soul 查看方法
    """

    def __init__(
        self,
        host: str,
        port: int,
        router: MessageRouter,
        sessions: S04SessionStore,
        soul_agents: dict[str, AgentWithSoulMemory],
        token: str = "",
    ) -> None:
        self.host = host
        self.port = port
        self.router = router
        self.sessions = sessions
        self.soul_agents = soul_agents
        self.token = token
        self.clients: dict[str, ConnectedClient] = {}
        self._start_time = time.time()

        # JSON-RPC 方法路由表
        # 与 s05 一致 + Soul/Memory 扩展
        self._methods: dict[str, Any] = {
            "health": self._handle_health,
            "chat.send": self._handle_chat_send,
            "chat.history": self._handle_chat_history,
            "routing.resolve": self._handle_routing_resolve,
            "routing.bindings": self._handle_routing_bindings,
            "sessions.list": self._handle_sessions_list,
            "identify": self._handle_identify,
            # s06 新增
            "memory.status": self._handle_memory_status,
            "soul.get": self._handle_soul_get,
        }

    def _get_soul_agent(self, agent_id: str) -> AgentWithSoulMemory:
        """根据 agent_id 获取 AgentWithSoulMemory."""
        if agent_id in self.soul_agents:
            return self.soul_agents[agent_id]
        # fallback: 从 router.agents 构建
        acfg = self.router.agents.get(agent_id)
        if acfg is None:
            acfg = self.router.agents[self.router.default_agent]
        a = AgentWithSoulMemory(
            id=acfg.id,
            model=acfg.model,
            system_prompt=acfg.system_prompt,
            tools=acfg.tools,
        )
        self.soul_agents[a.id] = a
        return a

    # -- 认证 (与 s05 一致) -----

    def _authenticate(self, headers: Any) -> bool:
        """验证 Bearer Token 认证."""
        if not self.token:
            return True
        auth_header = headers.get("Authorization", "")
        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        return parts[1].strip() == self.token

    # -- WebSocket 连接处理 (与 s05 一致) -----

    async def _handle_connection(self, ws: ServerConnection) -> None:
        """处理单个 WebSocket 连接的完整生命周期."""
        client_id = str(uuid.uuid4())[:8]

        # 认证检查
        if not self._authenticate(ws.request.headers if ws.request else {}):
            await ws.send(make_error(None, AUTH_ERROR, "Authentication failed"))
            await ws.close(4001, "Unauthorized")
            return

        # 注册客户端
        client = ConnectedClient(ws=ws, client_id=client_id)
        self.clients[client_id] = client
        log.info("client %s: connected (total: %d)", client_id, len(self.clients))

        # 发送欢迎事件
        await ws.send(make_event("connect.welcome", {"client_id": client_id}))

        # 消息循环
        try:
            async for raw_message in ws:
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                await self._dispatch(client, raw_message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            del self.clients[client_id]
            log.info("client %s: disconnected", client_id)

    async def _dispatch(self, client: ConnectedClient, raw: str) -> None:
        """JSON-RPC 请求分发器 (与 s05 一致)."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await client.ws.send(make_error(None, PARSE_ERROR, "Invalid JSON"))
            return

        if not isinstance(msg, dict) or msg.get("jsonrpc") != JSONRPC_VERSION:
            await client.ws.send(make_error(msg.get("id"), INVALID_REQUEST, "Invalid JSON-RPC"))
            return

        req_id = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {})

        log.info("client %s: -> %s (id=%s)", client.client_id, method, req_id)

        handler = self._methods.get(method)
        if handler is None:
            await client.ws.send(make_error(req_id, METHOD_NOT_FOUND, f"Unknown: {method}"))
            return

        try:
            result = await handler(client, params)
            await client.ws.send(make_result(req_id, result))
        except Exception as exc:
            log.exception("method %s error", method)
            await client.ws.send(make_error(req_id, INTERNAL_ERROR, str(exc)))

    # -- RPC 方法实现 (与 s05 一致的方法) -----

    async def _handle_health(self, client: ConnectedClient, params: dict) -> dict:
        """health -- 健康检查."""
        return {
            "status": "ok",
            "uptime_seconds": round(time.time() - self._start_time, 1),
            "connected_clients": len(self.clients),
            "agents": list(self.router.agents.keys()),
            "features": ["soul", "memory"],
        }

    async def _handle_identify(self, client: ConnectedClient, params: dict) -> dict:
        """identify -- 客户端声明自己的通道和身份信息 (与 s05 一致)."""
        client.channel = params.get("channel", "websocket")
        client.sender = params.get("sender", client.client_id)
        client.peer_kind = params.get("peer_kind", "direct")
        client.guild_id = params.get("guild_id", "")
        client.account_id = params.get("account_id", "")
        log.info(
            "client %s: identified as channel=%s sender=%s kind=%s",
            client.client_id, client.channel, client.sender, client.peer_kind,
        )
        return {"identified": True, "channel": client.channel, "sender": client.sender}

    async def _handle_chat_send(self, client: ConnectedClient, params: dict) -> dict:
        """
        chat.send -- 通过路由器自动解析 Agent 和 session, 然后调用带 Soul+Memory 的 LLM.

        【核心流程】与 s05 一致, 但使用 run_agent_with_soul_and_memory 替代 run_agent_with_tools.
        1. 参数验证
        2. 路由解析 (决定由哪个 Agent 处理)
        3. 发送 typing 事件
        4. 调用 Agent (带 Soul+Memory)
        5. 返回结果 + session 元数据
        """
        text = params.get("text", "").strip()
        if not text:
            raise ValueError("'text' is required")

        # 允许 params 覆盖客户端 identify 的值 (与 s05 一致)
        channel = params.get("channel", client.channel)
        sender = params.get("sender", client.sender)
        peer_kind = params.get("peer_kind", client.peer_kind)
        guild_id = params.get("guild_id", client.guild_id) or None
        account_id = params.get("account_id", client.account_id) or None

        # 【关键】路由解析: 确定 Agent 和 session key (与 s05 一致)
        agent_config, session_key = self.router.resolve(
            channel=channel,
            sender=sender,
            peer_kind=peer_kind,
            guild_id=guild_id,
            account_id=account_id,
        )

        log.info(
            "chat.send: routed to agent=%s session=%s",
            agent_config.id, session_key,
        )

        # 推送 typing 事件 (与 s05 一致)
        await client.ws.send(make_event("chat.typing", {
            "session_key": session_key,
            "agent_id": agent_config.id,
        }))

        # 获取 AgentWithSoulMemory
        soul_agent = self._get_soul_agent(agent_config.id)

        # 调用 Agent (带 Soul+Memory, 替代 s05 的 run_agent_with_tools)
        try:
            assistant_text = await asyncio.to_thread(
                run_agent_with_soul_and_memory,
                soul_agent,
                self.sessions,
                session_key,
                text,
            )
        except LLMClientError as e:
            log.warning("LLM 请求失败 agent=%s: %s", soul_agent.id, e)
            raise ValueError(f"LLM 请求失败: {e}") from e

        session_data = self.sessions.load_session(session_key)
        message_count = len(session_data["history"])

        return {
            "text": assistant_text,
            "agent_id": soul_agent.id,
            "session_key": session_key,
            "message_count": message_count,
        }

    async def _handle_chat_history(self, client: ConnectedClient, params: dict) -> dict:
        """chat.history -- 获取会话的消息历史 (与 s05 一致)."""
        session_key = params.get("session_key", "")
        if not session_key:
            raise ValueError("'session_key' is required")
        session_data = self.sessions.load_session(session_key)
        messages = session_data["history"]
        limit = params.get("limit", 50)
        if len(messages) > limit:
            messages = messages[-limit:]
        return {"session_key": session_key, "messages": messages, "total": len(session_data["history"])}

    async def _handle_routing_resolve(self, client: ConnectedClient, params: dict) -> dict:
        """
        routing.resolve -- 诊断方法 (与 s05 一致).
        不实际调用 LLM, 只返回路由解析结果 + Soul/Memory 状态.
        """
        channel = params.get("channel", "websocket")
        sender = params.get("sender", "anonymous")
        peer_kind = params.get("peer_kind", "direct")
        guild_id = params.get("guild_id")
        account_id = params.get("account_id")

        agent_config, session_key = self.router.resolve(
            channel=channel,
            sender=sender,
            peer_kind=peer_kind,
            guild_id=guild_id,
            account_id=account_id,
        )

        # s06 增强: 附带 Soul/Memory 信息
        soul_agent = self._get_soul_agent(agent_config.id)
        has_soul = soul_agent.soul_path.exists()
        mgr = get_memory_manager(soul_agent)
        has_memory = bool(mgr.load_evergreen())

        return {
            "agent_id": agent_config.id,
            "agent_model": agent_config.model,
            "session_key": session_key,
            "system_prompt_preview": (
                agent_config.system_prompt[:100] + "..."
                if len(agent_config.system_prompt) > 100
                else agent_config.system_prompt
            ),
            "has_soul": has_soul,
            "has_memory": has_memory,
            "workspace": str(soul_agent.workspace_dir),
        }

    async def _handle_routing_bindings(self, client: ConnectedClient, params: dict) -> dict:
        """routing.bindings -- 列出所有绑定规则 (与 s05 一致)."""
        return {
            "bindings": [
                {
                    "channel": b.channel,
                    "account_id": b.account_id,
                    "peer_id": b.peer_id,
                    "peer_kind": b.peer_kind,
                    "guild_id": b.guild_id,
                    "agent_id": b.agent_id,
                    "priority": b.priority,
                }
                for b in self.router.bindings
            ],
            "default_agent": self.router.default_agent,
            "dm_scope": self.router.dm_scope,
        }

    async def _handle_sessions_list(self, client: ConnectedClient, params: dict) -> dict:
        """sessions.list -- 列出所有活跃会话 (与 s05 一致)."""
        raw = self.sessions.list_sessions()
        sessions = []
        for m in raw:
            sk = m.get("session_key", "")
            parts = sk.split(":") if sk else []
            agent_id = parts[1] if len(parts) > 1 else "main"
            sessions.append({
                "session_key": sk,
                "agent_id": agent_id,
                "message_count": m.get("message_count", 0),
                "last_active": m.get("updated_at", ""),
            })
        return {"sessions": sessions}

    # -- s06 新增 RPC 方法 -----

    async def _handle_memory_status(self, client: ConnectedClient, params: dict) -> dict:
        """memory.status -- 查询 Agent 的 Memory 状态 (s06 新增)."""
        agent_id = params.get("agent_id", self.router.default_agent)
        soul_agent = self._get_soul_agent(agent_id)
        mgr = get_memory_manager(soul_agent)

        evergreen = mgr.load_evergreen()
        recent = mgr.get_recent_daily(days=7)

        return {
            "agent_id": agent_id,
            "workspace": str(soul_agent.workspace_dir),
            "memory_md_chars": len(evergreen),
            "recent_daily_count": len(recent),
            "recent_daily": [
                {"date": e["date"], "lines": e["content"].count("\n") + 1}
                for e in recent
            ],
        }

    async def _handle_soul_get(self, client: ConnectedClient, params: dict) -> dict:
        """soul.get -- 查看 Agent 的 SOUL.md (s06 新增)."""
        agent_id = params.get("agent_id", self.router.default_agent)
        soul_agent = self._get_soul_agent(agent_id)

        if soul_agent.soul_path.exists():
            content = soul_agent.soul_path.read_text(encoding="utf-8").strip()
            return {"agent_id": agent_id, "soul": content, "exists": True}
        return {"agent_id": agent_id, "soul": "", "exists": False}

    # -- 服务器启动 (与 s05 一致) -----

    async def start(self) -> None:
        """启动 WebSocket 服务器并进入事件循环."""
        log.info("Gateway (Soul+Memory) starting on ws://%s:%d", self.host, self.port)
        log.info("\n%s", self.router.describe_bindings())

        async with websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
        ):
            log.info("Gateway ready. Waiting for connections...")
            await asyncio.Future()


# ============================================================================
# Part 9: 测试客户端 -- 演示 Soul+Memory 路由行为
# ============================================================================
#
# 与 s05 的 test_client 对齐, 增加 Soul/Memory 相关测试.
# ============================================================================

async def test_client() -> None:
    """
    测试客户端: 模拟来自不同通道和用户的消息, 观察路由结果 + Soul/Memory.
    启动: python agents/s06_mem.py --test-client
    """
    uri = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}"
    headers = {}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    print(f"[test] connecting to {uri} ...")

    async with websockets.connect(uri, additional_headers=headers) as ws:
        # 接收欢迎
        welcome = json.loads(await ws.recv())
        client_id = welcome.get("params", {}).get("client_id", "?")
        print(f"[test] connected as {client_id}\n")

        req_counter = 0

        async def rpc(method: str, params: dict) -> dict:
            nonlocal req_counter
            req_counter += 1
            rid = f"r-{req_counter}"
            await ws.send(json.dumps({
                "jsonrpc": "2.0",
                "id": rid,
                "method": method,
                "params": params,
            }))
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get("id") == rid:
                    return msg.get("result", msg.get("error", {}))
                else:
                    event_type = msg.get("params", {}).get("type", "?")
                    print(f"  [event] {event_type}")

        # -- 测试 1: 健康检查 (验证 Soul/Memory 特性标记) ---
        print("--- Health Check ---")
        result = await rpc("health", {})
        print(f"  status={result.get('status')} features={result.get('features')}")
        print(f"  agents={result.get('agents')}")

        # -- 测试 2: 路由诊断 (与 s05 一致 + Soul/Memory 状态) ---
        print("\n--- Routing Diagnostics (with Soul/Memory status) ---")

        scenarios = [
            {"channel": "telegram", "sender": "random-user", "peer_kind": "direct"},
            {"channel": "telegram", "sender": "user-alice-fan", "peer_kind": "direct"},
            {"channel": "discord", "sender": "dev-person", "peer_kind": "group", "guild_id": "dev-server"},
            {"channel": "slack", "sender": "someone", "peer_kind": "direct"},
        ]

        for s in scenarios:
            result = await rpc("routing.resolve", s)
            print(
                f"  {s.get('channel'):>10} | sender={s.get('sender'):<16} "
                f"| kind={s.get('peer_kind'):<7} "
                f"-> agent={result.get('agent_id'):<6} "
                f"soul={'Y' if result.get('has_soul') else 'N'} "
                f"mem={'Y' if result.get('has_memory') else 'N'} "
                f"session={result.get('session_key')}"
            )

        # -- 测试 3: Soul 查看 ---
        print("\n--- Soul Status ---")
        for agent_id in result.get("agent_id", "main"), "main":
            soul_result = await rpc("soul.get", {"agent_id": agent_id})
            soul_preview = soul_result.get("soul", "")[:80]
            print(f"  [{agent_id}] exists={soul_result.get('exists')} preview={soul_preview}...")

        # -- 测试 4: Memory 状态 ---
        print("\n--- Memory Status ---")
        mem_result = await rpc("memory.status", {"agent_id": "main"})
        print(f"  [main] MEMORY.md={mem_result.get('memory_md_chars')} chars, "
              f"daily_logs={mem_result.get('recent_daily_count')}")

        # -- 测试 5: 实际对话 (与 s05 一致, 但 Agent 带 Soul+Memory) ---
        print("\n--- Routed Chat (with Soul+Memory) ---")

        # 普通用户 -> main agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "telegram",
            "sender": "normal-user",
        })
        print(f"  [main]  {result.get('text', '')[:120]}...")

        # alice 的粉丝 -> alice agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "telegram",
            "sender": "user-alice-fan",
        })
        print(f"  [alice] {result.get('text', '')[:120]}...")

        # dev-server 群组 -> bob agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "discord",
            "sender": "dev-person",
            "peer_kind": "group",
            "guild_id": "dev-server",
        })
        print(f"  [bob]   {result.get('text', '')[:120]}...")

        # -- 测试 6: 列出所有会话 (与 s05 一致) ---
        print("\n--- Active Sessions ---")
        result = await rpc("sessions.list", {})
        for s in result.get("sessions", []):
            print(
                f"  agent={s['agent_id']:<6} "
                f"msgs={s['message_count']:<3} "
                f"key={s['session_key']}"
            )

        # -- 测试 7: 列出绑定规则 (与 s05 一致) ---
        print("\n--- Bindings ---")
        result = await rpc("routing.bindings", {})
        for b in result.get("bindings", []):
            parts = []
            if b.get("channel"):
                parts.append(f"channel={b['channel']}")
            if b.get("peer_id"):
                parts.append(f"peer={b['peer_id']}")
            if b.get("guild_id"):
                parts.append(f"guild={b['guild_id']}")
            cond = ", ".join(parts) if parts else "(default)"
            print(f"  p={b['priority']:<3} {cond:<40} -> {b['agent_id']}")
        print(f"  default -> {result.get('default_agent')}")
        print(f"  dm_scope = {result.get('dm_scope')}")

    print("\n[test] done")


# ============================================================================
# Part 10: 交互式对话客户端 -- 可自由提问以验证 Soul/Memory + 会话和工具
# ============================================================================
#
# 与 s05 的 interactive_chat 对齐, 增加 Soul/Memory 命令.
# ============================================================================

async def interactive_chat() -> None:
    """
    交互式对话客户端: 连接网关后可持续输入问题, 验证 Soul/Memory + 会话记录和工具调用.
    启动: python agents/s06_mem.py --chat

    命令:
      /quit       退出
      /sessions   列出会话
      /history    查看当前会话历史
      /soul       查看当前 Agent 的 Soul
      /memory     查看当前 Agent 的 Memory 状态
    """
    uri = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}"
    headers = {}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    print(f"[chat] connecting to {uri} ...")
    try:
        ws = await websockets.connect(uri, additional_headers=headers)
    except Exception as e:
        print(f"[chat] Failed to connect. Is the gateway running? {e}")
        return

    welcome = json.loads(await ws.recv())
    client_id = welcome.get("params", {}).get("client_id", "?")
    print(f"[chat] connected as {client_id}\n")

    req_counter = 0
    current_session_key: str | None = None
    current_agent_id: str | None = None

    async def rpc(method: str, params: dict) -> dict:
        nonlocal req_counter
        req_counter += 1
        rid = f"r-{req_counter}"
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": rid,
            "method": method,
            "params": params,
        }))
        while True:
            raw = await ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == rid:
                return msg.get("result", msg.get("error", {}))
            event_type = msg.get("params", {}).get("type", "?")
            if event_type == "chat.typing":
                print("  ... ", end="", flush=True)

    print("=" * 60)
    print("  交互式对话 - Soul & Memory + 会话记录与工具调用")
    print("  输入问题后回车发送，/quit 退出")
    print("  命令:")
    print("    /sessions   列出会话")
    print("    /history    查看当前会话历史")
    print("    /soul       查看当前 Agent 的 Soul")
    print("    /memory     查看当前 Agent 的 Memory 状态")
    print("=" * 60)

    chat_params = {"channel": "websocket", "sender": "chat-user"}

    try:
        while True:
            try:
                user_input = await asyncio.to_thread(input, "\nYou> ")
            except (EOFError, KeyboardInterrupt):
                print()
                break

            text = user_input.strip()
            if not text:
                continue

            if text.lower() in ("/quit", "/exit", "q", "quit", "exit"):
                print("Bye.")
                break
            if text.lower() == "/sessions":
                result = await rpc("sessions.list", {})
                for s in result.get("sessions", []):
                    print(f"  {s['agent_id']:<8} msgs={s['message_count']:<3} {s['session_key']}")
                continue
            if text.lower() == "/history":
                if current_session_key:
                    result = await rpc("chat.history", {"session_key": current_session_key})
                    for m in result.get("messages", []):
                        role = m.get("role", "?")
                        content = (m.get("content") or "")[:200]
                        print(f"  [{role}] {content}{'...' if len(m.get('content',''))>200 else ''}")
                else:
                    print("  (先发送一条消息以建立会话)")
                continue
            if text.lower() == "/soul":
                aid = current_agent_id or "main"
                result = await rpc("soul.get", {"agent_id": aid})
                if result.get("exists"):
                    print(f"\n{MAGENTA}--- {aid.upper()} SOUL ---{RESET}")
                    print(result.get("soul", ""))
                    print(f"{MAGENTA}--- end ---{RESET}")
                else:
                    print(f"  [{aid}] No soul file found.")
                continue
            if text.lower() == "/memory":
                aid = current_agent_id or "main"
                result = await rpc("memory.status", {"agent_id": aid})
                print(f"\n{MAGENTA}--- Memory Status ({aid}) ---{RESET}")
                print(f"  Workspace: {result.get('workspace')}")
                print(f"  MEMORY.md: {result.get('memory_md_chars', 0)} chars")
                print(f"  Daily logs: {result.get('recent_daily_count', 0)} files")
                for d in result.get("recent_daily", []):
                    print(f"    {d['date']}: {d['lines']} lines")
                print(f"{MAGENTA}--- end ---{RESET}")
                continue

            result = await rpc("chat.send", {**chat_params, "text": text})
            if isinstance(result, dict) and "text" in result:
                current_session_key = result.get("session_key") or current_session_key
                current_agent_id = result.get("agent_id") or current_agent_id
                print(f"\nAgent> {result['text']}")
            else:
                err = result.get("message", str(result)) if isinstance(result, dict) else str(result)
                print(f"\nAgent> [Error] {err}")

    finally:
        await ws.close()
    print("\n[chat] disconnected")


# ============================================================================
# Part 11: 交互式 REPL -- 本地路由调试 + Soul/Memory 测试
# ============================================================================
#
# 对标 s05 的 repl (路由测试), 但增加 Soul/Memory 对话能力.
# 合并了原 s06 的 run_repl (Agent 对话) 和 s05 的 repl (路由诊断).
# ============================================================================

def run_repl(
    router: MessageRouter,
    soul_agents: dict[str, AgentWithSoulMemory],
    session_store: S04SessionStore,
) -> None:
    """
    交互式 REPL 模式: 路由测试 + Soul/Memory 对话, 无需网关.

    支持两种操作:
    1. 路由测试: 输入 "<channel> <sender> [kind] [guild_id]" 查看路由结果
    2. Agent 对话: 输入普通文本直接与当前 Agent 对话 (带 Soul+Memory)
    """
    default_agent_id = router.default_agent
    current_agent = soul_agents.get(default_agent_id)
    if current_agent is None:
        current_agent = next(iter(soul_agents.values()))
    session_key = f"repl:{current_agent.id}:local"

    print_info("=" * 70)
    print_info(f"  Mini-Claw REPL  |  Section 06: Soul & Memory")
    print_info(f"  Agent: {current_agent.id}")
    print_info(f"  Model: {current_agent.model}")
    print_info(f"  Workspace: {current_agent.workspace_dir}")
    print_info("")
    print_info("  Commands:")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current agent's soul")
    print_info("    /memory            - View memory status")
    print_info("    /bindings          - List all routing bindings")
    print_info("    /route <ch> <sender> [kind] [guild]  - Test routing")
    print_info("    /switch <agent_id> - Switch to a different agent")
    print_info("    /agents            - List all agents")
    print_info("    (anything else)    - Chat with current agent")
    print_info("=" * 70)
    print()

    # 显示 Soul 状态
    soul_path = current_agent.soul_path
    if soul_path.exists():
        soul_content = soul_path.read_text(encoding="utf-8").strip()
        print_info(f"Soul loaded from {soul_path}")
        first_line = soul_content.split("\n")[0].strip()
        print_info(f"Preview: {first_line}\n")
    else:
        print_info(f"No soul found at {soul_path}")
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

        if user_input == "/bindings":
            print(router.describe_bindings())
            continue

        if user_input == "/agents":
            for aid, a in soul_agents.items():
                marker = " <--" if aid == current_agent.id else ""
                has_soul = "soul" if a.soul_path.exists() else "    "
                print(f"  {aid:<12} model={a.model:<16} [{has_soul}] workspace={a.workspace_dir}{marker}")
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
                channel=channel,
                sender=sender,
                peer_kind=peer_kind,
                guild_id=guild_id,
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
                current_agent = soul_agents[new_id]
                session_key = f"repl:{current_agent.id}:local"
                print_info(f"Switched to agent: {current_agent.id}")
                print_info(f"Workspace: {current_agent.workspace_dir}")
                if current_agent.soul_path.exists():
                    first_line = current_agent.soul_path.read_text(encoding="utf-8").strip().split("\n")[0]
                    print_info(f"Soul preview: {first_line}")
            else:
                print(f"  Unknown agent: {new_id}. Available: {', '.join(soul_agents.keys())}")
            continue

        # -- 普通对话: 调用 Agent (带 Soul+Memory) --
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


# ============================================================================
# Part 12: Main 程序入口 (与 s05 对齐)
# ============================================================================

def main() -> None:
    """程序入口: 根据命令行参数启动网关或测试客户端."""

    # 检查 API 密钥（与 s05 一致使用 LLMClientConfig）
    try:
        LLMClientConfig().require_api_key()
    except LLMValidationError as e:
        print(f"Error: {e}")
        print("Set DEEPSEEK_API_KEY in .env file or environment variable.")
        sys.exit(1)

    # 解析 --config 参数 (与 s05 一致)
    config_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--config" and i + 1 < len(sys.argv):
            config_path = sys.argv[i + 1]
            break

    # 确保 workspace 和 sessions 目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # 加载配置, 创建 Agent (带 Soul+Memory)
    soul_agents, bindings, default_agent, dm_scope = create_agents_with_soul_memory(config_path)
    if not soul_agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    # 为所有 Agent 创建示例 Soul 文件
    _ensure_sample_soul(soul_agents)

    # 构建路由器 (使用原始 AgentConfig, 因为 AgentWithSoulMemory 继承自 AgentConfig)
    router = MessageRouter(soul_agents, bindings, default_agent, dm_scope)

    if "--test-client" in sys.argv:
        # 测试客户端 (自动化测试套件, 与 s05 对齐)
        asyncio.run(test_client())
    elif "--chat" in sys.argv:
        # 交互式对话 (可自由提问, 验证 Soul/Memory + 会话和工具, 与 s05 对齐)
        asyncio.run(interactive_chat())
    elif "--repl" in sys.argv:
        # 交互式 REPL (路由测试 + Soul/Memory 对话)
        # 初始化 session store
        session_store = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        run_repl(router, soul_agents, session_store)
    else:
        # 默认: 启动网关服务器 (与 s05 对齐, 但带 Soul+Memory)
        print("=" * 60)
        print("  OpenClaw Gateway — Soul & Memory Edition")
        print("  (s06: s05 WebSocket Gateway + Soul + Memory)")
        print("=" * 60)
        print(f"  Host:     {GATEWAY_HOST}")
        print(f"  Port:     {GATEWAY_PORT}")
        print(f"  Agents:   {', '.join(soul_agents.keys())}")
        print(f"  Bindings: {len(bindings)} rules")
        print(f"  DM Scope: {dm_scope}")
        print()
        print("  Commands:")
        print("    python agents/s06_mem.py                   # start gateway (Soul+Memory)")
        print("    python agents/s06_mem.py --test-client     # run test suite")
        print("    python agents/s06_mem.py --chat            # interactive chat")
        print("    python agents/s06_mem.py --repl            # local REPL (routing + chat)")
        print("    python agents/s06_mem.py --config cfg.json # custom config")
        print("=" * 60)

        sessions = S04SessionStore(
            store_path=SESSIONS_DIR / "sessions.json",
            transcript_dir=SESSIONS_DIR / "transcripts",
        )
        gateway = SoulMemoryGateway(
            host=GATEWAY_HOST,
            port=GATEWAY_PORT,
            router=router,
            sessions=sessions,
            soul_agents=soul_agents,
            token=GATEWAY_TOKEN,
        )
        asyncio.run(gateway.start())


if __name__ == "__main__":
    main()

