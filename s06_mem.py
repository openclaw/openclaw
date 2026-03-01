"""
Section 06: Soul System & Memory
"Give it a soul, let it remember"

OpenClaw 最具辨识度的两个特性:
1. Soul System -- SOUL.md 人格注入, 让 agent 拥有独特的性格/语言风格
2. Memory System -- 双层记忆: MEMORY.md (长期) + memory/YYYY-MM-DD.md (每日)

在 OpenClaw 中:
  - SOUL.md: Markdown 文件, 定义人格/价值观/说话风格
  - MEMORY.md: 常驻记忆, 记录永久性事实 (如: 用户偏好, 项目信息)
  - memory/YYYY-MM-DD.md: 每日记忆日志, 记录当天发生的事
  - 搜索使用 sqlite-vec + embedding 做语义搜索
  - agent 通过 memory_write 工具主动写入记忆

本节教学简化:
  - 用 TF-IDF + 余弦相似度 代替真实 embedding
  - 用文件系统代替 SQLite
  - 但保留了 OpenClaw 的核心架构: 双层记忆 + 工具驱动写入

SOUL.md 示例 (放在 workspace/ 下):

    # Soul
    You are Koda, a thoughtful AI assistant.

    ## Personality
    - Warm but not overly enthusiastic
    - Prefer concise, clear explanations
    - Use analogies from nature and engineering

    ## Values
    - Honesty over comfort
    - Depth over breadth
    - Action over speculation

    ## Language Style
    - Chinese for casual chat, English for technical terms
    - No emoji in serious discussions
    - End complex explanations with a one-line summary

架构图:

  +--- SOUL.md ---+     +--- MEMORY.md ---+
  | personality    |     | evergreen facts  |
  | values         |     | preferences      |
  | language style |     +------------------+
  +----------------+            |
         |                      |
         v                      v
  +-- System Prompt Builder --+
  |  soul + base + memories   |
  +---------------------------+
         |
         v
  +-- Agent Loop --+     +-- memory/daily/ --+
  |  tools:        | --> |  2026-02-24.md     |
  |  memory_write  |     |  2026-02-23.md     |
  |  memory_search |     +--------------------+
  +----------------+

运行方式:
    cd openclaw0
    python agents/s06_soul_memory.py
"""

# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------
import json
import math
import os
import re
import sys
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

# workspace 根目录 -- 存放 SOUL.md / MEMORY.md / memory/ 等文件
WORKSPACE_DIR = Path(__file__).resolve().parent.parent / "workspace"

# 基础系统提示 -- 会被 Soul + Memory 包裹
BASE_SYSTEM_PROMPT = (
    "You are a helpful AI assistant running on the openclaw0 framework.\n"
    "Current date: {date}\n"
    "You have access to memory tools. Use memory_write to store important "
    "information the user shares (preferences, facts, decisions). "
    "Use memory_search to recall past information when the user asks "
    "about something you discussed before."
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


def colored_prompt() -> str:
    return f"{CYAN}{BOLD}You > {RESET}"


def print_assistant(text: str) -> None:
    print(f"\n{GREEN}{BOLD}Assistant:{RESET} {text}\n")


def print_info(text: str) -> None:
    print(f"{DIM}{text}{RESET}")


def print_tool(name: str, detail: str) -> None:
    print(f"  {MAGENTA}[tool:{name}]{RESET} {DIM}{detail}{RESET}")


# ---------------------------------------------------------------------------
# Soul System -- 人格注入
# ---------------------------------------------------------------------------
# OpenClaw 通过 workspace/SOUL.md 定义 agent 人格.
# 加载后作为 system prompt 的最前面部分注入,
# 从而影响 agent 的说话风格、价值观、思维方式.
# ---------------------------------------------------------------------------

class SoulSystem:
    """SOUL.md 人格加载器.

    OpenClaw 的做法:
      1. 启动时读取 workspace/SOUL.md
      2. 拼接到 system prompt 最前面
      3. 每次 agent 调用都带上, 确保人格一致性
    """

    def __init__(self, soul_dir: Path):
        self.soul_path = soul_dir / "SOUL.md"

    def load_soul(self) -> str:
        """加载 SOUL.md 内容. 文件不存在则返回空字符串."""
        if self.soul_path.exists():
            content = self.soul_path.read_text(encoding="utf-8").strip()
            return content
        return ""

    def build_system_prompt(self, base_prompt: str) -> str:
        """组合 soul + base system prompt.

        最终结构:
          [SOUL.md 内容]
          ---
          [Base system prompt]

        OpenClaw 的实际拼接顺序更复杂 (还有 IDENTITY.md, AGENTS.md 等),
        但核心思路一致: 人格定义在最前面, 影响整个上下文.
        """
        soul = self.load_soul()
        if soul:
            return f"{soul}\n\n---\n\n{base_prompt}"
        return base_prompt


# ---------------------------------------------------------------------------
# Memory System -- 双层记忆
# ---------------------------------------------------------------------------
# OpenClaw 的记忆架构:
#   - MEMORY.md: 常驻记忆, 手动或自动更新的长期事实
#   - memory/*.md: 按日期组织的记忆日志
#   - 搜索: sqlite-vec 做向量搜索, FTS5 做全文搜索
#
# 本节简化:
#   - 用 TF-IDF (词频-逆文档频率) 代替 embedding
#   - 用文件系统代替数据库
#   - 但保留双层结构和工具驱动写入的设计
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    """简单分词: 转小写, 按非字母数字拆分, 去掉短词."""
    tokens = re.findall(r"[a-z0-9\u4e00-\u9fff]+", text.lower())
    return [t for t in tokens if len(t) > 1]


def _cosine_similarity(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    """计算两个稀疏向量的余弦相似度."""
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
    """双层记忆存储.

    目录结构:
      workspace/
        MEMORY.md          <-- 常驻记忆 (evergreen)
        memory/
          2026-02-24.md    <-- 每日记忆
          2026-02-23.md
          ...
    """

    def __init__(self, memory_dir: Path):
        self.memory_dir = memory_dir
        self.evergreen_path = memory_dir / "MEMORY.md"
        self.daily_dir = memory_dir / "memory"
        # 确保目录存在
        self.daily_dir.mkdir(parents=True, exist_ok=True)

    # -- 写入 --

    def write_memory(self, content: str, category: str = "general") -> str:
        """写入当天的记忆文件.

        OpenClaw 中 agent 通过 memory_write 工具调用此方法.
        每条记忆带时间戳和分类标签, 追加到当天的日志文件.

        返回写入路径, 方便 agent 告知用户.
        """
        today = date.today().isoformat()
        path = self.daily_dir / f"{today}.md"

        timestamp = datetime.now().strftime("%H:%M:%S")
        entry = f"\n## [{timestamp}] {category}\n\n{content}\n"

        # 如果文件不存在, 写入日期标题
        if not path.exists():
            header = f"# Memory Log: {today}\n"
            path.write_text(header, encoding="utf-8")

        # 追加记忆条目
        with open(path, "a", encoding="utf-8") as f:
            f.write(entry)

        return f"memory/{today}.md"

    # -- 读取 --

    def load_evergreen(self) -> str:
        """加载 MEMORY.md 常驻记忆."""
        if self.evergreen_path.exists():
            return self.evergreen_path.read_text(encoding="utf-8").strip()
        return ""

    def get_recent_memories(self, days: int = 7) -> list[dict]:
        """获取最近 N 天的记忆.

        返回 [{path, date, content}] 列表, 按日期倒序.
        """
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

    # -- 搜索 --

    def _load_all_chunks(self) -> list[dict]:
        """加载所有记忆文件, 拆分成段落 (chunk).

        每个 chunk 是一个 {path, text, line_start, line_end} 字典.
        OpenClaw 中使用固定大小 + overlap 的分块策略;
        这里简化为按 markdown heading 拆分.
        """
        chunks = []

        # 加载 MEMORY.md
        if self.evergreen_path.exists():
            content = self.evergreen_path.read_text(encoding="utf-8")
            for chunk in self._split_by_heading(content, "MEMORY.md"):
                chunks.append(chunk)

        # 加载所有每日记忆文件
        if self.daily_dir.exists():
            for md_file in sorted(self.daily_dir.glob("*.md"), reverse=True):
                content = md_file.read_text(encoding="utf-8")
                rel_path = f"memory/{md_file.name}"
                for chunk in self._split_by_heading(content, rel_path):
                    chunks.append(chunk)

        return chunks

    @staticmethod
    def _split_by_heading(content: str, path: str) -> list[dict]:
        """按 markdown heading 拆分文本为 chunk."""
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
        """搜索记忆, 返回最相关的 top_k 个结果.

        使用 TF-IDF + 余弦相似度:
          1. 对所有记忆 chunk 建立词频统计
          2. 计算 IDF (逆文档频率)
          3. 对 query 和每个 chunk 计算 TF-IDF 向量
          4. 用余弦相似度排序

        OpenClaw 生产版用 embedding model (如 text-embedding-3-small)
        把文本映射到高维向量, 再用 sqlite-vec 做近似最近邻搜索.
        TF-IDF 是一个合理的教学替代: 原理相同 (文本 -> 向量 -> 相似度),
        只是向量质量不如 embedding.
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

        # 按相似度排序, 取 top_k
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]


# ---------------------------------------------------------------------------
# 工具定义 -- memory_write + memory_search
# ---------------------------------------------------------------------------
# OpenClaw 的记忆工具:
#   - memory_search: 语义搜索 MEMORY.md + memory/*.md
#   - memory_get: 精确读取文件的指定行范围
#   - memory_write 不是独立工具, 而是通过 bash/write 工具写入文件
#
# 本节简化为两个专用工具, 让 agent 更直观地操作记忆.
# ---------------------------------------------------------------------------

memory_store = MemoryStore(WORKSPACE_DIR)

TOOLS = [
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

# 工具调度表
TOOL_HANDLERS = {
    "memory_write": lambda params: _handle_memory_write(params),
    "memory_search": lambda params: _handle_memory_search(params),
}


def _handle_memory_write(params: dict) -> str:
    """处理 memory_write 工具调用."""
    content = params.get("content", "")
    category = params.get("category", "general")
    if not content.strip():
        return json.dumps({"error": "Empty content"})
    path = memory_store.write_memory(content, category)
    return json.dumps({
        "status": "saved",
        "path": path,
        "category": category,
    })


def _handle_memory_search(params: dict) -> str:
    """处理 memory_search 工具调用."""
    query = params.get("query", "")
    top_k = params.get("top_k", 5)
    if not query.strip():
        return json.dumps({"results": [], "error": "Empty query"})
    results = memory_store.search_memory(query, top_k=top_k)
    return json.dumps({
        "results": results,
        "total_found": len(results),
    })


# ---------------------------------------------------------------------------
# System Prompt 构建
# ---------------------------------------------------------------------------
# 最终 system prompt 的分层结构:
#
#   [SOUL.md 内容]           <-- 人格定义
#   ---
#   [Base system prompt]     <-- 功能说明
#   ---
#   ## Evergreen Memory      <-- 常驻记忆
#   [MEMORY.md 内容]
#   ---
#   ## Recent Memory Context <-- 近期记忆摘要
#   [最近几天的记忆片段]
#
# 这种分层保证了:
#   1. 人格在最前面, 优先级最高
#   2. 常驻记忆提供背景知识
#   3. 近期记忆提供时间上下文
# ---------------------------------------------------------------------------

soul_system = SoulSystem(WORKSPACE_DIR)


def build_full_system_prompt() -> str:
    """构建完整的 system prompt, 融合 soul + base + memory."""
    # 基础提示, 填入当前日期
    base = BASE_SYSTEM_PROMPT.format(date=date.today().isoformat())

    # 注入 soul 人格
    prompt = soul_system.build_system_prompt(base)

    # 注入常驻记忆
    evergreen = memory_store.load_evergreen()
    if evergreen:
        prompt += f"\n\n---\n\n## Evergreen Memory\n\n{evergreen}"

    # 注入近期记忆摘要 (最近3天, 每天最多前500字)
    recent = memory_store.get_recent_memories(days=3)
    if recent:
        prompt += "\n\n---\n\n## Recent Memory Context\n"
        for entry in recent:
            snippet = entry["content"][:500]
            prompt += f"\n### {entry['date']}\n{snippet}\n"

    return prompt


# ---------------------------------------------------------------------------
# 核心: Agent 循环
# ---------------------------------------------------------------------------
# 与 s01 相同的循环结构, 但:
#   1. system prompt 融合了 soul + memory
#   2. 增加了 memory_write / memory_search 两个工具
#   3. agent 会自动在对话中记忆和检索信息
# ---------------------------------------------------------------------------

def agent_loop() -> None:
    """主 agent 循环 -- 带 Soul 和 Memory 的 REPL."""

    messages: list[dict] = []

    print_info("=" * 60)
    print_info("  Mini-Claw  |  Section 06: Soul & Memory")
    print_info(f"  Model: {MODEL_ID}")
    print_info(f"  Workspace: {WORKSPACE_DIR}")
    print_info("  Type 'quit' or 'exit' to leave.")
    print_info("  Type '/soul' to view current soul.")
    print_info("  Type '/memory' to view recent memories.")
    print_info("=" * 60)

    # 显示 soul 状态
    soul_content = soul_system.load_soul()
    if soul_content:
        print_info(f"  Soul loaded from {soul_system.soul_path}")
        # 显示第一行作为预览
        first_line = soul_content.split("\n")[0].strip()
        print_info(f"  Preview: {first_line}")
    else:
        print_info(f"  No SOUL.md found at {soul_system.soul_path}")
        print_info("  Create one to give your agent personality!")

    print()

    while True:
        # --- 用户输入 ---
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

        # --- 内置命令 ---
        if user_input == "/soul":
            soul = soul_system.load_soul()
            if soul:
                print(f"\n{MAGENTA}--- SOUL.md ---{RESET}")
                print(soul)
                print(f"{MAGENTA}--- end ---{RESET}\n")
            else:
                print_info("No SOUL.md found. Create workspace/SOUL.md to define personality.\n")
            continue

        if user_input == "/memory":
            evergreen = memory_store.load_evergreen()
            recent = memory_store.get_recent_memories(days=7)
            print(f"\n{MAGENTA}--- Memory Status ---{RESET}")
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

        # --- 追加用户消息 ---
        messages.append({"role": "user", "content": user_input})

        # --- 每轮重新构建 system prompt (记忆可能已更新) ---
        system_prompt = build_full_system_prompt()

        # --- Agent 内循环: 处理可能的连续工具调用 ---
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
                # 提取并打印回复
                assistant_text = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        assistant_text += block.text
                if assistant_text:
                    print_assistant(assistant_text)
                messages.append({"role": "assistant", "content": response.content})
                break

            elif response.stop_reason == "tool_use":
                # 追加 assistant 的工具调用意图
                messages.append({"role": "assistant", "content": response.content})

                # 处理每个工具调用
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        handler = TOOL_HANDLERS.get(block.name)
                        if handler:
                            print_tool(block.name, json.dumps(block.input, ensure_ascii=False)[:120])
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
                # 继续内循环, 让 agent 处理工具结果

            else:
                # max_tokens 等其他情况
                assistant_text = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        assistant_text += block.text
                if assistant_text:
                    print_assistant(assistant_text)
                messages.append({"role": "assistant", "content": response.content})
                break


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main() -> None:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print(f"{YELLOW}Error: ANTHROPIC_API_KEY not set.{RESET}")
        print(f"{DIM}Copy .env.example to .env and fill in your key.{RESET}")
        sys.exit(1)

    # 确保 workspace 目录存在
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # 如果 SOUL.md 不存在, 创建示例文件
    soul_path = WORKSPACE_DIR / "SOUL.md"
    if not soul_path.exists():
        sample_soul = (
            "# Soul\n\n"
            "You are Koda, a thoughtful AI assistant.\n\n"
            "## Personality\n"
            "- Warm but not overly enthusiastic\n"
            "- Prefer concise, clear explanations\n"
            "- Use analogies from nature and engineering when helpful\n\n"
            "## Values\n"
            "- Honesty over comfort\n"
            "- Depth over breadth\n"
            "- Action over speculation\n\n"
            "## Language Style\n"
            "- Direct and clear\n"
            "- No filler phrases\n"
            "- End complex explanations with a one-line summary\n"
        )
        soul_path.write_text(sample_soul, encoding="utf-8")
        print_info(f"Created sample SOUL.md at {soul_path}")
        print_info("Edit it to customize your agent's personality.\n")

    agent_loop()


if __name__ == "__main__":
    main()
