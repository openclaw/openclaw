---
summary: "配置 Moonshot Kimi 与 Kimi Coding（单独的提供商和密钥）"
read_when:
  - 你想要 Moonshot K2（Moonshot 开放平台）与 Kimi Coding 的设置
  - 你需要了解单独的端点、密钥和模型引用
  - 你想要任一提供商的复制粘贴配置
title: "Moonshot AI"
---

# Moonshot AI（Kimi）

Moonshot 提供 Kimi API，具有 OpenAI 兼容的端点。配置提供商并将默认模型设置为 `moonshot/kimi-k2.5`，或者将 Kimi Coding 与 `kimi/kimi-code` 一起使用。

<Warning>
Moonshot 和 Kimi Coding 是**单独的提供商**。密钥不可互换，端点不同，模型引用也不同（`moonshot/` 与 `kimi/`）。
</Warning>

## 内置模型目录

[//]: # "moonshot-kimi-k2-ids:start"

| 模型引用 | 名称 | 思考 | 输入 | 上下文 | 最大输出 |
| --------------------------------- | -------------------- | --------- | ----------- | ------- | ---------- |
| `moonshot/kimi-k2.5` | Kimi K2.5 | No | text, image | 262,144 | 262,144 |
| `moonshot/kimi-k2-thinking` | Kimi K2 Thinking | Yes | text | 262,144 | 262,144 |
| `moonshot/kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo | Yes | text | 262,144 | 262,144 |
| `moonshot/kimi-k2-turbo` | Kimi K2 Turbo | No | text | 256,000 | 16,384 |

[//]: # "moonshot-kimi-k2-ids:end"

## 开始使用

选择你的提供商并按照设置步骤操作。

<Tabs>
  <Tab title="Moonshot API">
    **最适合：** 通过 Moonshot 开放平台的 Kimi K2 模型。

    <Steps>
      <Step title="选择你的端点区域">
        | 认证选择 | 端点 | 区域 |
        | -------------------- | ----------------------------- | ------------- |
        | `moonshot-api-key` | `https://api.moonshot.ai/v1` | 国际 |
        | `moonshot-api-key-cn` | `https://api.moonshot.cn/v1` | 中国 |
      </Step>
      <Step title="运行设置向导">
        ```bash
        openclaw onboard --auth-choice moonshot-api-key
        ```

        或者对于中国端点：

        ```bash
        openclaw onboard --auth-choice moonshot-api-key-cn
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "moonshot/kimi-k2.5" },
            },
          },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider moonshot
        ```
      </Step>
    </Steps>

    ### 配置示例

    ```json5
    {
      env: { MOONSHOT_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "moonshot/kimi-k2.5" },
          models: {
            // moonshot-kimi-k2-aliases:start
            "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
            "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
            "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
            "moonshot/kimi-k2-turbo": { alias: "Kimi K2 Turbo" },
            // moonshot-kimi-k2-aliases:end
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "${MOONSHOT_API_KEY}",
            api: "openai-completions",
            models: [
              // moonshot-kimi-k2-models:start
              {
                id: "kimi-k2.5",
                name: "Kimi K2.5",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking",
                name: "Kimi K2 Thinking",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking-turbo",
                name: "Kimi K2 Thinking Turbo",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-turbo",
                name: "Kimi K2 Turbo",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 16384,
              },
              // moonshot-kimi-k2-models:end
            ],
          },
        },
      },
    }
    ```

  </Tab>

  <Tab title="Kimi Coding">
    **最适合：** 通过 Kimi Coding 端点的专注于编程的任务。

    <Note>
    Kimi Coding 使用与 Moonshot 不同的 API 密钥和提供商前缀（`kimi/`）。旧版模型引用 `kimi/k2p5` 仍然作为兼容性 ID 被接受。
    </Note>

    <Steps>
      <Step title="运行设置向导">
        ```bash
        openclaw onboard --auth-choice kimi-code-api-key
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "kimi/kimi-code" },
            },
          },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider kimi
        ```
      </Step>
    </Steps>

    ### 配置示例

    ```json5
    {
      env: { KIMI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-code" },
          models: {
            "kimi/kimi-code": { alias: "Kimi" },
          },
        },
      },
    }
    ```

  </Tab>
</Tabs>

## Kimi 网页搜索

OpenClaw 还附带 **Kimi** 作为 `web_search` 提供商，由 Moonshot 网页搜索提供支持。

<Steps>
  <Step title="运行交互式网页搜索设置">
    ```bash
    openclaw configure --section web
    ```

    在网页搜索部分选择 **Kimi** 以存储 `plugins.entries.moonshot.config.webSearch.*`。

  </Step>
  <Step title="配置网页搜索区域和模型">
    交互式设置会提示：

    | 设置 | 选项 |
    | ------------------- | -------------------------------------------------------------------- |
    | API 区域 | `https://api.moonshot.ai/v1`（国际）或 `https://api.moonshot.cn/v1`（中国） |
    | 网页搜索模型 | 默认为 `kimi-k2.5` |

  </Step>
</Steps>

配置位于 `plugins.entries.moonshot.config.webSearch` 下：

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // 或使用 KIMI_API_KEY / MOONSHOT_API_KEY
            baseUrl: "https://api.moonshot.ai/v1",
            model: "kimi-k2.5",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

## 高级配置

<AccordionGroup>
  <Accordion title="原生思考模式">
    Moonshot Kimi 支持二进制原生思考：

    - `thinking: { type: "enabled" }`
    - `thinking: { type: "disabled" }`

    通过 `agents.defaults.models.<provider/model>.params` 为每个模型配置：

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.5": {
              params: {
                thinking: { type: "disabled" },
              },
            },
          },
        },
      },
    }
    ```

    OpenClaw 还会为 Moonshot 映射运行时 `/think` 级别：

    | `/think` 级别 | Moonshot 行为 |
    | -------------------- | -------------------------- |
    | `/think off` | `thinking.type=disabled` |
    | 任何非关闭级别 | `thinking.type=enabled` |

    <Warning>
    当 Moonshot 思考启用时，`tool_choice` 必须是 `auto` 或 `none`。为了兼容性，OpenClaw 会将不兼容的 `tool_choice` 值标准化为 `auto`。
    </Warning>

  </Accordion>

  <Accordion title="流式使用兼容性">
    原生 Moonshot 端点（`https://api.moonshot.ai/v1` 和 `https://api.moonshot.cn/v1`）在共享的 `openai-completions` 传输上宣传流式使用兼容性。OpenClaw 现在会将端点功能与密钥关联，因此针对相同原生 Moonshot 主机的兼容自定义提供商 ID 会继承相同的流式使用行为。
  </Accordion>

  <Accordion title="端点和模型引用参考">
    | 提供商 | 模型引用前缀 | 端点 | 认证环境变量 |
    | ---------- | ---------------- | ----------------------------- | ------------------- |
    | Moonshot | `moonshot/` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
    | Moonshot CN | `moonshot/` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
    | Kimi Coding | `kimi/` | Kimi Coding 端点 | `KIMI_API_KEY` |
    | 网页搜索 | 不适用 | 与 Moonshot API 区域相同 | `KIMI_API_KEY` 或 `MOONSHOT_API_KEY` |

    - Kimi 网页搜索使用 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`，默认为 `https://api.moonshot.ai/v1` 和模型 `kimi-k2.5`。
    - 如需，请在 `models.providers` 中覆盖定价和上下文元数据。
    - 如果 Moonshot 为某个模型发布不同的上下文限制，请相应调整 `contextWindow`。

  </Accordion>
</AccordionGroup>

## 相关内容

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="网页搜索" href="/tools/web-search" icon="magnifying-glass">
    配置包括 Kimi 在内的网页搜索提供商。
  </Card>
  <Card title="配置参考" href="/gateway/configuration-reference" icon="gear">
    提供商、模型和插件的完整配置架构。
  </Card>
  <Card title="Moonshot 开放平台" href="https://platform.moonshot.ai" icon="globe">
    Moonshot API 密钥管理和文档。
  </Card>
</CardGroup>
