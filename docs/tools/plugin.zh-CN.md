---
summary: "安装、配置和管理 OpenClaw 插件"
read_when:
  - 安装或配置插件
  - 了解插件发现和加载规则
  - 使用与 Codex/Claude 兼容的插件包
title: "插件"
sidebarTitle: "安装和配置"
---

# 插件

插件通过新功能扩展 OpenClaw：通道、模型提供者、工具、技能、语音、实时转录、实时语音、媒体理解、图像生成、视频生成、网络获取、网络搜索等。一些插件是**核心**（随 OpenClaw 一起提供），其他是**外部**（由社区在 npm 上发布）。

## 快速入门

<Steps>
  <Step title="查看已加载的内容">
    ```bash
    openclaw plugins list
    ```
  </Step>

  <Step title="安装插件">
    ```bash
    # 从 npm
    openclaw plugins install @openclaw/voice-call

    # 从本地目录或存档
    openclaw plugins install ./my-plugin
    openclaw plugins install ./my-plugin.tgz
    ```

  </Step>

  <Step title="重启网关">
    ```bash
    openclaw gateway restart
    ```

    然后在配置文件中的 `plugins.entries.<id>.config` 下进行配置。

  </Step>
</Steps>

如果你更喜欢聊天原生控制，请启用 `commands.plugins: true` 并使用：

```text
/plugin install clawhub:@openclaw/voice-call
/plugin show voice-call
/plugin enable voice-call
```

安装路径使用与 CLI 相同的解析器：本地路径/存档、显式 `clawhub:<pkg>` 或裸包规范（首先 ClawHub，然后 npm 回退）。

如果配置无效，安装通常会失败并指向 `openclaw doctor --fix`。唯一的恢复例外是为选择加入 `openclaw.install.allowInvalidConfigRecovery` 的插件提供的窄捆绑插件重新安装路径。

## 插件类型

OpenClaw 识别两种插件格式：

| 格式     | 工作原理                                           | 示例                                                   |
| -------- | -------------------------------------------------- | ------------------------------------------------------ |
| **原生** | `openclaw.plugin.json` + 运行时模块；在进程内执行  | 官方插件、社区 npm 包                                  |
| **包**   | Codex/Claude/Cursor 兼容布局；映射到 OpenClaw 功能 | `.codex-plugin/`、`.claude-plugin/`、`.cursor-plugin/` |

两者都显示在 `openclaw plugins list` 下。有关包详细信息，请参阅 [插件包](/plugins/bundles)。

如果你正在编写原生插件，请从 [构建插件](/plugins/building-plugins) 和 [插件 SDK 概述](/plugins/sdk-overview) 开始。

## 官方插件

### 可安装（npm）

| 插件            | 包                     | 文档                                 |
| --------------- | ---------------------- | ------------------------------------ |
| Matrix          | `@openclaw/matrix`     | [Matrix](/channels/matrix)           |
| Microsoft Teams | `@openclaw/msteams`    | [Microsoft Teams](/channels/msteams) |
| Nostr           | `@openclaw/nostr`      | [Nostr](/channels/nostr)             |
| Voice Call      | `@openclaw/voice-call` | [Voice Call](/plugins/voice-call)    |
| Zalo            | `@openclaw/zalo`       | [Zalo](/channels/zalo)               |
| Zalo Personal   | `@openclaw/zalouser`   | [Zalo Personal](/plugins/zalouser)   |

### 核心（随 OpenClaw 一起提供）

<AccordionGroup>
  <Accordion title="模型提供者（默认启用）">
    `anthropic`、`byteplus`、`cloudflare-ai-gateway`、`github-copilot`、`google`、
    `huggingface`、`kilocode`、`kimi-coding`、`minimax`、`mistral`、`qwen`、
    `moonshot`、`nvidia`、`openai`、`opencode`、`opencode-go`、`openrouter`、
    `qianfan`、`synthetic`、`together`、`venice`、
    `vercel-ai-gateway`、`volcengine`、`xiaomi`、`zai`
  </Accordion>

  <Accordion title="内存插件">
    - `memory-core` — 捆绑的内存搜索（通过 `plugins.slots.memory` 默认）
    - `memory-lancedb` — 按需安装的长期内存，具有自动召回/捕获（设置 `plugins.slots.memory = "memory-lancedb"`）
  </Accordion>

  <Accordion title="语音提供者（默认启用）">
    `elevenlabs`、`microsoft`
  </Accordion>

  <Accordion title="其他">
    - `browser` — 捆绑的浏览器插件，用于浏览器工具、`openclaw browser` CLI、`browser.request` 网关方法、浏览器运行时和默认浏览器控制服务（默认启用；在替换前禁用）
    - `copilot-proxy` — VS Code Copilot Proxy 桥接（默认禁用）
  </Accordion>
</AccordionGroup>

寻找第三方插件？请参阅 [社区插件](/plugins/community)。

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

| 字段           | 描述                                           |
| -------------- | ---------------------------------------------- |
| `enabled`      | 主切换（默认：`true`）                         |
| `allow`        | 插件允许列表（可选）                           |
| `deny`         | 插件拒绝列表（可选；拒绝优先）                 |
| `load.paths`   | 额外插件文件/目录                              |
| `slots`        | 独占槽选择器（例如 `memory`、`contextEngine`） |
| `entries.<id>` | 每个插件的切换 + 配置                          |

配置更改**需要网关重启**。如果网关运行时启用了配置监视 + 进程内重启（默认的 `openclaw gateway` 路径），该重启通常在配置写入落地后片刻自动执行。

<Accordion title="插件状态：禁用 vs 缺失 vs 无效">
  - **禁用**：插件存在但启用规则将其关闭。配置被保留。
  - **缺失**：配置引用了发现未找到的插件 ID。
  - **无效**：插件存在但其配置与声明的架构不匹配。
</Accordion>

## 发现和优先级

OpenClaw 按以下顺序扫描插件（第一个匹配项获胜）：

<Steps>
  <Step title="配置路径">
    `plugins.load.paths` — 显式文件或目录路径。
  </Step>

  <Step title="工作区扩展">
    `workspace/.openclaw/<plugin-root>/*.ts` 和 `workspace/.openclaw/<plugin-root>/*/index.ts`。
  </Step>

  <Step title="全局扩展">
    `~/.openclaw/<plugin-root>/*.ts` 和 `~/.openclaw/<plugin-root>/*/index.ts`。
  </Step>

  <Step title="捆绑插件">
    随 OpenClaw 一起提供。许多默认启用（模型提供者、语音）。
    其他需要显式启用。
  </Step>
</Steps>

### 启用规则

- `plugins.enabled: false` 禁用所有插件
- `plugins.deny` 始终优先于允许
- `plugins.entries.<id>.enabled: false` 禁用该插件
- 工作区来源的插件**默认禁用**（必须显式启用）
- 捆绑插件遵循内置的默认开启集，除非被覆盖
- 独占槽可以为该槽强制启用选定的插件

## 插件槽（独占类别）

某些类别是独占的（一次仅一个活动）：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 或 "none" 禁用
      contextEngine: "legacy", // 或插件 ID
    },
  },
}
```

| 槽              | 控制内容       | 默认值           |
| --------------- | -------------- | ---------------- |
| `memory`        | 活动内存插件   | `memory-core`    |
| `contextEngine` | 活动上下文引擎 | `legacy`（内置） |

## CLI 参考

```bash
openclaw plugins list                       # 紧凑清单
openclaw plugins list --enabled            # 仅加载的插件
openclaw plugins list --verbose            # 每个插件的详细行
openclaw plugins list --json               # 机器可读清单
openclaw plugins inspect <id>              # 深度详细信息
openclaw plugins inspect <id> --json       # 机器可读
openclaw plugins inspect --all             #  fleet-wide 表
openclaw plugins info <id>                 # inspect 别名
openclaw plugins doctor                    # 诊断

openclaw plugins install <package>         # 安装（首先 ClawHub，然后 npm）
openclaw plugins install clawhub:<pkg>     # 仅从 ClawHub 安装
openclaw plugins install <spec> --force    # 覆盖现有安装
openclaw plugins install <path>            # 从本地路径安装
openclaw plugins install -l <path>         # 链接（无复制）用于开发
openclaw plugins install <plugin> --marketplace <source>
openclaw plugins install <plugin> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <spec> --pin      # 记录确切解析的 npm 规范
openclaw plugins install <spec> --dangerously-force-unsafe-install
openclaw plugins update <id>             # 更新一个插件
openclaw plugins update <id> --dangerously-force-unsafe-install
openclaw plugins update --all            # 更新所有
openclaw plugins uninstall <id>          # 移除配置/安装记录
openclaw plugins uninstall <id> --keep-files
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json

openclaw plugins enable <id>
openclaw plugins disable <id>
```

捆绑插件随 OpenClaw 一起提供。许多默认启用（例如捆绑的模型提供者、捆绑的语音提供者和捆绑的浏览器插件）。其他捆绑插件仍然需要 `openclaw plugins enable <id>`。

`--force` 覆盖现有的已安装插件或钩子包。
它不支持 `--link`，后者重用源路径而不是复制到托管安装目标。

`--pin` 仅适用于 npm。它不支持 `--marketplace`，因为市场安装会保留市场源元数据而不是 npm 规范。

`--dangerously-force-unsafe-install` 是内置危险代码扫描程序误报的紧急覆盖。它允许插件安装和插件更新继续超过内置的 `critical` 发现，但它仍然不会绕过插件 `before_install` 策略阻止或扫描失败阻止。

此 CLI 标志仅适用于插件安装/更新流程。网关支持的技能依赖安装使用匹配的 `dangerouslyForceUnsafeInstall` 请求覆盖，而 `openclaw skills install` 仍然是单独的 ClawHub 技能下载/安装流程。

兼容包参与相同的插件列表/检查/启用/禁用流程。当前运行时支持包括包技能、Claude 命令技能、Claude `settings.json` 默认值、Claude `.lsp.json` 和清单声明的 `lspServers` 默认值、Cursor 命令技能和兼容的 Codex 钩子目录。

`openclaw plugins inspect <id>` 还报告检测到的包功能以及包支持的插件的支持或不支持的 MCP 和 LSP 服务器条目。

市场源可以是来自 `~/.claude/plugins/known_marketplaces.json` 的 Claude 已知市场名称、本地市场根目录或 `marketplace.json` 路径、GitHub 简写（如 `owner/repo`）、GitHub 仓库 URL 或 git URL。对于远程市场，插件条目必须留在克隆的市场仓库内，并且仅使用相对路径源。

有关完整详细信息，请参阅 [`openclaw plugins` CLI 参考](/cli/plugins)。

## 插件 API 概述

原生插件导出一个暴露 `register(api)` 的入口对象。较旧的插件可能仍然使用 `activate(api)` 作为旧别名，但新插件应使用 `register`。

```typescript
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
    api.registerChannel({
      /* ... */
    });
  },
});
```

OpenClaw 在插件激活期间加载入口对象并调用 `register(api)`。加载器仍然为较旧的插件回退到 `activate(api)`，但捆绑插件和新的外部插件应将 `register` 视为公共契约。

常见注册方法：

| 方法                                    | 注册内容              |
| --------------------------------------- | --------------------- |
| `registerProvider`                      | 模型提供者（LLM）     |
| `registerChannel`                       | 聊天通道              |
| `registerTool`                          | 代理工具              |
| `registerHook` / `on(...)`              | 生命周期钩子          |
| `registerSpeechProvider`                | 文本到语音 / STT      |
| `registerRealtimeTranscriptionProvider` | 流式 STT              |
| `registerRealtimeVoiceProvider`         | 双向实时语音          |
| `registerMediaUnderstandingProvider`    | 图像/音频分析         |
| `registerImageGenerationProvider`       | 图像生成              |
| `registerMusicGenerationProvider`       | 音乐生成              |
| `registerVideoGenerationProvider`       | 视频生成              |
| `registerWebFetchProvider`              | 网络获取 / 抓取提供者 |
| `registerWebSearchProvider`             | 网络搜索              |
| `registerHttpRoute`                     | HTTP 端点             |
| `registerCommand` / `registerCli`       | CLI 命令              |
| `registerContextEngine`                 | 上下文引擎            |
| `registerService`                       | 后台服务              |

类型化生命周期钩子的钩子保护行为：

- `before_tool_call`：`{ block: true }` 是终端；跳过较低优先级的处理程序。
- `before_tool_call`：`{ block: false }` 是无操作，不会清除 earlier block。
- `before_install`：`{ block: true }` 是终端；跳过较低优先级的处理程序。
- `before_install`：`{ block: false }` 是无操作，不会清除 earlier block。
- `message_sending`：`{ cancel: true }` 是终端；跳过较低优先级的处理程序。
- `message_sending`：`{ cancel: false }` 是无操作，不会清除 earlier cancel。

有关完整的类型化钩子行为，请参阅 [SDK 概述](/plugins/sdk-overview#hook-decision-semantics)。

## 相关

- [构建插件](/plugins/building-plugins) — 创建你自己的插件
- [插件包](/plugins/bundles) — Codex/Claude/Cursor 包兼容性
- [插件清单](/plugins/manifest) — 清单架构
- [注册工具](/plugins/building-plugins#registering-agent-tools) — 在插件中添加代理工具
- [插件内部](/plugins/architecture) — 能力模型和加载管道
- [社区插件](/plugins/community) — 第三方列表
