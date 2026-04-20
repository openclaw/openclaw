---
summary: "审计哪些功能可能花费资金，使用哪些密钥，以及如何查看使用情况"
read_when:
  - 您想了解哪些功能可能调用付费 API
  - 您需要审计密钥、成本和使用情况可见性
  - 您正在解释 /status 或 /usage 成本报告
title: "API 使用和成本"
---

# API 使用和成本

本文档列出**可能调用 API 密钥的功能**以及它们的成本显示位置。它重点关注
可能生成提供商使用或付费 API 调用的 OpenClaw 功能。

## 成本显示位置（聊天 + CLI）

**每会话成本快照**

- `/status` 显示当前会话模型、上下文使用情况和最后响应的令牌。
- 如果模型使用**API 密钥认证**，`/status` 还会显示**估计成本**（仅最后一条回复）。
- 如果实时会话元数据稀疏，`/status` 可以从最新的转录使用条目中恢复令牌/缓存
  计数器和活动运行时模型标签。现有的非零实时值仍然优先，当存储的总数缺失或较小时，提示大小的
  转录总数可能会获胜。

**每条消息成本页脚**

- `/usage full` 会在每条回复后添加使用情况页脚，包括**估计成本**（仅 API 密钥）。
- `/usage tokens` 仅显示令牌；订阅式 OAuth/令牌和 CLI 流程隐藏美元成本。
- Gemini CLI 注意：当 CLI 返回 JSON 输出时，OpenClaw 从
  `stats` 读取使用情况，将 `stats.cached` 标准化为 `cacheRead`，并在需要时从 `stats.input_tokens - stats.cached` 派生输入令牌。

Anthropic 注意：Anthropic 工作人员告诉我们，OpenClaw 风格的 Claude CLI 使用再次被允许，因此 OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为
除非 Anthropic 发布新政策，否则此集成是受制裁的。
Anthropic 仍然没有公开 OpenClaw 可以在 `/usage full` 中显示的每条消息美元估计。

**CLI 使用窗口（提供商配额）**

- `openclaw status --usage` 和 `openclaw channels list` 显示提供商**使用窗口**
  （配额快照，而非每条消息成本）。
- 人类输出在提供商之间标准化为 `剩余 X%`。
- 当前使用窗口提供商：Anthropic、GitHub Copilot、Gemini CLI、
  OpenAI Codex、MiniMax、Xiaomi 和 z.ai。
- MiniMax 注意：其原始 `usage_percent` / `usagePercent` 字段表示剩余
  配额，因此 OpenClaw 在显示前将其反转。当存在时，基于计数的字段仍然优先。如果提供商返回 `model_remains`，OpenClaw 优先选择聊天模型条目，在需要时从时间戳派生窗口标签，并在计划标签中包含模型名称。
- 这些配额窗口的使用认证来自可用时的提供商特定钩子；否则 OpenClaw 回退到匹配来自认证配置文件、环境或配置的 OAuth/API 密钥凭证。

有关详细信息和示例，请参阅 [令牌使用和成本](/reference/token-use)。

## 密钥如何被发现

OpenClaw 可以从以下位置获取凭证：

- **认证配置文件**（每个代理，存储在 `auth-profiles.json` 中）。
- **环境变量**（例如 `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **配置**（`models.providers.*.apiKey`、`plugins.entries.*.config.webSearch.apiKey`、
  `plugins.entries.firecrawl.config.webFetch.apiKey`、`memorySearch.*`、
  `talk.providers.*.apiKey`）。
- **技能**（`skills.entries.<name>.apiKey`）可能会将密钥导出到技能进程环境中。

## 可能花费密钥的功能

### 1) 核心模型响应（聊天 + 工具）

每条回复或工具调用都使用**当前模型提供商**（OpenAI、Anthropic 等）。这是
使用和成本的主要来源。

这还包括仍然在 OpenClaw 本地 UI 外计费的订阅式托管提供商，例如**OpenAI Codex**、**阿里云模型工作室
编码计划**、**MiniMax 编码计划**、**Z.AI / GLM 编码计划**，以及
启用了**额外使用**的 Anthropic 的 OpenClaw Claude 登录路径。

有关定价配置，请参阅 [模型](/providers/models)，有关显示，请参阅 [令牌使用和成本](/reference/token-use)。

### 2) 媒体理解（音频/图像/视频）

入站媒体可以在回复运行前进行总结/转录。这使用模型/提供商 API。

- 音频：OpenAI / Groq / Deepgram / Google / Mistral。
- 图像：OpenAI / OpenRouter / Anthropic / Google / MiniMax / Moonshot / Qwen / Z.AI。
- 视频：Google / Qwen / Moonshot。

请参阅 [媒体理解](/nodes/media-understanding)。

### 3) 图像和视频生成

共享生成功能也可以花费提供商密钥：

- 图像生成：OpenAI / Google / fal / MiniMax
- 视频生成：Qwen

当 `agents.defaults.imageGenerationModel` 未设置时，图像生成可以推断一个基于认证的提供商默认值。视频生成目前
需要一个显式的 `agents.defaults.videoGenerationModel`，例如
`qwen/wan2.6-t2v`。

请参阅 [图像生成](/tools/image-generation)、[Qwen Cloud](/providers/qwen)，
和 [模型](/concepts/models)。

### 4) 记忆嵌入 + 语义搜索

语义记忆搜索在为远程提供商配置时使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- `memorySearch.provider = "mistral"` → Mistral 嵌入
- `memorySearch.provider = "lmstudio"` → LM Studio 嵌入（本地/自托管）
- `memorySearch.provider = "ollama"` → Ollama 嵌入（本地/自托管；通常无托管 API 计费）
- 如果本地嵌入失败，可选回退到远程提供商

您可以通过 `memorySearch.provider = "local"` 保持本地（无 API 使用）。

请参阅 [记忆](/concepts/memory)。

### 5) 网络搜索工具

`web_search` 可能根据您的提供商产生使用费用：

- **Brave Search API**：`BRAVE_API_KEY` 或 `plugins.entries.brave.config.webSearch.apiKey`
- **Exa**：`EXA_API_KEY` 或 `plugins.entries.exa.config.webSearch.apiKey`
- **Firecrawl**：`FIRECRAWL_API_KEY` 或 `plugins.entries.firecrawl.config.webSearch.apiKey`
- **Gemini (Google Search)**：`GEMINI_API_KEY` 或 `plugins.entries.google.config.webSearch.apiKey`
- **Grok (xAI)**：`XAI_API_KEY` 或 `plugins.entries.xai.config.webSearch.apiKey`
- **Kimi (Moonshot)**：`KIMI_API_KEY`、`MOONSHOT_API_KEY` 或 `plugins.entries.moonshot.config.webSearch.apiKey`
- **MiniMax Search**：`MINIMAX_CODE_PLAN_KEY`、`MINIMAX_CODING_API_KEY`、`MINIMAX_API_KEY` 或 `plugins.entries.minimax.config.webSearch.apiKey`
- **Ollama Web Search**：默认无密钥，但需要可访问的 Ollama 主机加上 `ollama signin`；当主机需要时，也可以重用正常的 Ollama 提供商承载认证
- **Perplexity Search API**：`PERPLEXITY_API_KEY`、`OPENROUTER_API_KEY` 或 `plugins.entries.perplexity.config.webSearch.apiKey`
- **Tavily**：`TAVILY_API_KEY` 或 `plugins.entries.tavily.config.webSearch.apiKey`
- **DuckDuckGo**：无密钥回退（无 API 计费，但非官方且基于 HTML）
- **SearXNG**：`SEARXNG_BASE_URL` 或 `plugins.entries.searxng.config.webSearch.baseUrl`（无密钥/自托管；无托管 API 计费）

旧版 `tools.web.search.*` 提供商路径仍然通过临时兼容性垫片加载，但它们不再是推荐的配置表面。

**Brave Search 免费信用额度**：每个 Brave 计划包含每月 $5 的可再生
免费信用额度。搜索计划每 1,000 个请求花费 $5，因此信用额度涵盖
每月 1,000 个请求，无需收费。在 Brave 仪表板中设置您的使用限制
以避免意外收费。

请参阅 [Web 工具](/tools/web)。

### 5) Web 获取工具（Firecrawl）

当 API 密钥存在时，`web_fetch` 可以调用**Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `plugins.entries.firecrawl.config.webFetch.apiKey`

如果未配置 Firecrawl，该工具会回退到直接获取 + 可读性（无付费 API）。

请参阅 [Web 工具](/tools/web)。

### 6) 提供商使用快照（状态/健康）

一些状态命令调用**提供商使用端点**来显示配额窗口或认证健康。
这些通常是低量调用，但仍然会访问提供商 API：

- `openclaw status --usage`
- `openclaw models status --json`

请参阅 [模型 CLI](/cli/models)。

### 7) 压缩保障总结

压缩保障可以使用**当前模型**总结会话历史，
当它运行时会调用提供商 API。

请参阅 [会话管理 + 压缩](/reference/session-management-compaction)。

### 8) 模型扫描 / 探测

`openclaw models scan` 可以探测 OpenRouter 模型，并在
启用探测时使用 `OPENROUTER_API_KEY`。

请参阅 [模型 CLI](/cli/models)。

### 9) Talk（语音）

Talk 模式在配置时可以调用**ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.providers.elevenlabs.apiKey`

请参阅 [Talk 模式](/nodes/talk)。

### 10) 技能（第三方 API）

技能可以在 `skills.entries.<name>.apiKey` 中存储 `apiKey`。如果技能将该密钥用于外部
API，它可能会根据技能的提供商产生成本。

请参阅 [技能](/tools/skills)。
