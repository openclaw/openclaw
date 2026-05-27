---
read_when:
  - 你想通过 LiteLLM 代理路由 OpenClaw
  - 你需要通过 LiteLLM 进行成本跟踪、日志记录或模型路由
summary: 通过 LiteLLM Proxy 运行 OpenClaw，以实现统一模型访问和成本跟踪
x-i18n:
  generated_at: "2026-03-16T06:25:50Z"
  model: gpt-5.4
  provider: openai
  source_hash: 269529671c60864972441606c730b5ca327546a45d3b264dbd03204c4401936f
  source_path: providers/litellm.md
  workflow: 15
---

# LiteLLM

[LiteLLM](https://litellm.ai) 是一个开源 LLM 网关，可为 100+ 模型提供商提供统一 API。通过 LiteLLM 路由 OpenClaw，你可以获得集中式成本跟踪、日志记录，以及在不更改 OpenClaw 配置的情况下切换后端的灵活性。

## 为什么要将 LiteLLM 与 OpenClaw 搭配使用？

- **成本跟踪** —— 精确查看 OpenClaw 在所有模型上的花费
- **模型路由** —— 无需更改配置，即可在 Claude、GPT-4、Gemini、Bedrock 之间切换
- **虚拟密钥** —— 为 OpenClaw 创建带有支出限制的密钥
- **日志记录** —— 提供完整的请求/响应日志，便于调试
- **回退** —— 如果你的主要提供商宕机，可自动故障切换

## 快速开始

### 通过新手引导

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 手动设置

1. 启动 LiteLLM Proxy：

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. 将 OpenClaw 指向 LiteLLM：

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

就是这样。OpenClaw 现在会通过 LiteLLM 进行路由。

## 配置

### 环境变量

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 配置文件

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

## 虚拟密钥

为 OpenClaw 创建一个带支出限制的专用密钥：

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

将生成的密钥用作 `LITELLM_API_KEY`。

## 模型路由

LiteLLM 可以将模型请求路由到不同后端。在你的 LiteLLM `config.yaml` 中进行配置：

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

OpenClaw 会继续请求 `claude-opus-4-6` —— 路由由 LiteLLM 处理。

## 查看使用情况

检查 LiteLLM 的仪表板或 API：

```bash
# 密钥信息
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# 支出日志
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 说明

- LiteLLM 默认运行在 `http://localhost:4000`
- OpenClaw 通过兼容 OpenAI 的 `/v1/chat/completions` 端点连接
- 所有 OpenClaw 功能都可通过 LiteLLM 使用 —— 没有限制

## 另请参见

- [LiteLLM 文档](https://docs.litellm.ai)
- [模型提供商](/concepts/model-providers)
