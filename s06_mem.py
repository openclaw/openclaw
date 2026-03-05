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

  ── 运行方式 ──────────────────────────────────────

  python agents/s06_mem.py           # 默认 REPL
  python agents/s06_mem.py --repl    # 交互式本地测试
  python agents/s06_mem.py --chat    # (规划中) 多 Agent 路由
  python agents/s06_mem.py --server  # (规划中) WebSocket 网关

  ── 依赖 ──────────────────────────────────────────
  pip install python-dotenv websockets
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import json
import math
import os
import re
import sys
import logging
from collections import Counter
from datetime import date, datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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

# 从 s05 导入路由框架 (gateway/session 机制不变)
from s05_gateway import (
    AgentConfig,
    Binding,
    MessageRouter,
    build_session_key,
    load_routing_config,
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
) -> dict[str, AgentWithSoulMemory]:
    """从配置加载 Agent, 扩展为 AgentWithSoulMemory.

    每个 Agent 获得独立的 workspace 目录: WORKSPACE_DIR/{agent_id}/
    """
    agents, _, _, _ = load_routing_config(config_path)

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
    return result


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
    print_info(f"  Workspace: {agent.workspace_dir}")
    print_info("")
    print_info("  Commands:")
    print_info("    /quit or /exit     - Leave REPL")
    print_info("    /soul              - View current soul")
    print_info("    /memory            - View memory status")
    print_info("=" * 70)
    print()

    # 显示 Soul 状态
    soul_path = agent.soul_path
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

        # 内置命令
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

    # 初始化 session store（store_path 必须是索引文件路径，不能是目录）
    session_store = S04SessionStore(
        store_path=SESSIONS_DIR / "sessions.json",
        transcript_dir=SESSIONS_DIR / "transcripts",
    )

    # 创建 Agent（带 Soul 和 Memory）
    agents = create_agents_with_soul_memory()
    if not agents:
        print(f"{YELLOW}Error: No agents found in config.{RESET}")
        sys.exit(1)

    # 默认使用第一个 Agent
    default_agent = next(iter(agents.values()))

    # 创建示例 SOUL 文件 (使用原始 OpenClaw 的模板)
    # 【参考】docs/reference/templates/SOUL.md
    if not default_agent.soul_path.exists():
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
        default_agent.soul_path.write_text(sample_soul, encoding="utf-8")
        print_info(f"Created sample SOUL.md at {default_agent.soul_path}")

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
 
