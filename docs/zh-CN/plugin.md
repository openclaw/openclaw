---
read_when:
  - 添加或修改插件/扩展
  - 记录插件安装或加载规则
summary: OpenClaw 插件/扩展：发现、配置与安全
title: 插件
x-i18n:
  generated_at: "2026-02-01T21:36:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b36ca6b90ca03eaae25c00f9b12f2717fcd17ac540ba616ee03b398b234c2308
  source_path: plugin.md
  workflow: 15
---

# 插件（扩展）

## 快速入门（初次接触插件？）

插件就是一个**小型代码模块**，用于为 OpenClaw 扩展额外功能（命令、工具和 Gateway网关 RPC）。

大多数情况下，当你需要某个尚未内置到 OpenClaw 核心的功能（或希望将可选功能从主安装中分离出来）时，就会使用插件。

快速上手：

1. 查看已加载的插件：

```bash
openclaw plugins list
```

2. 安装官方插件（示例：Voice Call）：

```bash
openclaw plugins install @openclaw/voice-call
```

3. 重启 Gateway网关，然后在 `plugins.entries.<id>.config` 下进行配置。

参见 [Voice Call](/plugins/voice-call) 了解具体的插件示例。

## 可用插件（官方）

- 自 2026.1.15 起，Microsoft Teams 仅以插件形式提供；如果使用 Teams，请安装 `@openclaw/msteams`。
- Memory (Core) — 内置记忆搜索插件（默认通过 `plugins.slots.memory` 启用）
- Memory (LanceDB) — 内置长期记忆插件（自动召回/捕获；设置 `plugins.slots.memory = "memory-lancedb"`）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth（提供商认证）— 内置为 `google-antigravity-auth`（默认禁用）
- Gemini CLI OAuth（提供商认证）— 内置为 `google-gemini-cli-auth`（默认禁用）
- Qwen OAuth（提供商认证）— 内置为 `qwen-portal-auth`（默认禁用）
- Copilot Proxy（提供商认证）— 本地 VS Code Copilot Proxy 桥接；与内置的 `github-copilot` 设备登录不同（内置，默认禁用）

OpenClaw 插件是**TypeScript 模块**，在运行时通过 jiti 加载。**配置验证不会执行插件代码**；而是使用插件清单和 JSON Schema。参见[插件清单](/plugins/manifest)。

插件可以注册：

- Gateway网关 RPC 方法
- Gateway网关 HTTP 处理器
- 智能体工具
- CLI 命令
- 后台服务
- 可选的配置验证
- **Skills**（通过在插件清单中列出 `skills` 目录）
- **自动回复命令**（无需调用 AI 智能体即可执行）

插件与 Gateway网关 **在同一进程**中运行，因此请将其视为可信代码。
工具编写指南：[插件智能体工具](/plugins/agent-tools)。

## 运行时辅助工具

插件可以通过 `api.runtime` 访问选定的核心辅助工具。用于电话 TTS：

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注意事项：

- 使用核心 `messages.tts` 配置（OpenAI 或 ElevenLabs）。
- 返回 PCM 音频缓冲区 + 采样率。插件必须自行对提供商进行重采样/编码。
- Edge TTS 不支持电话场景。

## 发现与优先级

OpenClaw 按以下顺序扫描：

1. 配置路径

- `plugins.load.paths`（文件或目录）

2. 工作区扩展

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全局扩展

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 内置扩展（随 OpenClaw 一起发布，**默认禁用**）

- `<openclaw>/extensions/*`

内置插件必须通过 `plugins.entries.<id>.enabled` 或 `openclaw plugins enable <id>` 显式启用。已安装的插件默认启用，但可以用同样的方式禁用。

每个插件的根目录中必须包含一个 `openclaw.plugin.json` 文件。如果路径指向一个文件，插件根目录就是该文件所在目录，且必须包含清单文件。

如果多个插件解析到相同的 id，按上述顺序第一个匹配的生效，较低优先级的副本将被忽略。

### 包集合

插件目录可以包含一个带有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

每个条目成为一个插件。如果包集合列出了多个扩展，插件 id 变为 `name/<fileBase>`。

如果你的插件导入了 npm 依赖，请在该目录中安装它们，以便 `node_modules` 可用（`npm install` / `pnpm install`）。

### 渠道目录元数据

渠道插件可以通过 `openclaw.channel` 公布新手引导元数据，并通过 `openclaw.install` 提供安装提示。这使核心目录保持无数据状态。

示例：

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw 还可以合并**外部渠道目录**（例如，MPM 注册表导出）。将 JSON 文件放置在以下位置之一：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或者将 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向一个或多个 JSON 文件（以逗号/分号/`PATH` 分隔）。每个文件应包含 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。

## 插件 ID

默认插件 id：

- 包集合：`package.json` 中的 `name`
- 独立文件：文件基本名称（`~/.../voice-call.ts` → `voice-call`）

如果插件导出了 `id`，OpenClaw 会使用它，但当它与配置的 id 不匹配时会发出警告。

## 配置

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

字段说明：

- `enabled`：主开关（默认：true）
- `allow`：允许列表（可选）
- `deny`：拒绝列表（可选；拒绝优先）
- `load.paths`：额外的插件文件/目录
- `entries.<id>`：每个插件的开关 + 配置

配置更改**需要重启 Gateway网关**。

验证规则（严格）：

- `entries`、`allow`、`deny` 或 `slots` 中的未知插件 id 会产生**错误**。
- 未知的 `channels.<id>` 键会产生**错误**，除非插件清单声明了该渠道 id。
- 插件配置使用 `openclaw.plugin.json` 中嵌入的 JSON Schema（`configSchema`）进行验证。
- 如果插件被禁用，其配置会被保留并发出**警告**。

## 插件槽位（排他类别）

某些插件类别是**排他的**（同一时间只能激活一个）。使用 `plugins.slots` 来选择由哪个插件占用该槽位：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 或 "none" 以禁用记忆插件
    },
  },
}
```

如果多个插件声明了 `kind: "memory"`，则只有被选中的那个会加载。其他的将被禁用并附带诊断信息。

## 控制界面（schema + 标签）

控制界面使用 `config.schema`（JSON Schema + `uiHints`）来渲染更好的表单。

OpenClaw 在运行时根据已发现的插件增强 `uiHints`：

- 为 `plugins.entries.<id>` / `.enabled` / `.config` 添加每个插件的标签
- 合并插件提供的可选配置字段提示到：
  `plugins.entries.<id>.config.<field>`

如果你希望插件配置字段显示良好的标签/占位符（并将密钥标记为敏感信息），请在插件清单中的 JSON Schema 旁边提供 `uiHints`。

示例：

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # 将本地文件/目录复制到 ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # 相对路径也可以
openclaw plugins install ./plugin.tgz           # 从本地 tarball 安装
openclaw plugins install ./plugin.zip           # 从本地 zip 安装
openclaw plugins install -l ./extensions/voice-call # 链接（不复制）用于开发
openclaw plugins install @openclaw/voice-call # 从 npm 安装
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 仅适用于通过 `plugins.installs` 跟踪的 npm 安装。

插件也可以注册自己的顶级命令（示例：`openclaw voicecall`）。

## 插件 API（概览）

插件导出以下之一：

- 一个函数：`(api) => { ... }`
- 一个对象：`{ id, name, configSchema, register(api) { ... } }`

## 插件钩子

插件可以自带钩子并在运行时注册。这使插件能够捆绑事件驱动的自动化，而无需单独安装钩子包。

### 示例

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

注意事项：

- 钩子目录遵循常规钩子结构（`HOOK.md` + `handler.ts`）。
- 钩子资格规则仍然适用（操作系统/二进制文件/环境/配置要求）。
- 插件管理的钩子在 `openclaw hooks list` 中显示为 `plugin:<id>`。
- 你不能通过 `openclaw hooks` 启用/禁用插件管理的钩子；请改为启用/禁用插件。

## 提供商插件（模型认证）

插件可以注册**模型提供商认证**流程，这样用户可以在 OpenClaw 内运行 OAuth 或 API 密钥设置（无需外部脚本）。

通过 `api.registerProvider(...)` 注册提供商。每个提供商公开一个或多个认证方法（OAuth、API 密钥、设备代码等）。这些方法驱动：

- `openclaw models auth login --provider <id> [--method <id>]`

示例：

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // 运行 OAuth 流程并返回认证配置文件。
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

注意事项：

- `run` 接收一个 `ProviderAuthContext`，其中包含 `prompter`、`runtime`、`openUrl` 和 `oauth.createVpsAwareHandlers` 辅助工具。
- 当你需要添加默认模型或提供商配置时，返回 `configPatch`。
- 返回 `defaultModel` 以便 `--set-default` 可以更新智能体默认值。

### 注册消息渠道

插件可以注册**渠道插件**，其行为类似于内置渠道（WhatsApp、Telegram 等）。渠道配置位于 `channels.<id>` 下，由你的渠道插件代码进行验证。

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

注意事项：

- 将配置放在 `channels.<id>` 下（而非 `plugins.entries`）。
- `meta.label` 用于 CLI/UI 列表中的标签。
- `meta.aliases` 为规范化和 CLI 输入添加替代 id。
- `meta.preferOver` 列出当两者都已配置时跳过自动启用的渠道 id。
- `meta.detailLabel` 和 `meta.systemImage` 让 UI 显示更丰富的渠道标签/图标。

### 编写新的消息渠道（分步指南）

当你需要一个**新的聊天界面**（即"消息渠道"）而非模型提供商时使用此方法。
模型提供商文档位于 `/providers/*`。

1. 选择 id + 配置结构

- 所有渠道配置位于 `channels.<id>` 下。
- 对于多账户设置，建议使用 `channels.<id>.accounts.<accountId>`。

2. 定义渠道元数据

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI/UI 列表。
- `meta.docsPath` 应指向类似 `/channels/<id>` 的文档页面。
- `meta.preferOver` 让插件替代另一个渠道（自动启用时优先选择它）。
- `meta.detailLabel` 和 `meta.systemImage` 供 UI 用于详情文本/图标。

3. 实现必需的适配器

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`（聊天类型、媒体、线程等）
- `outbound.deliveryMode` + `outbound.sendText`（用于基本发送）

4. 根据需要添加可选适配器

- `setup`（向导）、`security`（私信策略）、`status`（健康/诊断）
- `gateway`（启动/停止/登录）、`mentions`、`threading`、`streaming`
- `actions`（消息操作）、`commands`（原生命令行为）

5. 在插件中注册渠道

- `api.registerChannel({ plugin })`

最小配置示例：

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

最小渠道插件（仅出站）：

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // 在这里将 `text` 发送到你的渠道
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

加载插件（扩展目录或 `plugins.load.paths`），重启 Gateway网关，然后在配置中设置 `channels.<id>`。

### 智能体工具

参见专门的指南：[插件智能体工具](/plugins/agent-tools)。

### 注册 Gateway网关 RPC 方法

```ts
export default function (api) {
  api.registerGateway网关Method("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### 注册 CLI 命令

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### 注册自动回复命令

插件可以注册自定义斜杠命令，这些命令**无需调用 AI 智能体**即可执行。这对于切换命令、状态检查或不需要 LLM 处理的快速操作非常有用。

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

命令处理器上下文：

- `senderId`：发送者的 ID（如果可用）
- `channel`：发送命令的渠道
- `isAuthorizedSender`：发送者是否为授权用户
- `args`：命令后传递的参数（如果 `acceptsArgs: true`）
- `commandBody`：完整的命令文本
- `config`：当前的 OpenClaw 配置

命令选项：

- `name`：命令名称（不含前导 `/`）
- `description`：在命令列表中显示的帮助文本
- `acceptsArgs`：命令是否接受参数（默认：false）。如果为 false 且提供了参数，命令将不匹配，消息将传递给其他处理器
- `requireAuth`：是否要求授权发送者（默认：true）
- `handler`：返回 `{ text: string }` 的函数（可以是异步的）

带授权和参数的示例：

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

注意事项：

- 插件命令在内置命令和 AI 智能体**之前**处理
- 命令全局注册，可在所有渠道中使用
- 命令名称不区分大小写（`/MyStatus` 匹配 `/mystatus`）
- 命令名称必须以字母开头，且仅包含字母、数字、连字符和下划线
- 保留命令名称（如 `help`、`status`、`reset` 等）不能被插件覆盖
- 跨插件的重复命令注册将导致诊断错误

### 注册后台服务

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 命名约定

- Gateway网关方法：`pluginId.action`（示例：`voicecall.status`）
- 工具：`snake_case`（示例：`voice_call`）
- CLI 命令：kebab 或 camel 风格，但避免与核心命令冲突

## Skills

插件可以在仓库中附带 Skills（`skills/<name>/SKILL.md`）。
通过 `plugins.entries.<id>.enabled`（或其他配置门控）启用它，并确保它存在于你的工作区/托管 Skills 位置中。

## 分发（npm）

推荐的打包方式：

- 主包：`openclaw`（本仓库）
- 插件：`@openclaw/*` 下的独立 npm 包（示例：`@openclaw/voice-call`）

发布约定：

- 插件 `package.json` 必须包含 `openclaw.extensions`，其中列出一个或多个入口文件。
- 入口文件可以是 `.js` 或 `.ts`（jiti 在运行时加载 TS）。
- `openclaw plugins install <npm-spec>` 使用 `npm pack`，提取到 `~/.openclaw/extensions/<id>/`，并在配置中启用。
- 配置键稳定性：带作用域的包会被规范化为**不带作用域**的 id 用于 `plugins.entries.*`。

## 示例插件：Voice Call

本仓库包含一个语音通话插件（Twilio 或日志回退）：

- 源码：`extensions/voice-call`
- Skills：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- 工具：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 配置（twilio）：`provider: "twilio"` + `twilio.accountSid/authToken/from`（可选 `statusCallbackUrl`、`twimlUrl`）
- 配置（开发）：`provider: "log"`（无网络）

参见 [Voice Call](/plugins/voice-call) 和 `extensions/voice-call/README.md` 了解设置和使用方法。

## 安全注意事项

插件与 Gateway网关在同一进程中运行。请将其视为可信代码：

- 仅安装你信任的插件。
- 优先使用 `plugins.allow` 允许列表。
- 更改后重启 Gateway网关。

## 测试插件

插件可以（也应该）附带测试：

- 仓库内的插件可以在 `src/**` 下保留 Vitest 测试（示例：`src/plugins/voice-call.plugin.test.ts`）。
- 单独发布的插件应运行自己的 CI（lint/构建/测试），并验证 `openclaw.extensions` 指向构建后的入口点（`dist/index.js`）。
