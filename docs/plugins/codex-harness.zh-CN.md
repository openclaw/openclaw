---
title: "Codex 执行器"
summary: "通过捆绑的 Codex 应用服务器执行器运行 OpenClaw 嵌入式代理轮次"
read_when:
  - 你想使用捆绑的 Codex 应用服务器执行器
  - 你需要 Codex 模型引用和配置示例
  - 你想为仅 Codex 部署禁用 PI 回退
---

# Codex 执行器

捆绑的 `codex` 插件允许 OpenClaw 通过 Codex 应用服务器而不是内置的 PI 执行器运行嵌入式代理轮次。

当你希望 Codex 拥有低级代理会话时使用此功能：模型发现、原生线程恢复、原生压缩和应用服务器执行。OpenClaw 仍然拥有聊天通道、会话文件、模型选择、工具、审批、媒体传递和可见记录镜像。

执行器默认关闭。只有当 `codex` 插件启用且解析的模型是 `codex/*` 模型，或者你明确强制 `embeddedHarness.runtime: "codex"` 或 `OPENCLAW_AGENT_RUNTIME=codex` 时，才会选择它。如果你从未配置 `codex/*`，现有的 PI、OpenAI、Anthropic、Gemini、本地和自定义提供商运行将保持其当前行为。

## 选择正确的模型前缀

OpenClaw 为 OpenAI 和 Codex 形状的访问提供单独的路由：

| 模型引用              | 运行时路径                                 | 使用场景                                                                |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `openai/gpt-5.4`       | 通过 OpenClaw/PI 管道的 OpenAI 提供商 | 你想要使用 `OPENAI_API_KEY` 直接访问 OpenAI Platform API。       |
| `openai-codex/gpt-5.4` | 通过 PI 的 OpenAI Codex OAuth 提供商       | 你想要 ChatGPT/Codex OAuth 而不需要 Codex 应用服务器执行器。      |
| `codex/gpt-5.4`        | 捆绑的 Codex 提供商加上 Codex 执行器    | 你想要为嵌入式代理轮次使用原生 Codex 应用服务器执行。 |

Codex 执行器仅声明 `codex/*` 模型引用。现有的 `openai/*`、`openai-codex/*`、Anthropic、Gemini、xAI、本地和自定义提供商引用保持其正常路径。

## 要求

- 带有可用捆绑 `codex` 插件的 OpenClaw。
- Codex 应用服务器 `0.118.0` 或更新版本。
- 应用服务器进程可使用的 Codex 认证。

插件会阻止较旧或未版本化的应用服务器握手。这使 OpenClaw 保持在它已经测试过的协议接口上。

对于实时和 Docker 烟雾测试，认证通常来自 `OPENAI_API_KEY`，加上可选的 Codex CLI 文件，如 `~/.codex/auth.json` 和 `~/.codex/config.toml`。使用与本地 Codex 应用服务器相同的认证材料。

## 最小配置

使用 `codex/gpt-5.4`，启用捆绑插件，并强制使用 `codex` 执行器：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "codex/gpt-5.4",
      embeddedHarness: {
        runtime: "codex",
        fallback: "none",
      },
    },
  },
}
```

如果你的配置使用 `plugins.allow`，也在那里包含 `codex`：

```json5
{
  plugins: {
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

将 `agents.defaults.model` 或代理模型设置为 `codex/<model>` 也会自动启用捆绑的 `codex` 插件。显式插件条目在共享配置中仍然有用，因为它使部署意图更加明确。

## 添加 Codex 而不替换其他模型

当你希望 `codex/*` 模型使用 Codex，其他所有模型使用 PI 时，保持 `runtime: "auto"`：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "codex/gpt-5.4",
        fallbacks: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      },
      models: {
        "codex/gpt-5.4": { alias: "codex" },
        "codex/gpt-5.4-mini": { alias: "codex-mini" },
        "openai/gpt-5.4": { alias: "gpt" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },
      embeddedHarness: {
        runtime: "auto",
        fallback: "pi",
      },
    },
  },
}
```

使用这种配置：

- `/model codex` 或 `/model codex/gpt-5.4` 使用 Codex 应用服务器执行器。
- `/model gpt` 或 `/model openai/gpt-5.4` 使用 OpenAI 提供商路径。
- `/model opus` 使用 Anthropic 提供商路径。
- 如果选择了非 Codex 模型，PI 仍然是兼容性执行器。

## 仅 Codex 部署

当你需要证明每个嵌入式代理轮次都使用 Codex 执行器时，禁用 PI 回退：

```json5
{
  agents: {
    defaults: {
      model: "codex/gpt-5.4",
      embeddedHarness: {
        runtime: "codex",
        fallback: "none",
      },
    },
  },
}
```

环境覆盖：

```bash
OPENCLAW_AGENT_RUNTIME=codex \
OPENCLAW_AGENT_HARNESS_FALLBACK=none \
openclaw gateway run
```

禁用回退后，如果 Codex 插件被禁用、请求的模型不是 `codex/*` 引用、应用服务器太旧或应用服务器无法启动，OpenClaw 会早期失败。

## 每个代理的 Codex

你可以使一个代理仅使用 Codex，而默认代理保持正常的自动选择：

```json5
{
  agents: {
    defaults: {
      embeddedHarness: {
        runtime: "auto",
        fallback: "pi",
      },
    },
    list: [
      {
        id: "main",
        default: true,
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "codex",
        name: "Codex",
        model: "codex/gpt-5.4",
        embeddedHarness: {
          runtime: "codex",
          fallback: "none",
        },
      },
    ],
  },
}
```

使用正常的会话命令切换代理和模型。`/new` 创建一个新的 OpenClaw 会话，Codex 执行器根据需要创建或恢复其侧车应用服务器线程。`/reset` 清除该线程的 OpenClaw 会话绑定。

## 模型发现

默认情况下，Codex 插件向应用服务器请求可用模型。如果发现失败或超时，它会使用捆绑的回退目录：

- `codex/gpt-5.4`
- `codex/gpt-5.4-mini`
- `codex/gpt-5.2`

你可以在 `plugins.entries.codex.config.discovery` 下调整发现：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 2500,
          },
        },
      },
    },
  },
}
```

当你希望启动时避免探测 Codex 并坚持使用回退目录时，禁用发现：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: false,
          },
        },
      },
    },
  },
}
```

## 应用服务器连接和策略

默认情况下，插件使用以下命令在本地启动 Codex：

```bash
codex app-server --listen stdio://
```

你可以保持该默认值，只调整 Codex 原生策略：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

对于已经运行的应用服务器，使用 WebSocket 传输：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://127.0.0.1:39175",
            authToken: "${CODEX_APP_SERVER_TOKEN}",
            requestTimeoutMs: 60000,
          },
        },
      },
    },
  },
}
```

支持的 `appServer` 字段：

| 字段               | 默认值                                  | 含义                                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `transport`         | `"stdio"`                                | `"stdio"` 启动 Codex；`"websocket"` 连接到 `url`。                 |
| `command`           | `"codex"`                                | stdio 传输的可执行文件。                                          |
| `args`              | `["app-server", "--listen", "stdio://"]` | stdio 传输的参数。                                           |
| `url`               | 未设置                                    | WebSocket 应用服务器 URL。                                                |
| `authToken`         | 未设置                                    | WebSocket 传输的 Bearer 令牌。                                    |
| `headers`           | `{}`                                     | 额外的 WebSocket 标头。                                                 |
| `requestTimeoutMs`  | `60000`                                  | 应用服务器控制平面调用的超时时间。                              |
| `approvalPolicy`    | `"never"`                                | 发送到线程启动/恢复/轮次的原生 Codex 审批策略。           |
| `sandbox`           | `"workspace-write"`                      | 发送到线程启动/恢复的原生 Codex 沙盒模式。                   |
| `approvalsReviewer` | `"user"`                                 | 使用 `"guardian_subagent"` 让 Codex 守护者审查原生审批。 |
| `serviceTier`       | 未设置                                    | 可选的 Codex 服务层级，例如 `"priority"`。                   |

当匹配的配置字段未设置时，旧的环境变量仍然作为本地测试的回退：

- `OPENCLAW_CODEX_APP_SERVER_BIN`
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`
- `OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1`

对于可重复的部署，首选配置。

## 常见配方

使用默认 stdio 传输的本地 Codex：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

仅 Codex 执行器验证，禁用 PI 回退：

```json5
{
  embeddedHarness: {
    fallback: "none",
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

守护者审查的 Codex 审批：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            approvalPolicy: "on-request",
            approvalsReviewer: "guardian_subagent",
            sandbox: "workspace-write",
          },
        },
      },
    },
  },
}
```

带有显式标头的远程应用服务器：

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://gateway-host:39175",
            headers: {
              "X-OpenClaw-Agent": "main",
            },
          },
        },
      },
    },
  },
}
```

模型切换保持由 OpenClaw 控制。当 OpenClaw 会话附加到现有 Codex 线程时，下一轮会将当前选择的 `codex/*` 模型、提供商、审批策略、沙盒和服务层级再次发送到应用服务器。从 `codex/gpt-5.4` 切换到 `codex/gpt-5.2` 会保持线程绑定，但要求 Codex 继续使用新选择的模型。

## Codex 命令

捆绑插件将 `/codex` 注册为授权的斜杠命令。它是通用的，可在支持 OpenClaw 文本命令的任何通道上工作。

常见形式：

- `/codex status` 显示实时应用服务器连接、模型、账户、速率限制、MCP 服务器和技能。
- `/codex models` 列出实时 Codex 应用服务器模型。
- `/codex threads [filter]` 列出最近的 Codex 线程。
- `/codex resume <thread-id>` 将当前 OpenClaw 会话附加到现有的 Codex 线程。
- `/codex compact` 要求 Codex 应用服务器压缩附加的线程。
- `/codex review` 为附加的线程启动 Codex 原生审查。
- `/codex account` 显示账户和速率限制状态。
- `/codex mcp` 列出 Codex 应用服务器 MCP 服务器状态。
- `/codex skills` 列出 Codex 应用服务器技能。

`/codex resume` 写入与执行器用于正常轮次相同的侧车绑定文件。在下一条消息上，OpenClaw 恢复该 Codex 线程，将当前选择的 OpenClaw `codex/*` 模型传递到应用服务器，并保持扩展历史记录启用。

命令界面需要 Codex 应用服务器 `0.118.0` 或更新版本。如果未来或自定义应用服务器不暴露该 JSON-RPC 方法，个别控制方法会被报告为 `unsupported by this Codex app-server`。

## 工具、媒体和压缩

Codex 执行器仅更改低级嵌入式代理执行器。

OpenClaw 仍然构建工具列表并从执行器接收动态工具结果。文本、图像、视频、音乐、TTS、审批和消息工具输出继续通过正常的 OpenClaw 传递路径。

当选择的模型使用 Codex 执行器时，原生线程压缩被委托给 Codex 应用服务器。OpenClaw 为通道历史、搜索、`/new`、`/reset` 和未来的模型或执行器切换保持记录镜像。镜像包括用户提示、最终助手文本，以及当应用服务器发出时的轻量级 Codex 推理或计划记录。

媒体生成不需要 PI。图像、视频、音乐、PDF、TTS 和媒体理解继续使用匹配的提供商/模型设置，如 `agents.defaults.imageGenerationModel`、`videoGenerationModel`、`pdfModel` 和 `messages.tts`。

## 故障排除

**Codex 未出现在 `/model` 中：** 启用 `plugins.entries.codex.enabled`，设置 `codex/*` 模型引用，或检查 `plugins.allow` 是否排除了 `codex`。

**OpenClaw 回退到 PI：** 测试时设置 `embeddedHarness.fallback: "none"` 或 `OPENCLAW_AGENT_HARNESS_FALLBACK=none`。

**应用服务器被拒绝：** 升级 Codex，使应用服务器握手报告版本 `0.118.0` 或更新版本。

**模型发现缓慢：** 降低 `plugins.entries.codex.config.discovery.timeoutMs` 或禁用发现。

**WebSocket 传输立即失败：** 检查 `appServer.url`、`authToken`，以及远程应用服务器是否使用相同的 Codex 应用服务器协议版本。

**非 Codex 模型使用 PI：** 这是预期的。Codex 执行器仅声明 `codex/*` 模型引用。

## 相关

- [代理执行器插件](/plugins/sdk-agent-harness)
- [模型提供商](/concepts/model-providers)
- [配置参考](/gateway/configuration-reference)
- [测试](/help/testing#live-codex-app-server-harness-smoke)