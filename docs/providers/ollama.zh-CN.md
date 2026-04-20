---
summary: "使用 Ollama 运行 OpenClaw（云模型和本地模型）"
read_when:
  - 你想通过 Ollama 运行 OpenClaw 云模型或本地模型
  - 你需要 Ollama 设置和配置指南
title: "Ollama"
---

# Ollama

OpenClaw 集成了 Ollama 的原生 API（`/api/chat`），用于托管云模型和本地/自托管 Ollama 服务器。你可以在三种模式下使用 Ollama：通过可访问的 Ollama 主机的 `云 + 本地`、针对 `https://ollama.com` 的 `仅云`，或针对可访问的 Ollama 主机的 `仅本地`。

<Warning>
**远程 Ollama 用户**：不要在 OpenClaw 中使用 `/v1` OpenAI 兼容 URL（`http://host:11434/v1`）。这会破坏工具调用，模型可能会将原始工具 JSON 作为纯文本输出。请使用原生 Ollama API URL 代替：`baseUrl: "http://host:11434"`（无 `/v1`）。
</Warning>

## 入门指南

选择你首选的设置方法和模式。

<Tabs>
  <Tab title="引导设置（推荐）">
    **最适合：** 最快的 Ollama 云或本地设置路径。

    <Steps>
      <Step title="运行引导设置">
        ```bash
        openclaw onboard
        ```

        从提供商列表中选择 **Ollama**。
      </Step>
      <Step title="选择你的模式">
        - **云 + 本地** — 本地 Ollama 主机加上通过该主机路由的云模型
        - **仅云** — 通过 `https://ollama.com` 托管的 Ollama 模型
        - **仅本地** — 仅本地模型
      </Step>
      <Step title="选择模型">
        `仅云` 提示输入 `OLLAMA_API_KEY` 并建议托管云默认值。`云 + 本地` 和 `仅本地` 要求 Ollama 基础 URL，发现可用模型，如果所选本地模型尚未可用，则自动拉取。`云 + 本地` 还会检查该 Ollama 主机是否已登录以进行云访问。
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider ollama
        ```
      </Step>
    </Steps>

    ### 非交互模式

    ```bash
    openclaw onboard --non-interactive \
      --auth-choice ollama \
      --accept-risk
    ```

    可选择指定自定义基础 URL 或模型：

    ```bash
    openclaw onboard --non-interactive \
      --auth-choice ollama \
      --custom-base-url "http://ollama-host:11434" \
      --custom-model-id "qwen3.5:27b" \
      --accept-risk
    ```

  </Tab>

  <Tab title="手动设置">
    **最适合：** 完全控制云或本地设置。

    <Steps>
      <Step title="选择云或本地">
        - **云 + 本地**：安装 Ollama，使用 `ollama signin` 登录，并通过该主机路由云请求
        - **仅云**：使用 `https://ollama.com` 和 `OLLAMA_API_KEY`
        - **仅本地**：从 [ollama.com/download](https://ollama.com/download) 安装 Ollama
      </Step>
      <Step title="拉取本地模型（仅本地）">
        ```bash
        ollama pull gemma4
        # 或
        ollama pull gpt-oss:20b
        # 或
        ollama pull llama3.3
        ```
      </Step>
      <Step title="为 OpenClaw 启用 Ollama">
        对于 `仅云`，使用你真实的 `OLLAMA_API_KEY`。对于主机支持的设置，任何占位符值都有效：

        ```bash
        # 云
        export OLLAMA_API_KEY="your-ollama-api-key"

        # 仅本地
        export OLLAMA_API_KEY="ollama-local"

        # 或在配置文件中配置
        openclaw config set models.providers.ollama.apiKey "OLLAMA_API_KEY"
        ```
      </Step>
      <Step title="检查并设置你的模型">
        ```bash
        openclaw models list
        openclaw models set ollama/gemma4
        ```

        或在配置中设置默认值：

        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "ollama/gemma4" },
            },
          },
        }
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 云模型

<Tabs>
  <Tab title="云 + 本地">
    `云 + 本地` 使用可访问的 Ollama 主机作为本地和云模型的控制点。这是 Ollama 首选的混合流程。

    在设置期间使用 **云 + 本地**。OpenClaw 提示输入 Ollama 基础 URL，从该主机发现本地模型，并检查主机是否已通过 `ollama signin` 登录以进行云访问。当主机已登录时，OpenClaw 还会建议托管云默认值，例如 `kimi-k2.5:cloud`、`minimax-m2.7:cloud` 和 `glm-5.1:cloud`。

    如果主机尚未登录，OpenClaw 会保持设置为仅本地，直到你运行 `ollama signin`。

  </Tab>

  <Tab title="仅云">
    `仅云` 针对 Ollama 在 `https://ollama.com` 的托管 API 运行。

    在设置期间使用 **仅云**。OpenClaw 提示输入 `OLLAMA_API_KEY`，设置 `baseUrl: "https://ollama.com"`，并种子化托管云模型列表。此路径**不需要**本地 Ollama 服务器或 `ollama signin`。

  </Tab>

  <Tab title="仅本地">
    在仅本地模式下，OpenClaw 从配置的 Ollama 实例发现模型。此路径适用于本地或自托管的 Ollama 服务器。

    OpenClaw 目前建议 `gemma4` 作为本地默认值。

  </Tab>
</Tabs>

## 模型发现（隐式提供商）

当你设置 `OLLAMA_API_KEY`（或认证配置文件）并且**未**定义 `models.providers.ollama` 时，OpenClaw 会从 `http://127.0.0.1:11434` 的本地 Ollama 实例发现模型。

| 行为             | 详情                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目录查询         | 查询 `/api/tags`                                                                                                                                                 |
| 功能检测         | 使用尽力而为的 `/api/show` 查找来读取 `contextWindow` 并检测功能（包括视觉）                                                                                     |
| 视觉模型         | 由 `/api/show` 报告具有 `vision` 功能的模型被标记为图像功能（`input: ["text", "image"]`），因此 OpenClaw 会自动将图像注入提示                                   |
| 推理检测         | 使用模型名称启发式（`r1`、`reasoning`、`think`）标记 `reasoning`                                                                                                 |
| 令牌限制         | 将 `maxTokens` 设置为 OpenClaw 使用的默认 Ollama 最大令牌上限                                                                                                   |
| 成本             | 将所有成本设置为 `0`                                                                                                                                             |

这避免了手动模型条目，同时保持目录与本地 Ollama 实例对齐。

```bash
# 查看可用的模型
ollama list
openclaw models list
```

要添加新模型，只需使用 Ollama 拉取它：

```bash
ollama pull mistral
```

新模型将被自动发现并可供使用。

<Note>
如果你显式设置 `models.providers.ollama`，则会跳过自动发现，你必须手动定义模型。请参阅下面的显式配置部分。
</Note>

## 配置

<Tabs>
  <Tab title="基本（隐式发现）">
    最简单的仅本地启用路径是通过环境变量：

    ```bash
export OLLAMA_API_KEY="ollama-local"
    ```

    <Tip>
    如果设置了 `OLLAMA_API_KEY`，你可以在提供商条目中省略 `apiKey`，OpenClaw 会为可用性检查填充它。
    </Tip>

  </Tab>

  <Tab title="显式（手动模型）">
    当你想要托管云设置、Ollama 在另一台主机/端口上运行、想要强制特定的上下文窗口或模型列表，或想要完全手动的模型定义时，使用显式配置。

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
            api: "ollama",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "kimi-k2.5:cloud",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192
              }
            ]
          }
        }
      }
    }
    ```

  </Tab>

  <Tab title="自定义基础 URL">
    如果 Ollama 在不同的主机或端口上运行（显式配置会禁用自动发现，因此请手动定义模型）：

    ```json5
    {
      models: {
        providers: {
          ollama: {
            apiKey: "ollama-local",
            baseUrl: "http://ollama-host:11434", // 无 /v1 - 使用原生 Ollama API URL
            api: "ollama", // 显式设置以保证原生工具调用行为
          },
        },
      },
    }
    ```

    <Warning>
    不要在 URL 中添加 `/v1`。`/v1` 路径使用 OpenAI 兼容模式，其中工具调用不可靠。使用不带路径后缀的基础 Ollama URL。
    </Warning>

  </Tab>
</Tabs>

### 模型选择

配置后，所有 Ollama 模型都可用：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## Ollama 网络搜索

OpenClaw 支持 **Ollama 网络搜索**作为捆绑的 `web_search` 提供商。

| 属性    | 详情                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| 主机    | 使用你配置的 Ollama 主机（设置了 `models.providers.ollama.baseUrl` 时，否则为 `http://127.0.0.1:11434`）        |
| 认证    | 无需密钥                                                                                                          |
| 要求    | Ollama 必须运行并通过 `ollama signin` 登录                                                                         |

在 `openclaw onboard` 或 `openclaw configure --section web` 期间选择 **Ollama 网络搜索**，或设置：

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

<Note>
有关完整的设置和行为详细信息，请参阅 [Ollama 网络搜索](/tools/ollama-search)。
</Note>

## 高级配置

<AccordionGroup>
  <Accordion title="旧版 OpenAI 兼容模式">
    <Warning>
    **在 OpenAI 兼容模式下工具调用不可靠。** 仅当你需要 OpenAI 格式用于代理且不依赖原生工具调用行为时才使用此模式。
    </Warning>

    如果你需要使用 OpenAI 兼容端点（例如，在仅支持 OpenAI 格式的代理后面），请显式设置 `api: "openai-completions"`：

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434/v1",
            api: "openai-completions",
            injectNumCtxForOpenAICompat: true, // 默认：true
            apiKey: "ollama-local",
            models: [...]
          }
        }
      }
    }
    ```

    此模式可能不同时支持流式传输和工具调用。你可能需要在模型配置中使用 `params: { streaming: false }` 禁用流式传输。

    当 `api: "openai-completions"` 与 Ollama 一起使用时，OpenClaw 默认会注入 `options.num_ctx`，因此 Ollama 不会静默回退到 4096 上下文窗口。如果你的代理/上游拒绝未知的 `options` 字段，请禁用此行为：

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434/v1",
            api: "openai-completions",
            injectNumCtxForOpenAICompat: false,
            apiKey: "ollama-local",
            models: [...]
          }
        }
      }
    }
    ```

  </Accordion>

  <Accordion title="上下文窗口">
    对于自动发现的模型，OpenClaw 使用 Ollama 报告的上下文窗口（如果可用），否则回退到 OpenClaw 使用的默认 Ollama 上下文窗口。

    你可以在显式提供商配置中覆盖 `contextWindow` 和 `maxTokens`：

    ```json5
    {
      models: {
        providers: {
          ollama: {
            models: [
              {
                id: "llama3.3",
                contextWindow: 131072,
                maxTokens: 65536,
              }
            ]
          }
        }
      }
    }
    ```

  </Accordion>

  <Accordion title="推理模型">
    OpenClaw 默认将名称如 `deepseek-r1`、`reasoning` 或 `think` 的模型视为具有推理能力。

    ```bash
    ollama pull deepseek-r1:32b
    ```

    不需要额外配置 - OpenClaw 会自动标记它们。

  </Accordion>

  <Accordion title="模型成本">
    Ollama 是免费的并在本地运行，因此所有模型成本都设置为 $0。这适用于自动发现和手动定义的模型。
  </Accordion>

  <Accordion title="记忆嵌入">
    捆绑的 Ollama 插件注册了一个用于 [记忆搜索](/concepts/memory) 的记忆嵌入提供商。它使用配置的 Ollama 基础 URL 和 API 密钥。

    | 属性      | 值               |
    | --------- | ---------------- |
    | 默认模型  | `nomic-embed-text`  |
    | 自动拉取  | 是 — 如果本地不存在，嵌入模型会自动被拉取 |

    要选择 Ollama 作为记忆搜索嵌入提供商：

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: { provider: "ollama" },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="流式配置">
    OpenClaw 的 Ollama 集成默认使用**原生 Ollama API**（`/api/chat`），该 API 完全支持同时流式传输和工具调用。不需要特殊配置。

    <Tip>
    如果你需要使用 OpenAI 兼容端点，请参阅上面的"旧版 OpenAI 兼容模式"部分。在该模式下，流式传输和工具调用可能不同时工作。
    </Tip>

  </Accordion>
</AccordionGroup>

## 故障排除

<AccordionGroup>
  <Accordion title="未检测到 Ollama">
    确保 Ollama 正在运行，你设置了 `OLLAMA_API_KEY`（或认证配置文件），并且你**未**定义显式的 `models.providers.ollama` 条目：

    ```bash
    ollama serve
    ```

    验证 API 是否可访问：

    ```bash
    curl http://localhost:11434/api/tags
    ```

  </Accordion>

  <Accordion title="没有可用模型">
    如果你的模型未列出，请在本地拉取模型或在 `models.providers.ollama` 中显式定义它。

    ```bash
    ollama list  # 查看已安装的内容
    ollama pull gemma4
    ollama pull gpt-oss:20b
    ollama pull llama3.3     # 或其他模型
    ```

  </Accordion>

  <Accordion title="连接被拒绝">
    检查 Ollama 是否在正确的端口上运行：

    ```bash
    # 检查 Ollama 是否运行
    ps aux | grep ollama

    # 或重启 Ollama
    ollama serve
    ```

  </Accordion>
</AccordionGroup>

<Note>
更多帮助：[故障排除](/help/troubleshooting) 和 [常见问题](/help/faq)。
</Note>

## 相关

<CardGroup cols={2}>
  <Card title="模型提供商" href="/concepts/model-providers" icon="layers">
    所有提供商、模型引用和故障转移行为的概述。
  </Card>
  <Card title="模型选择" href="/concepts/models" icon="brain">
    如何选择和配置模型。
  </Card>
  <Card title="Ollama 网络搜索" href="/tools/ollama-search" icon="magnifying-glass">
    Ollama 驱动的网络搜索的完整设置和行为详细信息。
  </Card>
  <Card title="配置" href="/gateway/configuration" icon="gear">
    完整的配置参考。
  </Card>
</CardGroup>