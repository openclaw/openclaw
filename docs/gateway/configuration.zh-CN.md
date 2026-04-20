---
summary: "配置概述：常见任务、快速设置和完整参考链接"
read_when:
  - 首次设置 OpenClaw
  - 查找常见配置模式
  - 导航到特定配置部分
title: "配置"
---

# 配置

OpenClaw 从 `~/.openclaw/openclaw.json` 读取可选的 <Tooltip tip="JSON5 支持注释和尾随逗号">**JSON5**</Tooltip> 配置。

如果文件缺失，OpenClaw 使用安全的默认值。添加配置的常见原因：

- 连接通道并控制谁可以向机器人发送消息
- 设置模型、工具、沙盒或自动化（cron、hooks）
- 调整会话、媒体、网络或 UI

有关所有可用字段的完整参考，请参阅 [完整参考](/gateway/configuration-reference)。

<Tip>
**新接触配置？** 从 `openclaw onboard` 开始进行交互式设置，或查看 [配置示例](/gateway/configuration-examples) 指南获取完整的复制粘贴配置。
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
  <Tab title="交互式向导">
    ```bash
    openclaw onboard       # 完整初始化流程
    openclaw configure     # 配置向导
    ```
  </Tab>
  <Tab title="CLI（单行命令）">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset plugins.entries.brave.config.webSearch.apiKey
    ```
  </Tab>
  <Tab title="控制 UI">
    打开 [http://127.0.0.1:18789](http://127.0.0.1:18789) 并使用 **Config** 选项卡。
    控制 UI 从实时配置架构渲染表单，包括字段 `title` / `description` 文档元数据以及可用的插件和通道架构，带有 **Raw JSON** 编辑器作为备用选项。对于深入 UI 和其他工具，网关还公开 `config.schema.lookup` 以获取一个路径范围的架构节点以及即时子摘要。
  </Tab>
  <Tab title="直接编辑">
    直接编辑 `~/.openclaw/openclaw.json`。网关监视文件并自动应用更改（请参阅 [热重载](#config-hot-reload)）。
  </Tab>
</Tabs>

## 严格验证

<Warning>
OpenClaw 只接受完全匹配架构的配置。未知键、格式错误的类型或无效值会导致网关 **拒绝启动**。唯一的根级别例外是 `$schema`（字符串），因此编辑器可以附加 JSON Schema 元数据。
</Warning>

架构工具说明：

- `openclaw config schema` 打印与控制 UI 和配置验证使用的相同 JSON Schema 系列。
- 将该架构输出视为 `openclaw.json` 的规范机器可读契约；此概述和配置参考对其进行了总结。
- 字段 `title` 和 `description` 值被带入架构输出，用于编辑器和表单工具。
- 嵌套对象、通配符（`*`）和数组项（`[]`）条目在匹配字段文档存在的情况下继承相同的文档元数据。
- `anyOf` / `oneOf` / `allOf` 组合分支也继承相同的文档元数据，因此联合/交集变体保持相同的字段帮助。
- `config.schema.lookup` 返回一个规范化的配置路径，带有浅架构节点（`title`、`description`、`type`、`enum`、`const`、常见边界和类似的验证字段）、匹配的 UI 提示元数据以及用于深入工具的即时子摘要。
- 当网关可以加载当前清单注册表时，运行时插件/通道架构会被合并。
- `pnpm config:docs:check` 检测面向文档的配置基线工件与当前架构表面之间的偏差。

验证失败时：

- 网关不启动
- 只有诊断命令有效（`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`）
- 运行 `openclaw doctor` 查看确切问题
- 运行 `openclaw doctor --fix`（或 `--yes`）应用修复

## 常见任务

<AccordionGroup>
  <Accordion title="设置通道（WhatsApp、Telegram、Discord 等）">
    每个通道在 `channels.<provider>` 下有自己的配置部分。有关设置步骤，请参阅专用通道页面：

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/channels/telegram) — `channels.telegram`
    - [Discord](/channels/discord) — `channels.discord`
    - [Feishu](/channels/feishu) — `channels.feishu`
    - [Google Chat](/channels/googlechat) — `channels.googlechat`
    - [Microsoft Teams](/channels/msteams) — `channels.msteams`
    - [Slack](/channels/slack) — `channels.slack`
    - [Signal](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [Mattermost](/channels/mattermost) — `channels.mattermost`

    所有通道共享相同的 DM 策略模式：

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

  <Accordion title="选择和配置模型">
    设置主模型和可选的备用模型：

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.4": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` 定义模型目录并作为 `/model` 的允许列表。
    - 模型引用使用 `provider/model` 格式（例如 `anthropic/claude-opus-4-6`）。
    - `agents.defaults.imageMaxDimensionPx` 控制转录/工具图像缩小（默认 `1200`）；较低的值通常减少截图密集运行的视觉令牌使用。
    - 有关在聊天中切换模型，请参阅 [Models CLI](/concepts/models)，有关认证轮换和备用行为，请参阅 [模型故障转移](/concepts/model-failover)。
    - 对于自定义/自托管提供商，请参阅参考中的 [自定义提供商](/gateway/configuration-reference#custom-providers-and-base-urls)。

  </Accordion>

  <Accordion title="控制谁可以向机器人发送消息">
    DM 访问通过 `dmPolicy` 按通道控制：

    - `"pairing"`（默认）：未知发件人获得一次性配对代码以批准
    - `"allowlist"`：仅 `allowFrom` 中的发件人（或配对允许存储）
    - `"open"`：允许所有入站 DM（需要 `allowFrom: ["*"]`）
    - `"disabled"`：忽略所有 DM

    对于群组，使用 `groupPolicy` + `groupAllowFrom` 或通道特定的允许列表。

    有关每个通道的详细信息，请参阅 [完整参考](/gateway/configuration-reference#dm-and-group-access)。

  </Accordion>

  <Accordion title="设置群聊提及门控">
    群消息默认 **需要提及**。按代理配置模式：

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

    - **元数据提及**：原生 @ 提及（WhatsApp 点击提及、Telegram @bot 等）
    - **文本模式**：`mentionPatterns` 中的安全正则表达式模式
    - 有关每个通道的覆盖和自聊模式，请参阅 [完整参考](/gateway/configuration-reference#group-chat-mention-gating)。

  </Accordion>

  <Accordion title="限制每个代理的技能">
    使用 `agents.defaults.skills` 作为共享基线，然后使用 `agents.list[].skills` 覆盖特定代理：

    ```json5
    {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [
          { id: "writer" }, // 继承 github, weather
          { id: "docs", skills: ["docs-search"] }, // 替换默认值
          { id: "locked-down", skills: [] }, // 无技能
        ],
      },
    }
    ```

    - 省略 `agents.defaults.skills` 以默认不受限制的技能。
    - 省略 `agents.list[].skills` 以继承默认值。
    - 设置 `agents.list[].skills: []` 以无技能。
    - 请参阅 [技能](/tools/skills)、[技能配置](/tools/skills-config) 和 [配置参考](/gateway/configuration-reference#agents-defaults-skills)。

  </Accordion>

  <Accordion title="调整网关通道健康监控">
    控制网关重新启动看起来过时的通道的积极性：

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

    - 设置 `gateway.channelHealthCheckMinutes: 0` 以全局禁用健康监控重启。
    - `channelStaleEventThresholdMinutes` 应大于或等于检查间隔。
    - 使用 `channels.<provider>.healthMonitor.enabled` 或 `channels.<provider>.accounts.<id>.healthMonitor.enabled` 为一个通道或账户禁用自动重启，而不禁用全局监控。
    - 有关操作调试，请参阅 [健康检查](/gateway/health)，有关所有字段，请参阅 [完整参考](/gateway/configuration-reference#gateway)。

  </Accordion>

  <Accordion title="配置会话和重置">
    会话控制对话连续性和隔离：

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
    - 有关作用域、身份链接和发送策略，请参阅 [会话管理](/concepts/session)。
    - 有关所有字段，请参阅 [完整参考](/gateway/configuration-reference#session)。

  </Accordion>

  <Accordion title="启用沙盒">
    在隔离的 Docker 容器中运行代理会话：

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

    首先构建镜像：`scripts/sandbox-setup.sh`

    有关完整指南，请参阅 [沙盒](/gateway/sandboxing)，有关所有选项，请参阅 [完整参考](/gateway/configuration-reference#agentsdefaultssandbox)。

  </Accordion>

  <Accordion title="为官方 iOS 构建启用基于中继的推送">
    基于中继的推送在 `openclaw.json` 中配置。

    在网关配置中设置：

    ```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // 可选。默认：10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

    CLI 等效：

    ```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

    这会做什么：

    - 让网关通过外部中继发送 `push.test`、唤醒提示和重新连接唤醒。
    - 使用由配对的 iOS 应用转发的注册范围发送授权。网关不需要部署范围的中继令牌。
    - 将每个基于中继的注册绑定到 iOS 应用配对的网关身份，因此另一个网关无法重用存储的注册。
    - 在直接 APNs 上保持本地/手动 iOS 构建。基于中继的发送仅适用于通过中继注册的官方分布式构建。
    - 必须匹配官方/TestFlight iOS 构建中内置的中继基础 URL，以便注册和发送流量到达相同的中继部署。

    端到端流程：

    1. 安装官方/TestFlight iOS 构建，该构建使用相同的中继基础 URL 编译。
    2. 在网关上配置 `gateway.push.apns.relay.baseUrl`。
    3. 将 iOS 应用配对到网关，让节点和操作员会话都连接。
    4. iOS 应用获取网关身份，使用 App Attest 加上应用收据向中继注册，然后将基于中继的 `push.apns.register` 有效负载发布到配对的网关。
    5. 网关存储中继句柄和发送授权，然后将它们用于 `push.test`、唤醒提示和重新连接唤醒。

    操作说明：

    - 如果你将 iOS 应用切换到不同的网关，请重新连接应用，以便它可以发布绑定到该网关的新中继注册。
    - 如果你发布指向不同中继部署的新 iOS 构建，应用会刷新其缓存的中继注册，而不是重用旧的中继源。

    兼容性说明：

    - `OPENCLAW_APNS_RELAY_BASE_URL` 和 `OPENCLAW_APNS_RELAY_TIMEOUT_MS` 仍然作为临时环境覆盖工作。
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` 仍然是仅限环回的开发逃生舱口；不要在配置中持久化 HTTP 中继 URL。

    有关端到端流程，请参阅 [iOS 应用](/platforms/ios#relay-backed-push-for-official-builds)，有关中继安全模型，请参阅 [认证和信任流程](/platforms/ios#authentication-and-trust-flow)。

  </Accordion>

  <Accordion title="设置心跳（定期检查）">
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

    - `every`：持续时间字符串（`30m`、`2h`）。设置 `0m` 以禁用。
    - `target`：`last` | `none` | `<channel-id>`（例如 `discord`、`matrix`、`telegram` 或 `whatsapp`）
    - `directPolicy`：`allow`（默认）或 `block` 用于 DM 风格的心跳目标
    - 有关完整指南，请参阅 [心跳](/gateway/heartbeat)。

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

    - `sessionRetention`：从 `sessions.json` 中修剪已完成的隔离运行会话（默认 `24h`；设置 `false` 以禁用）。
    - `runLog`：按大小和保留行数修剪 `cron/runs/<jobId>.jsonl`。
    - 有关功能概述和 CLI 示例，请参阅 [Cron 作业](/automation/cron-jobs)。

  </Accordion>

  <Accordion title="设置 webhooks（hooks）">
    在网关上启用 HTTP webhook 端点：

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
    - 将所有 hook/webhook 有效负载内容视为不受信任的输入。
    - 使用专用的 `hooks.token`；不要重用共享的网关令牌。
    - Hook 认证仅为标头（`Authorization: Bearer ...` 或 `x-openclaw-token`）；查询字符串令牌被拒绝。
    - `hooks.path` 不能是 `/`；将 webhook 入口保持在专用子路径（如 `/hooks`）上。
    - 保持不安全内容绕过标志禁用（`hooks.gmail.allowUnsafeExternalContent`、`hooks.mappings[].allowUnsafeExternalContent`），除非进行严格范围的调试。
    - 如果你启用 `hooks.allowRequestSessionKey`，还应设置 `hooks.allowedSessionKeyPrefixes` 以限制调用者选择的会话键。
    - 对于基于 hook 的代理，首选强大的现代模型层级和严格的工具策略（例如仅消息传递加可能的沙盒）。

    有关所有映射选项和 Gmail 集成，请参阅 [完整参考](/gateway/configuration-reference#hooks)。

  </Accordion>

  <Accordion title="配置多代理路由">
    运行多个具有单独工作区和会话的隔离代理：

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

    有关绑定规则和每个代理的访问配置文件，请参阅 [多代理](/concepts/multi-agent) 和 [完整参考](/gateway/configuration-reference#multi-agent-routing)。

  </Accordion>

  <Accordion title="将配置拆分为多个文件（$include）">
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

    - **单个文件**：替换包含对象
    - **文件数组**：按顺序深度合并（后一个获胜）
    - **兄弟键**：包含后合并（覆盖包含的值）
    - **嵌套包含**：支持最多 10 级深度
    - **相对路径**：相对于包含文件解析
    - **错误处理**：对于缺失文件、解析错误和循环包含的清晰错误

  </Accordion>
</AccordionGroup>

## 配置热重载

网关监视 `~/.openclaw/openclaw.json` 并自动应用更改 — 大多数设置不需要手动重启。

### 重载模式

| 模式                 | 行为                                                |
| -------------------- | --------------------------------------------------- |
| **`hybrid`**（默认） | 即时热应用安全更改。自动重启关键更改。              |
| **`hot`**            | 仅热应用安全更改。当需要重启时记录警告 — 由你处理。 |
| **`restart`**        | 对任何配置更改重启网关，无论是否安全。              |
| **`off`**            | 禁用文件监视。更改在下次手动重启时生效。            |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### 什么热应用 vs 什么需要重启

大多数字段热应用而无停机。在 `hybrid` 模式下，需要重启的更改会自动处理。

| 类别       | 字段                                                  | 需要重启？ |
| ---------- | ----------------------------------------------------- | ---------- |
| 通道       | `channels.*`、`web`（WhatsApp）— 所有内置和扩展通道   | 否         |
| 代理和模型 | `agent`、`agents`、`models`、`routing`                | 否         |
| 自动化     | `hooks`、`cron`、`agent.heartbeat`                    | 否         |
| 会话和消息 | `session`、`messages`                                 | 否         |
| 工具和媒体 | `tools`、`browser`、`skills`、`audio`、`talk`         | 否         |
| UI 和其他  | `ui`、`logging`、`identity`、`bindings`               | 否         |
| 网关服务器 | `gateway.*`（端口、绑定、认证、tailscale、TLS、HTTP） | **是**     |
| 基础设施   | `discovery`、`canvasHost`、`plugins`                  | **是**     |

<Note>
`gateway.reload` 和 `gateway.remote` 是例外 — 更改它们**不会**触发重启。
</Note>

## 配置 RPC（程序化更新）

<Note>
控制平面写入 RPC（`config.apply`、`config.patch`、`update.run`）被速率限制为每个 `deviceId+clientIp` **每 60 秒 3 个请求**。当受限时，RPC 返回 `UNAVAILABLE` 和 `retryAfterMs`。
</Note>

安全/默认流程：

- `config.schema.lookup`：检查一个路径范围的配置子树，带有浅架构节点、匹配的提示元数据和即时子摘要
- `config.get`：获取当前快照 + 哈希
- `config.patch`：首选部分更新路径
- `config.apply`：仅完整配置替换
- `update.run`：显式自更新 + 重启

当你不替换整个配置时，首选 `config.schema.lookup` 然后 `config.patch`。

<AccordionGroup>
  <Accordion title="config.apply（完整替换）">
    一步验证 + 写入完整配置并重启网关。

    <Warning>
    `config.apply` 替换**整个配置**。对于部分更新，使用 `config.patch`，或对于单个键，使用 `openclaw config set`。
    </Warning>

    参数：

    - `raw`（字符串）— 整个配置的 JSON5 有效负载
    - `baseHash`（可选）— 来自 `config.get` 的配置哈希（当配置存在时必需）
    - `sessionKey`（可选）— 重启后唤醒 ping 的会话键
    - `note`（可选）— 重启标记的注释
    - `restartDelayMs`（可选）— 重启前的延迟（默认 2000）

    当一个重启请求已经挂起/进行中时，重启请求会被合并，重启周期之间应用 30 秒的冷却。

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
    将部分更新合并到现有配置（JSON 合并补丁语义）：

    - 对象递归合并
    - `null` 删除键
    - 数组替换

    参数：

    - `raw`（字符串）— 仅包含要更改的键的 JSON5
    - `baseHash`（必需）— 来自 `config.get` 的配置哈希
    - `sessionKey`、`note`、`restartDelayMs` — 与 `config.apply` 相同

    重启行为与 `config.apply` 匹配：合并挂起的重启加上重启周期之间的 30 秒冷却。

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## 环境变量

OpenClaw 从父进程读取环境变量，加上：

- 当前工作目录中的 `.env`（如果存在）
- `~/.openclaw/.env`（全局回退）

两个文件都不会覆盖现有环境变量。你也可以在配置中设置内联环境变量：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Shell 环境导入（可选）">
  如果启用且预期键未设置，OpenClaw 运行你的登录 shell 并仅导入缺失的键：

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

环境变量等效：`OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="配置值中的环境变量替换">
  在任何配置字符串值中使用 `${VAR_NAME}` 引用环境变量：

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

规则：

- 仅匹配大写名称：`[A-Z_][A-Z0-9_]*`
- 缺失/空变量在加载时抛出错误
- 用 `$${VAR}` 转义以获得文字输出
- 在 `$include` 文件中工作
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
      "image-lab": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/image-lab/apiKey",
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

SecretRef 详细信息（包括 `env`/`file`/`exec` 的 `secrets.providers`）在 [密钥管理](/gateway/secrets) 中。
支持的凭据路径在 [SecretRef 凭据表面](/reference/secretref-credential-surface) 中列出。
</Accordion>

有关完整的优先级和来源，请参阅 [环境](/help/environment)。

## 完整参考

有关完整的字段参考，请参阅 **[配置参考](/gateway/configuration-reference)**。

---

_相关：[配置示例](/gateway/configuration-examples) · [配置参考](/gateway/configuration-reference) · [Doctor](/gateway/doctor)_
