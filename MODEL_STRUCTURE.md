# Agent 模型结构说明

本文档记录当前 infist 部署（`openclaw-gateway-huiling`）的 Agent 模型分工结构。
配置文件位于服务器 `/home/wellingwong/.openclaw/openclaw.json`。

---

## 模型分工总览

```
用户消息
    │
    ▼
主对话（Primary）
  claude-sub2api / claude-sonnet-4-6
  fallback → gemini / gemini-2.5-flash-lite
    │
    ├── 需要工具调用 / 子任务？
    │       │
    │       ▼
    │   Subagent（工具执行 / 搜索 / 子任务）
    │     openai / gpt-4.1
    │     fallback → google / gemini-2.5-flash
    │
    └── 需要联网搜索？
            │
            ▼
        Web Search Provider
          Gemini 2.5 Flash（Google 原生 API）
```

---

## 主对话模型

| 角色     | 模型                    | Provider         | 用途                 |
| -------- | ----------------------- | ---------------- | -------------------- |
| Primary  | `claude-sonnet-4-6`     | `claude-sub2api` | 默认主对话模型       |
| Fallback | `gemini-2.5-flash-lite` | `gemini`         | 主模型失败时自动降级 |

**配置字段**：`agents.defaults.model`

---

## Subagent 模型

| 角色     | 模型               | Provider | 用途                 |
| -------- | ------------------ | -------- | -------------------- |
| Primary  | `gpt-4.1`          | `openai` | 工具调用、子任务执行 |
| Fallback | `gemini-2.5-flash` | `google` | gpt-4.1 失败时降级   |

**配置字段**：`agents.defaults.subagents.model`

> Subagent 单独配置的原因：`claude-sub2api` 通过代理层传输，tool calling 参数有时会丢失（空 `{}`）。`gpt-4.1` 直连 `newapi.infist.cn`，tool calling 更稳定。

---

## Web Search Provider

| 字段     | 值                                                 |
| -------- | -------------------------------------------------- |
| Provider | `gemini`                                           |
| 模型     | `gemini-2.5-flash`                                 |
| API      | Google 原生（`generativelanguage.googleapis.com`） |
| Key 来源 | Google AI Studio（直连，不走 newapi 中转）         |

**配置字段**：`tools.web.search`

---

## 可选模型列表（`/model` 选择器）

### `claude-sub2api`（Anthropic via sub2api 中转）

| 模型 ID             | 名称              |
| ------------------- | ----------------- |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-opus-4-6`   | Claude Opus 4.6   |

### `gemini`（Google via newapi.infist.cn，OpenAI-compat）

| 模型 ID                             | 名称                      | 输入                      |
| ----------------------------------- | ------------------------- | ------------------------- |
| `gemini-3-pro-preview`              | Gemini 3 Pro Preview      | 文本 + 图像               |
| `gemini-2.5-flash-lite`             | Gemini 2.5 Flash Lite     | 文本 + 图像               |
| `gemini-2.5-flash-image`            | Gemini 2.5 Flash Image    | 文本 + 图像               |
| `deep-research-pro-preview-12-2025` | Deep Research Pro Preview | 文本（⚠️ 不可用，见下注） |

### `google`（Google 原生 API，直连）

| 模型 ID            | 名称             | 输入        |
| ------------------ | ---------------- | ----------- |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 文本 + 图像 |
| `gemini-2.5-pro`   | Gemini 2.5 Pro   | 文本 + 图像 |
| `gemini-2.0-flash` | Gemini 2.0 Flash | 文本 + 图像 |

### `openai`（via newapi.infist.cn，OpenAI-compat）

| 模型 ID   | 名称    | 输入        |
| --------- | ------- | ----------- |
| `gpt-4.1` | GPT-4.1 | 文本 + 图像 |

---

## 注意事项

### ⚠️ `deep-research-pro-preview-12-2025` 不可用

该模型仅支持 Google Interactions API，与 newapi.infist.cn 的 OpenAI-compat 格式不兼容，调用会返回：

```
400 This model only supports Interactions API.
```

openclaw 目前没有实现 Interactions API 支持，此模型无法使用。
**替代方案**：使用 `google/gemini-2.5-flash` 或 `google/gemini-2.5-pro`（原生 API），配合 web search 工具完成深度研究任务。

### `/model` 切换说明

- 切换后对当前 session 生效，不影响其他对话
- 重置回默认：`/model` → Reset to default，或发消息 `用 claude-sub2api/claude-sonnet-4-6`
- Subagent 模型不受 `/model` 切换影响，始终使用 `openai/gpt-4.1`
