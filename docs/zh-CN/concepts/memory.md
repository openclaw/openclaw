---
read_when:
  - 你想了解记忆文件布局和工作流程
  - 你想调整自动压缩前的记忆刷新
summary: OpenClaw 记忆的工作原理（工作空间文件 + 自动记忆刷新）
title: 记忆
x-i18n:
  generated_at: "2026-02-03T07:47:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b31753d59496ceec64e4fd3554fff5ad3c698915caf15729f278399385c40f4d
  source_path: concepts/memory.md
  workflow: 15
---

# 记忆

OpenClaw 记忆是**智能体工作空间中的纯 Markdown 文件**。这些文件是唯一的事实来源；模型只"记住"写入磁盘的内容。

记忆搜索工具由活动的记忆插件提供（默认：`memory-core`）。使用 `plugins.slots.memory = "none"` 禁用记忆插件。

## 记忆文件（Markdown）

默认工作空间布局使用两个记忆层：

- `memory/YYYY-MM-DD.md`
  - 每日日志（仅追加）。
  - 在会话开始时读取今天和昨天的内容。
- `MEMORY.md`（可选）
  - 精心整理的长期记忆。
  - **仅在主要的私人会话中加载**（绝不在群组上下文中加载）。

这些文件位于工作空间下（`agents.defaults.workspace`，默认 `~/.openclaw/workspace`）。完整布局参见[智能体工作空间](/concepts/agent-workspace)。

## 何时写入记忆

- 决策、偏好和持久性事实写入 `MEMORY.md`。
- 日常笔记和运行上下文写入 `memory/YYYY-MM-DD.md`。
- 如果有人说"记住这个"，就写下来（不要只保存在内存中）。
- 这个领域仍在发展中。提醒模型存储记忆会有帮助；它会知道该怎么做。
- 如果你想让某些内容持久保存，**请要求机器人将其写入**记忆。

## 自动记忆刷新（压缩前触发）

当会话**接近自动压缩**时，OpenClaw 会触发一个**静默的智能体回合**，提醒模型在上下文被压缩**之前**写入持久记忆。默认提示明确说明模型*可以回复*，但通常 `NO_REPLY` 是正确的响应，因此用户永远不会看到这个回合。

这由 `agents.defaults.compaction.memoryFlush` 控制：

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

详情：

- **软阈值**：当会话 token 估计超过 `contextWindow - reserveTokensFloor - softThresholdTokens` 时触发刷新。
- 默认**静默**：提示包含 `NO_REPLY`，因此不会发送任何内容。
- **两个提示**：一个用户提示加一个系统提示附加提醒。
- **每个压缩周期刷新一次**（在 `sessions.json` 中跟踪）。
- **工作空间必须可写**：如果会话以 `workspaceAccess: "ro"` 或 `"none"` 在沙箱中运行，则跳过刷新。

完整的压缩生命周期参见[会话管理 + 压缩](/reference/session-management-compaction)。

## 向量记忆搜索

OpenClaw 可以在 `MEMORY.md` 和 `memory/*.md`（以及你选择加入的任何额外目录或文件）上构建小型向量索引，以便语义查询可以找到相关笔记，即使措辞不同。

默认值：

- 默认启用。
- 监视记忆文件的更改（去抖动）。
- 默认使用远程嵌入。如果未设置 `memorySearch.provider`，OpenClaw 自动选择：
  1. 如果配置了 `memorySearch.local.modelPath` 且文件存在，则使用 `local`。
  2. 如果可以解析 OpenAI 密钥，则使用 `openai`。
  3. 如果可以解析 Gemini 密钥，则使用 `gemini`。
  4. 如果可以解析 Voyage 密钥，则使用 `voyage`。
  5. 如果可以解析 Mistral 密钥，则使用 `mistral`。
  6. 否则记忆搜索保持禁用状态直到配置完成。
- 本地模式使用 node-llama-cpp，可能需要运行 `pnpm approve-builds`。
- 使用 sqlite-vec（如果可用）在 SQLite 中加速向量搜索。

远程嵌入**需要**嵌入提供商的 API 密钥。OpenClaw 从身份验证配置文件、`models.providers.*.apiKey` 或环境变量解析密钥。Codex OAuth 仅涵盖聊天/补全，**不**满足记忆搜索的嵌入需求。对于 Gemini，使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。对于 Voyage，使用 `VOYAGE_API_KEY` 或 `models.providers.voyage.apiKey`。对于 Mistral，使用 `MISTRAL_API_KEY` 或 `models.providers.mistral.apiKey`。使用自定义 OpenAI 兼容端点时，设置 `memorySearch.remote.apiKey`（以及可选的 `memorySearch.remote.headers`）。

### QMD 后端（实验性）

设置 `memory.backend = "qmd"` 可以将内置的 SQLite 索引器替换为 [QMD](https://github.com/tobi/qmd)：一个本地优先的搜索辅助工具，结合了 BM25 + 向量 + 重排序。Markdown 仍是事实来源；OpenClaw 调用 QMD 进行检索。关键点：

**前置条件**

- 默认禁用。在配置中启用（`memory.backend = "qmd"`）。
- 单独安装 QMD CLI（`bun install -g https://github.com/tobi/qmd` 或下载 release），确保 `qmd` 二进制文件在 gateway 的 `PATH` 上。
- QMD 需要支持扩展的 SQLite 构建（macOS 上用 `brew install sqlite`）。
- QMD 通过 Bun + `node-llama-cpp` 本地运行，首次使用时会从 HuggingFace 自动下载 GGUF 模型（无需单独的 Ollama 守护进程）。
- Gateway 通过设置 `XDG_CONFIG_HOME` 和 `XDG_CACHE_HOME`，在 `~/.openclaw/agents/<agentId>/qmd/` 下运行自包含的 QMD 主目录。
- 操作系统支持：macOS 和 Linux 在安装 Bun + SQLite 后即可开箱即用。Windows 最好通过 WSL2 支持。

**辅助进程如何运行**

- Gateway 在 `~/.openclaw/agents/<agentId>/qmd/`（配置 + 缓存 + sqlite 数据库）下写入自包含的 QMD 主目录。
- Collections 通过 `qmd collection add` 从 `memory.qmd.paths`（加上默认工作空间记忆文件）创建，然后 `qmd update` + `qmd embed` 在启动时和可配置间隔（`memory.qmd.update.interval`，默认 5 分钟）运行。
- Gateway 现在在启动时初始化 QMD 管理器，因此定期更新定时器甚至在第一次 `memory_search` 调用之前就已启动。
- 启动刷新现在默认在后台运行，以免阻塞聊天启动；设置 `memory.qmd.update.waitForBootSync = true` 可保持之前的阻塞行为。
- 搜索通过 `memory.qmd.searchMode` 运行（默认 `qmd search --json`；也支持 `vsearch` 和 `query`）。如果你选择的模式在你的 QMD 构建上拒绝 flags，OpenClaw 会重试使用 `qmd query`。如果 QMD 失败或二进制文件缺失，OpenClaw 会自动回退到内置 SQLite 管理器，以保持记忆工具正常工作。
- OpenClaw 目前不暴露 QMD embed 批处理大小调优；批处理行为由 QMD 本身控制。
- **首次搜索可能较慢**：QMD 可能在第一次 `qmd query` 运行时下载本地 GGUF 模型（重排序/查询扩展）。
  - OpenClaw 运行 QMD 时自动设置 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`。
  - 如果你想手动预下载模型（并预热 OpenClaw 使用的相同索引），使用 agent 的 XDG 目录运行一次查询。

    OpenClaw 的 QMD 状态位于你的**状态目录**（默认为 `~/.openclaw`）。你可以通过导出相同的 XDG 变量将 `qmd` 指向相同的索引：

    ```bash
    # 选择 OpenClaw 使用的相同状态目录
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # （可选）强制索引刷新 + 嵌入
    qmd update
    qmd embed

    # 预热 / 触发首次模型下载
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**配置界面（`memory.qmd.*`）**

- `command`（默认 `qmd`）：覆盖可执行文件路径。
- `searchMode`（默认 `search`）：选择哪个 QMD 命令支持 `memory_search`（`search`、`vsearch`、`query`）。
- `includeDefaultMemory`（默认 `true`）：自动索引 `MEMORY.md` + `memory/**/*.md`。
- `paths[]`：添加额外的目录/文件（`path`、可选的 `pattern`、可选的稳定 `name`）。
- `sessions`：选择加入会话 JSONL 索引（`enabled`、`retentionDays`、`exportDir`）。
- `update`：控制刷新节奏和维护执行（`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、`commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`）。
- `limits`：限制召回负载（`maxResults`、`maxSnippetChars`、`maxInjectedChars`、`timeoutMs`）。
- `scope`：与 [`session.sendPolicy`](/gateway/configuration#session) 相同的模式。默认仅 DM（`deny` 所有，允许直接聊天）；放宽以在群组/频道中显示 QMD 结果。
  - `match.keyPrefix` 匹配**规范化**的会话键（小写，去掉所有开头的 `agent:<id>:`）。例如：`discord:channel:`。
  - `match.rawKeyPrefix` 匹配**原始**会话键（小写），包括 `agent:<id>:`。例如：`agent:main:discord:`。
  - 旧版：`match.keyPrefix: "agent:..."` 仍被视为原始键前缀，为清晰起见请优先使用 `rawKeyPrefix`。
- 当 `scope` 拒绝搜索时，OpenClaw 会记录包含派生 `channel`/`chatType` 的警告，以便更轻松地调试空结果。
- 来自工作空间外的片段在 `memory_search` 结果中显示为 `qmd/<collection>/<relative-path>`；`memory_get` 理解该前缀并从配置的 QMD collection 根目录读取。
- 当 `memory.qmd.sessions.enabled = true` 时，OpenClaw 导出经过清理的会话记录（用户/助手回合）到 `~/.openclaw/agents/<id>/qmd/sessions/` 下的专用 QMD collection，以便 `memory_search` 可以回忆最近的对话，而无需触碰内置 SQLite 索引。
- 当 `memory.citations` 为 `auto`/`on` 时，`memory_search` 片段现在包含 `Source: <path#line>` 页脚；设置 `memory.citations = "off"` 可保持路径元数据内部化（agent 仍会收到 `memory_get` 的路径，但片段文本省略页脚，系统提示警告 agent 不要引用它）。

**示例**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        // 规范化会话键前缀（去除 `agent:<id>:`）。
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // 原始会话键前缀（包含 `agent:<id>:`）。
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**引用和回退**

- `memory.citations` 无论后端如何都适用（`auto`/`on`/`off`）。
- 当 `qmd` 运行时，我们标记 `status().backend = "qmd"`，以便诊断显示哪个引擎提供了结果。如果 QMD 子进程退出或无法解析 JSON 输出，搜索管理器记录警告并返回内置提供者（现有的 Markdown 嵌入），直到 QMD 恢复。

### 额外记忆路径

如果你想索引默认工作空间布局之外的 Markdown 文件，添加显式路径：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

说明：

- 路径可以是绝对路径或工作空间相对路径。
- 目录会递归扫描 `.md` 文件。
- 仅索引 Markdown 文件。
- 符号链接被忽略（文件或目录）。

### Gemini 嵌入（原生）

将提供商设置为 `gemini` 以直接使用 Gemini 嵌入 API：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

说明：

- `remote.baseUrl` 是可选的（默认为 Gemini API 基础 URL）。
- `remote.headers` 让你可以在需要时添加额外的标头。
- 默认模型：`gemini-embedding-001`。

如果你想使用**自定义 OpenAI 兼容端点**（OpenRouter、vLLM 或代理），可以使用 `remote` 配置与 OpenAI 提供商：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

如果你不想设置 API 密钥，使用 `memorySearch.provider = "local"` 或设置 `memorySearch.fallback = "none"`。

回退：

- `memorySearch.fallback` 可以是 `openai`、`gemini`、`voyage`、`mistral`、`local` 或 `none`。
- 回退提供商仅在主嵌入提供商失败时使用。

批量索引（OpenAI + Gemini）：

- OpenAI 和 Gemini 嵌入默认启用。设置 `agents.defaults.memorySearch.remote.batch.enabled = false` 以禁用。
- 默认行为等待批处理完成；如果需要可以调整 `remote.batch.wait`、`remote.batch.pollIntervalMs` 和 `remote.batch.timeoutMinutes`。
- 设置 `remote.batch.concurrency` 以控制我们并行提交多少个批处理作业（默认：2）。
- 批处理模式在 `memorySearch.provider = "openai"` 或 `"gemini"` 时适用，并使用相应的 API 密钥。
- Gemini 批处理作业使用异步嵌入批处理端点，需要 Gemini Batch API 可用。

为什么 OpenAI 批处理快速又便宜：

- 对于大型回填，OpenAI 通常是我们支持的最快选项，因为我们可以在单个批处理作业中提交许多嵌入请求，让 OpenAI 异步处理它们。
- OpenAI 为 Batch API 工作负载提供折扣定价，因此大型索引运行通常比同步发送相同请求更便宜。
- 详情参见 OpenAI Batch API 文档和定价：
  - https://platform.openai.com/docs/api-reference/batch
  - https://platform.openai.com/pricing

配置示例：

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

工具：

- `memory_search` — 返回带有文件 + 行范围的片段。
- `memory_get` — 按路径读取记忆文件内容。

本地模式：

- 设置 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath`（GGUF 或 `hf:` URI）。
- 可选：设置 `agents.defaults.memorySearch.fallback = "none"` 以避免远程回退。

### 记忆工具的工作原理

- `memory_search` 从 `MEMORY.md` + `memory/**/*.md` 语义搜索 Markdown 块（目标约 400 个 token，80 个 token 重叠）。它返回片段文本（上限约 700 个字符）、文件路径、行范围、分数、提供商/模型，以及我们是否从本地回退到远程嵌入。不返回完整文件内容。
- `memory_get` 读取特定的记忆 Markdown 文件（工作空间相对路径），可选从起始行开始读取 N 行。`MEMORY.md` / `memory/` 之外的路径仅在明确列在 `memorySearch.extraPaths` 中时才允许。
- 两个工具仅在智能体的 `memorySearch.enabled` 解析为 true 时启用。

### 索引内容（及时机）

- 文件类型：仅 Markdown（`MEMORY.md`、`memory/**/*.md`，以及 `memorySearch.extraPaths` 下的任何 `.md` 文件）。
- 索引存储：每个智能体的 SQLite 位于 `~/.openclaw/memory/<agentId>.sqlite`（可通过 `agents.defaults.memorySearch.store.path` 配置，支持 `{agentId}` 令牌）。
- 新鲜度：监视器监视 `MEMORY.md`、`memory/` 和 `memorySearch.extraPaths`，标记索引为脏（去抖动 1.5 秒）。同步在会话开始时、搜索时或按间隔安排，并异步运行。会话记录使用增量阈值触发后台同步。
- 重新索引触发器：索引存储嵌入的**提供商/模型 + 端点指纹 + 分块参数**。如果其中任何一个发生变化，OpenClaw 会自动重置并重新索引整个存储。

### 混合搜索（BM25 + 向量）

启用时，OpenClaw 结合：

- **向量相似度**（语义匹配，措辞可以不同）
- **BM25 关键词相关性**（精确令牌如 ID、环境变量、代码符号）

如果你的平台上全文搜索不可用，OpenClaw 会回退到纯向量搜索。

#### 为什么使用混合搜索？

向量搜索擅长"这意味着同一件事"：

- "Mac Studio gateway host" vs "运行 gateway 的机器"
- "debounce file updates" vs "避免每次写入都索引"

但它在精确的高信号令牌上可能较弱：

- ID（`a828e60`、`b3b9895a…`）
- 代码符号（`memorySearch.query.hybrid`）
- 错误字符串（"sqlite-vec unavailable"）

BM25（全文）正好相反：擅长精确令牌，弱于释义。
混合搜索是务实的中间地带：**同时使用两种检索信号**，这样你可以在"自然语言"查询和"大海捞针"查询上都获得好结果。

#### 我们如何合并结果（当前设计）

实现概述：

1. 从双方检索候选池：

- **向量**：按余弦相似度取前 `maxResults * candidateMultiplier` 个。
- **BM25**：按 FTS5 BM25 排名取前 `maxResults * candidateMultiplier` 个（越低越好）。

2. 将 BM25 排名转换为 0..1 范围的分数：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 按块 id 合并候选并计算加权分数：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

说明：

- 在配置解析中 `vectorWeight` + `textWeight` 归一化为 1.0，因此权重表现为百分比。
- 如果嵌入不可用（或提供商返回零向量），我们仍然运行 BM25 并返回关键词匹配。
- 如果无法创建 FTS5，我们保持纯向量搜索（不会硬失败）。

这不是"IR 理论完美"的，但它简单、快速，并且往往能提高真实笔记的召回率/精确率。
如果我们以后想要更复杂的方案，常见的下一步是倒数排名融合（RRF）或在混合之前进行分数归一化（最小/最大或 z 分数）。

配置：

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

#### 后处理管道

在合并向量得分与关键词得分之后，会通过两个可选的后处理阶段，在结果返回给智能体之前对结果列表进行优化：

```
向量 + 关键词 → 加权合并 → 时间衰减 → 排序 → MMR → Top-K 结果
```

两个阶段都**默认关闭**，可以独立启用。

#### MMR 重排序（多样性）

当混合搜索返回结果时，多个文本片段可能包含相似或重叠的内容。例如，搜索"家庭网络设置"时，可能会从不同的日常笔记中返回五条几乎相同的摘要，它们都提到了相同的路由器配置。

**MMR（最大边际相关性）**会对结果进行重排序，在相关性与多样性之间做平衡，确保返回的靠前结果覆盖查询的不同方面，而不是重复相同信息。

工作原理：

1. 结果按原始相关性评分（向量 + BM25 加权分数）。
2. MMR 迭代选择使 `λ × 相关性 − (1−λ) × 与已选结果的最大相似度`最大化的结果。
3. 结果之间的相似度使用分词内容的 Jaccard 文本相似度来衡量。

`lambda` 参数控制权衡：

- `lambda = 1.0` → 纯相关性（无多样性惩罚）
- `lambda = 0.0` → 最大多样性（忽略相关性）
- 默认值：`0.7`（平衡，略微偏向相关性）

**示例 — 查询："家庭网络设置"**

给定这些记忆文件：

```
memory/2026-02-10.md  → "配置了 Omada 路由器，为 IoT 设备设置了 VLAN 10"
memory/2026-02-08.md  → "配置了 Omada 路由器，将 IoT 移到 VLAN 10"
memory/2026-02-05.md  → "在 192.168.10.2 上设置了 AdGuard DNS"
memory/network.md     → "路由器：Omada ER605，AdGuard：192.168.10.2，VLAN 10：IoT"
```

无 MMR — 前 3 结果：

```
1. memory/2026-02-10.md  (分数: 0.92)  ← 路由器 + VLAN
2. memory/2026-02-08.md  (分数: 0.89)  ← 路由器 + VLAN（几乎重复！）
3. memory/network.md     (分数: 0.85)  ← 参考文档
```

有 MMR (λ=0.7) — 前 3 结果：

```
1. memory/2026-02-10.md  (分数: 0.92)  ← 路由器 + VLAN
2. memory/network.md     (分数: 0.85)  ← 参考文档（多样性！）
3. memory/2026-02-05.md  (分数: 0.78)  ← AdGuard DNS（多样性！）
```

2 月 8 日的几乎重复内容被淘汰，智能体获得了三个不同的信息片段。

**何时启用：** 如果你注意到 `memory_search` 返回冗余或几乎重复的片段，特别是日常笔记经常在多天内重复相似信息时。

#### 时间衰减（近因提升）

拥有每日笔记的智能体会随着时间积累数百个带日期的文件。如果没有衰减，六个月前措辞良好的笔记可能超过同一主题的昨天更新。

**时间衰减**根据每个结果的年龄应用指数乘数，使近期记忆自然排名更高，而旧记忆逐渐淡出：

```
衰减分数 = 分数 × e^(-λ × 年龄天数)
```

其中 `λ = ln(2) / 半衰期天数`。

默认半衰期 30 天：

- 今天的笔记：**100%** 原始分数
- 7 天前：**~84%**
- 30 天前：**50%**
- 90 天前：**12.5%**
- 180 天前：**~1.6%**

**永久文件永不衰减：**

- `MEMORY.md`（根记忆文件）
- `memory/` 中的无日期文件（例如 `memory/projects.md`、`memory/network.md`）
- 这些包含持久参考信息的文件应始终正常排名

**带日期的日常文件**（`memory/YYYY-MM-DD.md`）使用从文件名提取的日期。其他来源（例如会话记录）回退到文件修改时间（`mtime`）。

**示例 — 查询："Rod 的工作时间表是什么？"**

给定这些记忆文件（今天是 2 月 10 日）：

```
memory/2025-09-15.md  → "Rod 工作周一至周五，站会在上午 10 点，配对在下午 2 点"  (148 天前)
memory/2026-02-10.md  → "Rod 的站会在 14:15，与 Zeb 的 1:1 在 14:45"    (今天)
memory/2026-02-03.md  → "Rod 加入了新团队，站会改到 14:15"        (7 天前)
```

无衰减：

```
1. memory/2025-09-15.md  (分数: 0.91)  ← 最佳语义匹配，但过时了！
2. memory/2026-02-10.md  (分数: 0.82)
3. memory/2026-02-03.md  (分数: 0.80)
```

有衰减（半衰期=30）：

```
1. memory/2026-02-10.md  (分数: 0.82 × 1.00 = 0.82)  ← 今天，无衰减
2. memory/2026-02-03.md  (分数: 0.80 × 0.85 = 0.68)  ← 7 天，轻度衰减
3. memory/2025-09-15.md  (分数: 0.91 × 0.03 = 0.03)  ← 148 天，几乎消失
```

尽管有最佳的原始语义匹配，过时的 9 月笔记排名降到最底部。

**何时启用：** 如果你的智能体有多个月的每日笔记，你发现旧的、过时的信息超过最近的上下文。30 天的半衰期对每日笔记密集的工作流程效果很好；如果你经常引用较旧的笔记，可以增加（例如 90 天）。

#### 配置

这两项功能均在 `memorySearch.query.hybrid` 下进行配置：

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // Diversity: reduce redundant results
          mmr: {
            enabled: true,    // 默认值: false
            lambda: 0.7       // 0 = max diversity, 1 = max relevance
          },
          // Recency: boost newer memories
          temporalDecay: {
            enabled: true,    // 默认值: false
            halfLifeDays: 30  // score halves every 30 days
          }
        }
      }
    }
  }
}
```

### 嵌入缓存

OpenClaw 可以在 SQLite 中缓存**块嵌入**，这样重新索引和频繁更新（特别是会话记录）不会重新嵌入未更改的文本。

配置：

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### 会话记忆搜索（实验性）

你可以选择性地索引**会话记录**并通过 `memory_search` 呈现它们。
这由实验性标志控制。

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

说明：

- 会话索引是**选择加入**的（默认关闭）。
- 会话更新被去抖动并在超过增量阈值后**异步索引**（尽力而为）。
- `memory_search` 永远不会阻塞索引；在后台同步完成之前，结果可能略有延迟。
- 结果仍然只包含片段；`memory_get` 仍然仅限于记忆文件。
- 会话索引按智能体隔离（仅索引该智能体的会话日志）。
- 会话日志存储在磁盘上（`~/.openclaw/agents/<agentId>/sessions/*.jsonl`）。任何具有文件系统访问权限的进程/用户都可以读取它们，因此将磁盘访问视为信任边界。对于更严格的隔离，在单独的操作系统用户或主机下运行智能体。

增量阈值（显示默认值）：

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL 行数
        }
      }
    }
  }
}
```

### SQLite 向量加速（sqlite-vec）

当 sqlite-vec 扩展可用时，OpenClaw 将嵌入存储在 SQLite 虚拟表（`vec0`）中，并在数据库中执行向量距离查询。这使搜索保持快速，无需将每个嵌入加载到 JS 中。

配置（可选）：

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

说明：

- `enabled` 默认为 true；禁用时，搜索回退到对存储嵌入的进程内余弦相似度计算。
- 如果 sqlite-vec 扩展缺失或加载失败，OpenClaw 会记录错误并继续使用 JS 回退（无向量表）。
- `extensionPath` 覆盖捆绑的 sqlite-vec 路径（对于自定义构建或非标准安装位置很有用）。

### 本地嵌入自动下载

- 默认本地嵌入模型：`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`（约 0.6 GB）。
- 当 `memorySearch.provider = "local"` 时，`node-llama-cpp` 解析 `modelPath`；如果 GGUF 缺失，它会**自动下载**到缓存（或 `local.modelCacheDir`，如果已设置），然后加载它。下载在重试时会续传。
- 原生构建要求：运行 `pnpm approve-builds`，选择 `node-llama-cpp`，然后运行 `pnpm rebuild node-llama-cpp`。
- 回退：如果本地设置失败且 `memorySearch.fallback = "openai"`，我们自动切换到远程嵌入（`openai/text-embedding-3-small`，除非被覆盖）并记录原因。

### 自定义 OpenAI 兼容端点示例

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

说明：

- `remote.*` 优先于 `models.providers.openai.*`。
- `remote.headers` 与 OpenAI 标头合并；键冲突时 remote 优先。省略 `remote.headers` 以使用 OpenAI 默认值。
