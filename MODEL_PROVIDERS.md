# Model Providers 配置说明

本文档记录 infist 部署（`openclaw-gateway-huiling`）的模型 provider 配置及使用方式。

## 当前 Provider 列表

配置文件位于服务器 `/home/wellingwong/.openclaw/openclaw.json`。

### `claude-sub2api`

| 字段        | 值                                         |
| ----------- | ------------------------------------------ |
| Base URL    | `http://api.infinite-status.com`           |
| API 格式    | `anthropic-messages`（`x-api-key` 请求头） |
| API Key     | 见服务器配置                               |
| UI 模型列表 | 空（不在 UI 选择器中显示）                 |

**说明**：这是 sub2api 中转网关，代理到真实的 Anthropic API。Provider key 不能用 `anthropic`，否则 OpenClaw 会命中内置注册表直接打 `api.anthropic.com`。

**可用模型（透传给网关，网关支持即可）**：

- `claude-sub2api/claude-sonnet-4-6` ← 当前 agent 默认主模型
- `claude-sub2api/claude-opus-4-6`
- 其他 Claude 模型同理

---

### `openai`

| 字段     | 值                            |
| -------- | ----------------------------- |
| Base URL | `https://newapi.infist.cn/v1` |
| API 格式 | OpenAI-compat（默认）         |
| API Key  | 环境变量 `OPENAI_API_KEY`     |

**UI 模型列表**：

| 模型 ID                  | 名称                   | 用途                                       |
| ------------------------ | ---------------------- | ------------------------------------------ |
| `gpt-4.1`                | GPT-4.1                | 对话 / 任务                                |
| `text-embedding-3-small` | Text Embedding 3 Small | 向量嵌入（memory search 专用，非对话模型） |

> `text-embedding-3-small` 用于启用 OpenClaw 长期记忆功能，配置见下文。

---

### `gemini`

| 字段     | 值                            |
| -------- | ----------------------------- |
| Base URL | `https://newapi.infist.cn/v1` |
| API 格式 | OpenAI-compat（同一中转网关） |
| API Key  | 环境变量 `OPENAI_API_KEY`     |

**UI 模型列表**：

| 模型 ID                             | 名称                      | 输入        |
| ----------------------------------- | ------------------------- | ----------- |
| `gemini-3-pro-preview`              | Gemini 3 Pro Preview      | 文本 + 图像 |
| `gemini-2.5-flash-lite`             | Gemini 2.5 Flash Lite     | 文本 + 图像 |
| `deep-research-pro-preview-12-2025` | Deep Research Pro Preview | 文本        |
| `gemini-2.5-flash-image`            | Gemini 2.5 Flash Image    | 文本 + 图像 |

---

## Agent 默认模型配置

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-sub2api/claude-sonnet-4-6"
      }
    }
  }
}
```

格式为 `<provider-key>/<model-id>`，provider key 对应 `models.providers` 里的 key 名称。

### 配置 fallback（可选）

主模型失败时自动降级：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-sub2api/claude-sonnet-4-6",
        "fallbacks": ["openai/gpt-4.1"]
      }
    }
  }
}
```

### 图像任务专用模型（可选）

```json
{
  "agents": {
    "defaults": {
      "imageModel": {
        "primary": "gemini/gemini-2.5-flash-image"
      }
    }
  }
}
```

### 启用长期记忆（可选）

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "model": "openai/text-embedding-3-small"
      }
    }
  }
}
```

---

## 在消息窗口指定模型

### Discord

使用原生 slash 命令（在频道内输入）：

```
/model
```

会弹出交互式模型选择器，显示 `models.providers` 里配置了 UI 列表的模型。

也可以直接告诉 agent：

> "请用 `gemini/gemini-2.5-flash-lite` 回答这个问题"

### 飞书 / 所有渠道

直接在消息里指定：

> "用 `openai/gpt-4.1` 帮我总结这段文字"

或者用 slash 命令（如果 native commands 已启用）：

```
/model gemini/gemini-2.5-flash-lite
```

### 临时切换 vs 永久切换

- **临时**：在消息里说明，仅影响当前对话
- **永久**：修改服务器上 `openclaw.json` 的 `agents.defaults.model.primary`，重启或等待热更新生效

---

## Provider 配置注意事项

1. **不能用内置 provider 名覆盖自定义网关**：`anthropic`、`openai`、`google-gemini` 等是 OpenClaw 内置 provider 名，用这些名字时，OpenClaw 会优先命中内置模型注册表，忽略你的 `baseUrl` 配置。需要自定义网关时，使用非内置名称（如 `claude-sub2api`）。

2. **`models` 列表是 UI 目录，不限制可用模型**：`models.providers.<key>.models` 只影响 `/model` 选择器显示的内容。Agent 可以使用该 provider 下任意模型 ID，只要网关支持即可。

3. **Gemini 走 OpenAI-compat 格式**：`newapi.infist.cn` 中转网关对 Gemini 模型也支持 OpenAI 兼容格式，无需切换为 `google-generative-ai` API 格式。

4. **API Key 解析优先级**（以 anthropic 为例）：
   - 环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN`
   - `models.providers.<key>.apiKey`（config 文件）
   - `agents/<id>/auth-profiles.json`（per-agent auth store）
