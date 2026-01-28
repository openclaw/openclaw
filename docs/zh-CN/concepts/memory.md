---
read_when:
  - 想了解记忆文件布局和工作流程
  - 想调整自动预压缩记忆刷写
summary: OpenClaw 记忆的工作原理（工作区文件 + 自动记忆刷写）
title: 记忆
x-i18n:
  generated_at: "2026-02-01T20:24:01Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f3a7f5d9f61f9742eb3a8adbc3ccaddeadb7e48ceccdfb595327d6d1f55cd00e
  source_path: concepts/memory.md
  workflow: 14
---

# 记忆

OpenClaw 的记忆是**智能体工作区中的纯 Markdown 文件**。这些文件是唯一的事实来源；模型只"记住"写入磁盘的内容。

记忆搜索工具由活跃的记忆插件提供（默认：`memory-core`）。通过 `plugins.slots.memory = "none"` 可禁用记忆插件。

## 记忆文件（Markdown）

默认工作区布局使用两个记忆层：

- `memory/YYYY-MM-DD.md`
  - 每日日志（仅追加）。
  - 会话开始时读取今天和昨天的内容。
- `MEMORY.md`（可选）
  - 精心整理的长期记忆。
  - **仅在主要的私人会话中加载**（不在群组上下文中加载）。

这些文件位于工作区目录下（`agents.defaults.workspace`，默认 `~/.openclaw/workspace`）。完整布局参见[智能体工作区](/concepts/agent-workspace)。

## 何时写入记忆

- 决策、偏好和持久性事实写入 `MEMORY.md`。
- 日常笔记和运行上下文写入 `memory/YYYY-MM-DD.md`。
- 如果有人说"记住这个"，就写下来（不要只保留在内存中）。
- 这个领域仍在发展中。提醒模型存储记忆会有帮助；它知道该怎么做。
- 如果你想让某些信息持久保留，**让机器人把它写入**记忆。

## 自动记忆刷写（预压缩 ping）

当会话**接近自动压缩**时，OpenClaw 会触发一个**静默的智能体轮次**，提醒模型在上下文被压缩**之前**写入持久记忆。默认提示词明确表示模型*可以回复*，但通常 `NO_REPLY` 是正确的响应，这样用户不会看到这个轮次。

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

- **软阈值**：当会话 token 估计值超过 `contextWindow - reserveTokensFloor - softThresholdTokens` 时触发刷写。
- 默认**静默**：提示词包含 `NO_REPLY`，因此不会传递任何内容。
- **两个提示词**：一个用户提示词加一个系统提示词附加提醒。
- **每个压缩周期刷写一次**（在 `sessions.json` 中跟踪）。
- **工作区必须可写**：如果会话以 `workspaceAccess: "ro"` 或 `"none"` 在沙箱中运行，则跳过刷写。

完整的压缩生命周期参见[会话管理 + 压缩](/reference/session-management-compaction)。

## 向量记忆搜索

OpenClaw 可以对 `MEMORY.md` 和 `memory/*.md`（以及你选择加入的任何额外目录或文件）构建小型向量索引，这样即使措辞不同，语义查询也能找到相关笔记。

默认设置：

- 默认启用。
- 监视记忆文件变更（带防抖）。
- 默认使用远程嵌入。如果未设置 `memorySearch.provider`，OpenClaw 会自动选择：
  1. 如果配置了 `memorySearch.local.modelPath` 且文件存在，则使用 `local`。
  2. 如果可以解析到 OpenAI 密钥，则使用 `openai`。
  3. 如果可以解析到 Gemini 密钥，则使用 `gemini`。
  4. 否则记忆搜索保持禁用，直到完成配置。
- 本地模式使用 node-llama-cpp，可能需要运行 `pnpm approve-builds`。
- 使用 sqlite-vec（可用时）加速 SQLite 内的向量搜索。

远程嵌入**需要**嵌入提供商的 API 密钥。OpenClaw 从认证配置文件、`models.providers.*.apiKey` 或环境变量中解析密钥。Codex OAuth 仅覆盖 chat/completions，**不满足**记忆搜索的嵌入需求。对于 Gemini，使用 `GEMINI_API_KEY` 或 `models.providers.google.apiKey`。使用自定义 OpenAI 兼容端点时，设置 `memorySearch.remote.apiKey`（以及可选的 `memorySearch.remote.headers`）。

### 额外记忆路径

如果你想索引默认工作区布局之外的 Markdown 文件，添加显式路径：

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

注意事项：

- 路径可以是绝对路径或工作区相对路径。
- 目录会递归扫描 `.md` 文件。
- 仅索引 Markdown 文件。
- 符号链接会被忽略（文件或目录）。

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

注意事项：

- `remote.baseUrl` 是可选的（默认为 Gemini API 基础 URL）。
- `remote.headers` 允许你在需要时添加额外的请求头。
- 默认模型：`gemini-embedding-001`。

如果你想使用**自定义 OpenAI 兼容端点**（OpenRouter、vLLM 或代理），可以在 OpenAI 提供商下使用 `remote` 配置：

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

回退策略：

- `memorySearch.fallback` 可以是 `openai`、`gemini`、`local` 或 `none`。
- 回退提供商仅在主嵌入提供商失败时使用。

批量索引（OpenAI + Gemini）：

- OpenAI 和 Gemini 嵌入默认启用批量索引。设置 `agents.defaults.memorySearch.remote.batch.enabled = false` 可禁用。
- 默认行为等待批量完成；如需调整，请调节 `remote.batch.wait`、`remote.batch.pollIntervalMs` 和 `remote.batch.timeoutMinutes`。
- 设置 `remote.batch.concurrency` 控制并行提交的批量作业数（默认：2）。
- 批量模式在 `memorySearch.provider = "openai"` 或 `"gemini"` 时适用，并使用相应的 API 密钥。
- Gemini 批量作业使用异步嵌入批量端点，需要 Gemini Batch API 可用。

为什么 OpenAI 批量又快又便宜：

- 对于大规模回填，OpenAI 通常是我们支持的最快选项，因为我们可以在单个批量作业中提交多个嵌入请求，让 OpenAI 异步处理。
- OpenAI 为 Batch API 工作负载提供折扣定价，因此大规模索引运行通常比同步发送相同请求更便宜。
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

- `memory_search` — 返回包含文件路径和行范围的片段。
- `memory_get` — 按路径读取记忆文件内容。

本地模式：

- 设置 `agents.defaults.memorySearch.provider = "local"`。
- 提供 `agents.defaults.memorySearch.local.modelPath`（GGUF 或 `hf:` URI）。
- 可选：设置 `agents.defaults.memorySearch.fallback = "none"` 以避免远程回退。

### 记忆工具的工作原理

- `memory_search` 对来自 `MEMORY.md` + `memory/**/*.md` 的 Markdown 分块（约 400 token 目标，80 token 重叠）进行语义搜索。返回片段文本（上限约 700 字符）、文件路径、行范围、分数、提供商/模型，以及是否从本地回退到了远程嵌入。不返回完整文件内容。
- `memory_get` 读取特定的记忆 Markdown 文件（工作区相对路径），可选从起始行读取 N 行。`MEMORY.md` / `memory/` 之外的路径仅在 `memorySearch.extraPaths` 中显式列出时才允许访问。
- 两个工具仅在 `memorySearch.enabled` 对智能体解析为 true 时启用。

### 索引内容（及时机）

- 文件类型：仅 Markdown（`MEMORY.md`、`memory/**/*.md`，以及 `memorySearch.extraPaths` 下的任何 `.md` 文件）。
- 索引存储：每个智能体的 SQLite 位于 `~/.openclaw/memory/<agentId>.sqlite`（可通过 `agents.defaults.memorySearch.store.path` 配置，支持 `{agentId}` 占位符）。
- 时效性：监视 `MEMORY.md`、`memory/` 和 `memorySearch.extraPaths` 的变更并标记索引为脏（防抖 1.5 秒）。同步在会话开始时、搜索时或按间隔调度，并异步运行。会话记录使用增量阈值触发后台同步。
- 重新索引触发条件：索引存储嵌入的**提供商/模型 + 端点指纹 + 分块参数**。如果其中任何一项发生变化，OpenClaw 会自动重置并重新索引整个存储。

### 混合搜索（BM25 + 向量）

启用后，OpenClaw 结合以下两种方式：

- **向量相似度**（语义匹配，措辞可以不同）
- **BM25 关键词相关性**（精确 token，如 ID、环境变量、代码符号）

如果你的平台上全文搜索不可用，OpenClaw 会回退到纯向量搜索。

#### 为什么用混合搜索？

向量搜索擅长"这表达的是同一个意思"：

- "Mac Studio gateway 主机" vs "运行 gateway 的机器"
- "防抖文件更新" vs "避免每次写入都索引"

但对于精确的高信号 token 可能较弱：

- ID（`a828e60`、`b3b9895a…`）
- 代码符号（`memorySearch.query.hybrid`）
- 错误字符串（"sqlite-vec unavailable"）

BM25（全文搜索）恰好相反：擅长精确 token，较弱于同义改写。混合搜索是务实的折中方案：**同时使用两种检索信号**，这样"自然语言"查询和"大海捞针"查询都能获得好结果。

#### 我们如何合并结果（当前设计）

实现概要：

1. 从两端检索候选池：

- **向量**：按余弦相似度取前 `maxResults * candidateMultiplier` 个。
- **BM25**：按 FTS5 BM25 排名取前 `maxResults * candidateMultiplier` 个（值越低越好）。

2. 将 BM25 排名转换为 0..1 范围的分数：

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. 按分块 ID 合并候选并计算加权分数：

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注意事项：

- 在配置解析时 `vectorWeight` + `textWeight` 会归一化到 1.0，因此权重表现为百分比。
- 如果嵌入不可用（或提供商返回零向量），我们仍会运行 BM25 并返回关键词匹配结果。
- 如果无法创建 FTS5，我们保持纯向量搜索（不会硬失败）。

这不是"信息检索理论上的完美方案"，但它简单、快速，在实际笔记上倾向于提升召回率/精确率。如果以后想更精细，常见的下一步是互惠排名融合（RRF）或混合前的分数归一化（最小/最大值或 z-score）。

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

### 嵌入缓存

OpenClaw 可以在 SQLite 中缓存**分块嵌入**，这样重新索引和频繁更新（特别是会话记录）不会重新嵌入未更改的文本。

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

你可以选择索引**会话记录**并通过 `memory_search` 进行搜索。此功能受实验性标志控制。

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

注意事项：

- 会话索引是**选择加入**的（默认关闭）。
- 会话更新带防抖，在超过增量阈值后**异步索引**（尽力而为）。
- `memory_search` 不会阻塞等待索引；在后台同步完成之前结果可能略有延迟。
- 结果仍然只包含片段；`memory_get` 仍限于记忆文件。
- 会话索引按智能体隔离（仅索引该智能体的会话日志）。
- 会话日志存储在磁盘上（`~/.openclaw/agents/<agentId>/sessions/*.jsonl`）。任何拥有文件系统访问权限的进程/用户都可以读取它们，因此应将磁盘访问视为信任边界。如需更严格的隔离，请在不同的操作系统用户或主机下运行智能体。

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

当 sqlite-vec 扩展可用时，OpenClaw 将嵌入存储在 SQLite 虚拟表（`vec0`）中，并在数据库内执行向量距离查询。这使搜索保持快速，无需将所有嵌入加载到 JS 中。

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

注意事项：

- `enabled` 默认为 true；禁用时，搜索回退到对存储嵌入进行进程内余弦相似度计算。
- 如果 sqlite-vec 扩展缺失或加载失败，OpenClaw 会记录错误并继续使用 JS 回退（无向量表）。
- `extensionPath` 覆盖捆绑的 sqlite-vec 路径（适用于自定义构建或非标准安装位置）。

### 本地嵌入自动下载

- 默认本地嵌入模型：`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`（约 0.6 GB）。
- 当 `memorySearch.provider = "local"` 时，`node-llama-cpp` 解析 `modelPath`；如果 GGUF 文件缺失，会**自动下载**到缓存目录（或 `local.modelCacheDir`，如已设置），然后加载。下载在重试时可恢复。
- 原生构建要求：运行 `pnpm approve-builds`，选择 `node-llama-cpp`，然后运行 `pnpm rebuild node-llama-cpp`。
- 回退：如果本地设置失败且 `memorySearch.fallback = "openai"`，我们会自动切换到远程嵌入（`openai/text-embedding-3-small`，除非被覆盖）并记录原因。

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

注意事项：

- `remote.*` 优先于 `models.providers.openai.*`。
- `remote.headers` 与 OpenAI 请求头合并；键冲突时 remote 优先。省略 `remote.headers` 则使用 OpenAI 默认值。
