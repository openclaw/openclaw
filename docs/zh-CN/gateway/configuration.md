---
read_when:
  - 首次设置 OpenClaw
  - 查找常见配置模式
  - 导航到特定配置部分
summary: 配置概览：常见任务、快速设置，以及完整参考的链接
title: 配置
x-i18n:
  generated_at: "2026-03-16T06:23:15Z"
  model: gpt-5.4
  provider: openai
  source_hash: 0047a255e8d3b6d280634437167486e2a81bf98b2d367071259b4b5c85b5ba9f
  source_path: gateway/configuration.md
  workflow: 15
---

# 配置

OpenClaw 会从 `~/.openclaw/openclaw.json` 读取可选的 <Tooltip tip="JSON5 supports comments and trailing commas">**JSON5**</Tooltip> 配置。

如果该文件缺失，OpenClaw 会使用安全的默认值。添加配置的常见原因包括：

- 连接渠道并控制谁可以向 bot 发消息
- 设置模型、工具、沙箱隔离或自动化（cron、hooks）
- 调整会话、媒体、网络或 UI

所有可用字段请参阅 [完整参考](/gateway/configuration-reference)。

<Tip>
**刚接触配置？** 从 `openclaw onboard` 开始进行交互式设置，或者查看 [Configuration Examples](/gateway/configuration-examples) 指南，获取完整的可复制粘贴配置。
</Tip>

## 最小配置

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## 编辑配置

<Tabs>
  <Tab title="Interactive wizard">
    ```bash
    openclaw onboard       # 完整设置向导
    openclaw configure     # 配置向导
    ```
  </Tab>
  <Tab title="CLI (one-liners)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset plugins.entries.brave.config.webSearch.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    打开 [http://127.0.0.1:18789](http://127.0.0.1:18789) 并使用 **Config** 标签页。
    Control UI 会根据配置 schema 渲染表单，并提供 **Raw JSON** 编辑器作为后备方式。
  </Tab>
  <Tab title="Direct edit">
    直接编辑 `~/.openclaw/openclaw.json`。Gateway 网关会监视该文件并自动应用更改（参见[热重载](#config-hot-reload)）。
  </Tab>
</Tabs>

## 严格校验

<Warning>
OpenClaw 只接受完全符合 schema 的配置。未知键、类型格式错误或无效值都会导致 Gateway 网关**拒绝启动**。唯一的根级例外是 `$schema`（字符串），这样编辑器就可以附加 JSON Schema 元数据。
</Warning>

当校验失败时：

- Gateway 网关不会启动
- 只有诊断命令可用（`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`）
- 运行 `openclaw doctor` 以查看具体问题
- 运行 `openclaw doctor --fix`（或 `--yes`）以应用修复

## 常见任务

<AccordionGroup>
  <Accordion title="设置一个渠道（WhatsApp、Telegram、Discord 等）">
    每个渠道在 `channels.<provider>` 下都有各自的配置部分。设置步骤请参阅对应的渠道页面：

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/channels/telegram) — `channels.telegram`
    - [Discord](/channels/discord) — `channels.discord`
    - [Slack](/channels/slack) — `channels.slack`
    - [Signal](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [Google Chat](/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/channels/msteams) — `channels.msteams`

    所有渠道都共享同一种私信策略模式：

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // 仅用于 allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="选择并配置模型">
    设置主模型和可选回退模型：

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` 定义模型目录，并充当 `/model` 的允许列表。
    - 模型引用使用 `provider/model` 格式（例如 `anthropic/claude-opus-4-6`）。
    - `agents.defaults.imageMaxDimensionPx` 控制转录/工具图像的缩放下限（默认 `1200`）；在截图较多的运行中，较低的值通常会减少视觉 token 使用量。
    - 关于在聊天中切换模型，请参阅 [Models CLI](/concepts/models)；关于凭证轮换和回退行为，请参阅 [Model Failover](/concepts/model-failover)。
    - 关于自定义/自托管提供商，请参阅参考中的 [Custom providers](/gateway/configuration-reference#custom-providers-and-base-urls)。

  </Accordion>

  <Accordion title="控制谁可以向 bot 发消息">
    私信访问通过每个渠道的 `dmPolicy` 控制：

    - `"pairing"`（默认）：未知发送者会收到一次性配对码以供批准
    - `"allowlist"`：仅允许 `allowFrom`（或已配对允许存储）中的发送者
    - `"open"`：允许所有入站私信（需要 `allowFrom: ["*"]`）
    - `"disabled"`：忽略所有私信

    对于群组，请使用 `groupPolicy` + `groupAllowFrom` 或特定渠道的允许列表。

    有关每个渠道的详细信息，请参阅 [完整参考](/gateway/configuration-reference#dm-and-group-access)。

  </Accordion>

  <Accordion title="设置群聊提及门控">
    群组消息默认设置为**需要提及**。可按智能体配置模式：

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **元数据提及**：原生 @ 提及（WhatsApp 点按提及、Telegram @bot 等）
    - **文本模式**：`mentionPatterns` 中的安全正则模式
    - 关于每个渠道的覆盖和自聊模式，请参阅 [完整参考](/gateway/configuration-reference#group-chat-mention-gating)。

  </Accordion>

  <Accordion title="调整 Gateway 网关渠道健康监控">
    控制 Gateway 网关对看起来失活的渠道执行重启的积极程度：

    ```json5
    {
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 30,
        channelMaxRestartsPerHour: 10,
      },
      channels: {
        telegram: {
          healthMonitor: { enabled: false },
          accounts: {
            alerts: {
              healthMonitor: { enabled: true },
            },
          },
        },
      },
    }
    ```

    - 设置 `gateway.channelHealthCheckMinutes: 0` 可全局禁用健康监控重启。
    - `channelStaleEventThresholdMinutes` 应大于或等于检查间隔。
    - 使用 `channels.<provider>.healthMonitor.enabled` 或 `channels.<provider>.accounts.<id>.healthMonitor.enabled`，可为单个渠道或账号禁用自动重启，而无需禁用全局监控。
    - 有关运维调试，请参阅 [Health Checks](/gateway/health)；所有字段请参阅 [完整参考](/gateway/configuration-reference#gateway)。

  </Accordion>

  <Accordion title="配置会话和重置">
    会话控制对话的连续性和隔离性：

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // 推荐用于多用户
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`：`main`（共享）| `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`：线程绑定会话路由的全局默认值（Discord 支持 `/focus`、`/unfocus`、`/agents`、`/session idle` 和 `/session max-age`）。
    - 关于作用域、身份链接和发送策略，请参阅 [Session Management](/concepts/session)。
    - 所有字段请参阅 [完整参考](/gateway/configuration-reference#session)。

  </Accordion>

  <Accordion title="启用沙箱隔离">
    在隔离的 Docker 容器中运行智能体会话：

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    先构建镜像：`scripts/sandbox-setup.sh`

    完整指南请参阅 [Sandboxing](/gateway/sandboxing)，所有选项请参阅 [完整参考](/gateway/configuration-reference#sandbox)。

  </Accordion>

  <Accordion title="为官方 iOS 构建启用基于 relay 的推送">
    基于 relay 的推送在 `openclaw.json` 中配置。

    在 Gateway 网关配置中设置：

    ```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // 可选。默认值：10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

    等价 CLI：

    ```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

    这会带来以下效果：

    - 让 Gateway 网关通过外部 relay 发送 `push.test`、唤醒提示和重连唤醒。
    - 使用由已配对 iOS 应用转发的、以注册为范围的发送授权。Gateway 网关不需要部署范围的 relay token。
    - 将每个基于 relay 的注册绑定到 iOS 应用配对的 Gateway 网关身份，因此其他 Gateway 网关无法复用已存储的注册。
    - 保持本地/手动 iOS 构建继续使用直接 APNs。基于 relay 的发送仅适用于通过 relay 注册的官方分发构建。
    - 必须与官方/TestFlight iOS 构建中固化的 relay 基础 URL 一致，这样注册和发送流量才能到达同一个 relay 部署。

    端到端流程：

    1. 安装一个使用相同 relay 基础 URL 编译的官方/TestFlight iOS 构建。
    2. 在 Gateway 网关上配置 `gateway.push.apns.relay.baseUrl`。
    3. 将 iOS 应用与 Gateway 网关配对，并让节点会话和操作员会话都连接。
    4. iOS 应用获取 Gateway 网关身份，使用 App Attest 加上应用回执向 relay 注册，然后将基于 relay 的 `push.apns.register` 负载发布到已配对的 Gateway 网关。
    5. Gateway 网关存储 relay handle 和发送授权，然后将它们用于 `push.test`、唤醒提示和重连唤醒。

    运维说明：

    - 如果你将 iOS 应用切换到另一个 Gateway 网关，请重新连接应用，以便它发布绑定到该 Gateway 网关的新 relay 注册。
    - 如果你发布了一个指向不同 relay 部署的新 iOS 构建，应用会刷新其缓存的 relay 注册，而不是复用旧的 relay 来源。

    兼容性说明：

    - `OPENCLAW_APNS_RELAY_BASE_URL` 和 `OPENCLAW_APNS_RELAY_TIMEOUT_MS` 仍可作为临时环境变量覆盖使用。
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` 仍是仅限 loopback 的开发逃生口；不要在配置中持久化 HTTP relay URL。

    关于端到端流程，请参阅 [iOS App](/platforms/ios#relay-backed-push-for-official-builds)；关于 relay 安全模型，请参阅 [Authentication and trust flow](/platforms/ios#authentication-and-trust-flow)。

  </Accordion>

  <Accordion title="设置 heartbeat（周期性报到）">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every`：时长字符串（`30m`、`2h`）。设置为 `0m` 可禁用。
    - `target`：`last` | `whatsapp` | `telegram` | `discord` | `none`
    - `directPolicy`：用于私信风格 heartbeat 目标时，设为 `allow`（默认）或 `block`
    - 完整指南请参阅 [Heartbeat](/gateway/heartbeat)。

  </Accordion>

  <Accordion title="配置 cron 作业">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
        runLog: {
          maxBytes: "2mb",
          keepLines: 2000,
        },
      },
    }
    ```

    - `sessionRetention`：从 `sessions.json` 中清理已完成的隔离运行会话（默认 `24h`；设置为 `false` 可禁用）。
    - `runLog`：按大小和保留行数清理 `cron/runs/<jobId>.jsonl`。
    - 功能概览和 CLI 示例请参阅 [Cron jobs](/automation/cron-jobs)。

  </Accordion>

  <Accordion title="设置 webhooks（hooks）">
    在 Gateway 网关上启用 HTTP webhook 端点：

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    安全说明：
    - 将所有 hook/webhook 负载内容都视为不受信任输入。
    - 保持不安全内容绕过标志处于禁用状态（`hooks.gmail.allowUnsafeExternalContent`、`hooks.mappings[].allowUnsafeExternalContent`），除非是在进行严格限定的调试。
    - 对于由 hook 驱动的智能体，优先使用强大的现代模型层级和严格的工具策略（例如尽可能仅允许消息传递并启用沙箱隔离）。

    所有映射选项和 Gmail 集成请参阅 [完整参考](/gateway/configuration-reference#hooks)。

  </Accordion>

  <Accordion title="配置多智能体路由">
    运行多个彼此隔离的智能体，并使用独立的工作区和会话：

    ```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    关于绑定规则和每个智能体的访问配置文件，请参阅 [Multi-Agent](/concepts/multi-agent) 和 [完整参考](/gateway/configuration-reference#multi-agent-routing)。

  </Accordion>

  <Accordion title="将配置拆分到多个文件中（$include）">
    使用 `$include` 组织大型配置：

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **单个文件**：替换所在对象
    - **文件数组**：按顺序深度合并（后者优先）
    - **同级键**：在 include 之后合并（覆盖已包含的值）
    - **嵌套 include**：支持，最多 10 层深
    - **相对路径**：相对于包含它的文件解析
    - **错误处理**：对于缺失文件、解析错误和循环 include，会提供清晰错误

  </Accordion>
</AccordionGroup>

## 配置热重载

Gateway 网关会监视 `~/.openclaw/openclaw.json` 并自动应用更改 —— 对于大多数设置，无需手动重启。

### 重载模式

| 模式                 | 行为                                                     |
| -------------------- | -------------------------------------------------------- |
| **`hybrid`**（默认） | 立即热应用安全更改。对关键更改会自动重启。               |
| **`hot`**            | 仅热应用安全更改。需要重启时会记录警告 —— 由你自行处理。 |
| **`restart`**        | 任何配置更改都会重启 Gateway 网关，无论是否安全。        |
| **`off`**            | 禁用文件监视。更改会在下一次手动重启时生效。             |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### 哪些可以热应用，哪些需要重启

大多数字段都可以无停机热应用。在 `hybrid` 模式下，需要重启的更改会自动处理。

| 类别               | 字段                                                  | 需要重启？ |
| ------------------ | ----------------------------------------------------- | ---------- |
| 渠道               | `channels.*`、`web`（WhatsApp）— 所有内置和扩展渠道   | 否         |
| 智能体和模型       | `agent`、`agents`、`models`、`routing`                | 否         |
| 自动化             | `hooks`、`cron`、`agent.heartbeat`                    | 否         |
| 会话和消息         | `session`、`messages`                                 | 否         |
| 工具和媒体         | `tools`、`browser`、`skills`、`audio`、`talk`         | 否         |
| UI 和杂项          | `ui`、`logging`、`identity`、`bindings`               | 否         |
| Gateway 网关服务器 | `gateway.*`（port、bind、auth、tailscale、TLS、HTTP） | **是**     |
| 基础设施           | `discovery`、`canvasHost`、`plugins`                  | **是**     |

<Note>
`gateway.reload` 和 `gateway.remote` 是例外 —— 更改它们**不会**触发重启。
</Note>

## 配置 RPC（程序化更新）

<Note>
控制平面写入 RPC（`config.apply`、`config.patch`、`update.run`）按每个 `deviceId+clientIp` 限制为**每 60 秒 3 个请求**。当触发限制时，RPC 会返回 `UNAVAILABLE` 和 `retryAfterMs`。
</Note>

<AccordionGroup>
  <Accordion title="config.apply（完整替换）">
    校验 + 写入完整配置，并在一步中重启 Gateway 网关。

    <Warning>
    `config.apply` 会替换**整个配置**。部分更新请使用 `config.patch`，单个键请使用 `openclaw config set`。
    </Warning>

    参数：

    - `raw`（string）— 整个配置的 JSON5 负载
    - `baseHash`（可选）— 来自 `config.get` 的配置 hash（配置已存在时必需）
    - `sessionKey`（可选）— 重启后唤醒 ping 使用的会话键
    - `note`（可选）— 重启哨兵的说明
    - `restartDelayMs`（可选）— 重启前延迟（默认 2000）

    当已有重启处于待处理/进行中时，重启请求会被合并，并且两次重启周期之间会应用 30 秒冷却。

    ```bash
    openclaw gateway call config.get --params '{}'  # 捕获 payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:direct:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch（部分更新）">
    将部分更新合并到现有配置中（JSON merge patch 语义）：

    - 对象递归合并
    - `null` 删除键
    - 数组整体替换

    参数：

    - `raw`（string）— 仅包含要更改键的 JSON5
    - `baseHash`（必需）— 来自 `config.get` 的配置 hash
    - `sessionKey`、`note`、`restartDelayMs` — 与 `config.apply` 相同

    重启行为与 `config.apply` 一致：合并待处理重启，并在两次重启周期之间应用 30 秒冷却。

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 环境变量

OpenClaw 会从父进程读取环境变量，另外还会读取：

- 当前工作目录中的 `.env`（如果存在）
- `~/.openclaw/.env`（全局回退）

这两个文件都不会覆盖现有环境变量。你也可以在配置中设置内联环境变量：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Shell 环境变量导入（可选）">
  如果启用，并且预期键名尚未设置，OpenClaw 会运行你的登录 shell，并且只导入缺失的键：

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

环境变量等价项：`OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="在配置值中替换环境变量">
  你可以在任何配置字符串值中使用 `${VAR_NAME}` 引用环境变量：

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

规则：

- 仅匹配大写名称：`[A-Z_][A-Z0-9_]*`
- 缺失/为空的变量会在加载时抛出错误
- 使用 `$${VAR}` 进行转义，以输出字面值
- 在 `$include` 文件中也可用
- 内联替换：`"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="Secret refs（env、file、exec）">
  对于支持 SecretRef 对象的字段，你可以使用：

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "nano-banana-pro": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/nano-banana-pro/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccountRef: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

SecretRef 详情（包括 `env`/`file`/`exec` 的 `secrets.providers`）请参阅 [Secrets Management](/gateway/secrets)。
支持的凭证路径列在 [SecretRef Credential Surface](/reference/secretref-credential-surface) 中。
</Accordion>

有关完整优先级和来源，请参阅 [Environment](/help/environment)。

## 完整参考

有关逐字段的完整参考，请参阅 **[Configuration Reference](/gateway/configuration-reference)**。

---

_相关内容：[Configuration Examples](/gateway/configuration-examples) · [Configuration Reference](/gateway/configuration-reference) · [Doctor](/gateway/doctor)_
