---
summary: "集成浏览器控制服务 + 动作命令"
read_when:
  - 添加代理控制的浏览器自动化
  - 调试为什么 openclaw 会干扰你自己的 Chrome
  - 在 macOS 应用中实现浏览器设置 + 生命周期
title: "浏览器（OpenClaw 管理）"
---

# 浏览器（openclaw 管理）

OpenClaw 可以运行一个**专用的 Chrome/Brave/Edge/Chromium 配置文件**，由代理控制。它与你的个人浏览器隔离，并通过 Gateway 内部的小型本地控制服务管理（仅限环回）。

初学者视图：

- 将其视为**单独的、仅代理的浏览器**。
- `openclaw` 配置文件**不会**触及你的个人浏览器配置文件。
- 代理可以在安全通道中**打开标签页、读取页面、点击和输入**。
- 内置的 `user` 配置文件通过 Chrome MCP 附加到你真正登录的 Chrome 会话。

## 你获得的功能

- 一个名为 **openclaw** 的单独浏览器配置文件（默认橙色强调）。
- 确定性标签页控制（列出/打开/聚焦/关闭）。
- 代理动作（点击/输入/拖动/选择）、快照、截图、PDF。
- 可选的多配置文件支持（`openclaw`、`work`、`remote` 等）。

这个浏览器**不是**你的日常浏览器。它是一个用于代理自动化和验证的安全、隔离的界面。

## 快速开始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果你收到“浏览器已禁用”，请在配置中启用它（见下文）并重新启动 Gateway。

如果 `openclaw browser` 完全缺失，或者代理说浏览器工具不可用，请跳转到 [缺少浏览器命令或工具](/tools/browser#missing-browser-command-or-tool)。

## 插件控制

默认的 `browser` 工具现在是一个捆绑的插件，默认启用。这意味着你可以禁用或替换它，而无需删除 OpenClaw 插件系统的其余部分：

```json5
{
  plugins: {
    entries: {
      browser: {
        enabled: false,
      },
    },
  },
}
```

在安装提供相同 `browser` 工具名称的另一个插件之前，禁用捆绑插件。默认浏览器体验需要两者：

- `plugins.entries.browser.enabled` 未禁用
- `browser.enabled=true`

如果你只关闭插件，捆绑的浏览器 CLI（`openclaw browser`）、网关方法（`browser.request`）、代理工具和默认浏览器控制服务都会一起消失。你的 `browser.*` 配置保持不变，供替换插件重用。

捆绑的浏览器插件现在还拥有浏览器运行时实现。Core 只保留共享的插件 SDK 助手以及对旧内部导入路径的兼容性重新导出。实际上，删除或替换浏览器插件包会移除浏览器功能集，而不是留下第二个核心拥有的运行时。

浏览器配置更改仍然需要 Gateway 重启，以便捆绑插件可以使用新设置重新注册其浏览器服务。

## 缺少浏览器命令或工具

如果 `openclaw browser` 在升级后突然成为未知命令，或者代理报告浏览器工具缺失，最常见的原因是限制性的 `plugins.allow` 列表不包含 `browser`。

示例损坏的配置：

```json5
{
  plugins: {
    allow: ["telegram"],
  },
}
```

通过将 `browser` 添加到插件允许列表来修复：

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

重要说明：

- 当设置了 `plugins.allow` 时，仅 `browser.enabled=true` 是不够的。
- 当设置了 `plugins.allow` 时，仅 `plugins.entries.browser.enabled=true` 也是不够的。
- `tools.alsoAllow: ["browser"]` **不会**加载捆绑的浏览器插件。它只在插件已经加载后调整工具策略。
- 如果你不需要限制性的插件允许列表，删除 `plugins.allow` 也会恢复默认的捆绑浏览器行为。

典型症状：

- `openclaw browser` 是未知命令。
- `browser.request` 缺失。
- 代理报告浏览器工具不可用或缺失。

## 配置文件：`openclaw` vs `user`

- `openclaw`：管理的、隔离的浏览器（无需扩展）。
- `user`：用于你**真正登录的 Chrome** 会话的内置 Chrome MCP 附加配置文件。

对于代理浏览器工具调用：

- 默认：使用隔离的 `openclaw` 浏览器。
- 当现有登录会话很重要且用户在计算机前点击/批准任何附加提示时，首选 `profile="user"`。
- 当你想要特定浏览器模式时，`profile` 是显式覆盖。

如果你希望默认使用管理模式，请设置 `browser.defaultProfile: "openclaw"`。

## 配置

浏览器设置位于 `~/.openclaw/openclaw.json`。

```json5
{
  browser: {
    enabled: true, // 默认：true
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // 仅对受信任的私有网络访问选择加入
      // allowPrivateNetwork: true, // 旧别名
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    // cdpUrl: "http://127.0.0.1:18792", // 旧单配置文件覆盖
    remoteCdpTimeoutMs: 1500, // 远程 CDP HTTP 超时（毫秒）
    remoteCdpHandshakeTimeoutMs: 3000, // 远程 CDP WebSocket 握手超时（毫秒）
    defaultProfile: "openclaw",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      user: {
        driver: "existing-session",
        attachOnly: true,
        color: "#00AA00",
      },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

注意：

- 浏览器控制服务绑定到从 `gateway.port` 派生的端口上的环回（默认：`18791`，即 gateway + 2）。
- 如果你覆盖 Gateway 端口（`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`），派生的浏览器端口会移位以保持在同一“家族”中。
- 当未设置时，`cdpUrl` 默认为管理的本地 CDP 端口。
- `remoteCdpTimeoutMs` 适用于远程（非环回）CDP 可达性检查。
- `remoteCdpHandshakeTimeoutMs` 适用于远程 CDP WebSocket 可达性检查。
- 浏览器导航/打开标签页在导航前受 SSRF 保护，并在导航后对最终 `http(s)` URL 进行最佳努力重新检查。
- 在严格 SSRF 模式下，远程 CDP 端点发现/探测（`cdpUrl`，包括 `/json/version` 查找）也会被检查。
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` 默认禁用。仅当你有意信任私有网络浏览器访问时，才将其设置为 `true`。
- `browser.ssrfPolicy.allowPrivateNetwork` 作为兼容性的旧别名仍然受支持。
- `attachOnly: true` 意味着“永远不要启动本地浏览器；仅在已经运行时附加。”
- `color` + 每个配置文件的 `color` 会给浏览器 UI 着色，以便你可以看到哪个配置文件处于活动状态。
- 默认配置文件是 `openclaw`（OpenClaw 管理的独立浏览器）。使用 `defaultProfile: "user"` 选择登录用户浏览器。
- 自动检测顺序：如果是基于 Chromium 的系统默认浏览器；否则 Chrome → Brave → Edge → Chromium → Chrome Canary。
- 本地 `openclaw` 配置文件自动分配 `cdpPort`/`cdpUrl` — 仅为远程 CDP 设置这些。
- `driver: "existing-session"` 使用 Chrome DevTools MCP 而不是原始 CDP。不要为该驱动程序设置 `cdpUrl`。
- 当现有会话配置文件应附加到非默认 Chromium 用户配置文件（如 Brave 或 Edge）时，设置 `browser.profiles.<name>.userDataDir`。

## 使用 Brave（或其他基于 Chromium 的浏览器）

如果你的**系统默认**浏览器是基于 Chromium 的（Chrome/Brave/Edge 等），OpenClaw 会自动使用它。设置 `browser.executablePath` 以覆盖自动检测：

CLI 示例：

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## 本地 vs 远程控制

- **本地控制（默认）**：Gateway 启动环回控制服务并可以启动本地浏览器。
- **远程控制（节点主机）**：在拥有浏览器的机器上运行节点主机；Gateway 将浏览器动作代理到它。
- **远程 CDP**：设置 `browser.profiles.<name>.cdpUrl`（或 `browser.cdpUrl`）以附加到远程基于 Chromium 的浏览器。在这种情况下，OpenClaw 不会启动本地浏览器。

停止行为因配置文件模式而异：

- 本地管理的配置文件：`openclaw browser stop` 停止 OpenClaw 启动的浏览器进程
- 仅附加和远程 CDP 配置文件：`openclaw browser stop` 关闭活动控制会话并释放 Playwright/CDP 模拟覆盖（视口、配色方案、区域设置、时区、离线模式和类似状态），即使没有浏览器进程由 OpenClaw 启动

远程 CDP URL 可以包含身份验证：

- 查询令牌（例如，`https://provider.example?token=<token>`）
- HTTP 基本身份验证（例如，`https://user:pass@provider.example`）

OpenClaw 在调用 `/json/*` 端点和连接到 CDP WebSocket 时保留身份验证。首选环境变量或密钥管理器来存储令牌，而不是将它们提交到配置文件。

## 节点浏览器代理（零配置默认）

如果你在拥有浏览器的机器上运行**节点主机**，OpenClaw 可以自动将浏览器工具调用路由到该节点，无需任何额外的浏览器配置。这是远程网关的默认路径。

注意：

- 节点主机通过**代理命令**公开其本地浏览器控制服务器。
- 配置文件来自节点自己的 `browser.profiles` 配置（与本地相同）。
- `nodeHost.browserProxy.allowProfiles` 是可选的。留空以获得旧/默认行为：所有配置的配置文件都可以通过代理访问，包括配置文件创建/删除路由。
- 如果你设置 `nodeHost.browserProxy.allowProfiles`，OpenClaw 将其视为最小权限边界：只能针对允许列出的配置文件，并且代理表面上的持久配置文件创建/删除路由被阻止。
- 如果你不想要它，请禁用：
  - 在节点上：`nodeHost.browserProxy.enabled=false`
  - 在网关上：`gateway.nodes.browser.mode="off"`

## Browserless（托管远程 CDP）

[Browserless](https://browserless.io) 是一个托管的 Chromium 服务，通过 HTTPS 和 WebSocket 公开 CDP 连接 URL。OpenClaw 可以使用任何形式，但对于远程浏览器配置文件，最简单的选项是 Browserless 连接文档中的直接 WebSocket URL。

示例：

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "wss://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

注意：

- 用你真实的 Browserless 令牌替换 `<BROWSERLESS_API_KEY>`。
- 选择与你的 Browserless 账户匹配的区域端点（见他们的文档）。
- 如果 Browserless 给你一个 HTTPS 基础 URL，你可以将其转换为 `wss://` 以进行直接 CDP 连接，或者保留 HTTPS URL 并让 OpenClaw 发现 `/json/version`。

## 直接 WebSocket CDP 提供商

一些托管的浏览器服务公开**直接 WebSocket** 端点，而不是标准的基于 HTTP 的 CDP 发现（`/json/version`）。OpenClaw 接受三种 CDP URL 形状并自动选择正确的连接策略：

- **HTTP(S) 发现** — `http://host[:port]` 或 `https://host[:port]`。OpenClaw 调用 `/json/version` 来发现 WebSocket 调试器 URL，然后连接。无 WebSocket 回退。
- **直接 WebSocket 端点** — `ws://host[:port]/devtools/<kind>/<id>` 或 `wss://...` 带有 `/devtools/browser|page|worker|shared_worker|service_worker/<id>` 路径。OpenClaw 通过 WebSocket 握手直接连接并完全跳过 `/json/version`。
- **裸 WebSocket 根** — `ws://host[:port]` 或 `wss://host[:port]` 没有 `/devtools/...` 路径（例如 [Browserless](https://browserless.io)、[Browserbase](https://www.browserbase.com)）。OpenClaw 首先尝试 HTTP `/json/version` 发现（将方案标准化为 `http`/`https`）；如果发现返回 `webSocketDebuggerUrl`，则使用它，否则 OpenClaw 回退到在裸根处的直接 WebSocket 握手。这涵盖了 Chrome 风格的远程调试端口和仅 WebSocket 提供商。

指向本地 Chrome 实例的没有 `/devtools/...` 路径的纯 `ws://host:port` / `wss://host:port` 通过发现优先回退支持 — Chrome 只接受 WebSocket 升级到 `/json/version` 返回的特定每个浏览器或每个目标路径，因此仅裸根握手会失败。

### Browserbase

[Browserbase](https://www.browserbase.com) 是一个云平台，用于运行带有内置 CAPTCHA 解决、隐身模式和住宅代理的无头浏览器。

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    remoteCdpTimeoutMs: 3000,
    remoteCdpHandshakeTimeoutMs: 5000,
    profiles: {
      browserbase: {
        cdpUrl: "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>",
        color: "#F97316",
      },
    },
  },
}
```

注意：

- [注册](https://www.browserbase.com/sign-up) 并从 [概览仪表板](https://www.browserbase.com/overview) 复制你的**API 密钥**。
- 用你真实的 Browserbase API 密钥替换 `<BROWSERBASE_API_KEY>`。
- Browserbase 在 WebSocket 连接时自动创建浏览器会话，因此不需要手动会话创建步骤。
- 免费套餐允许每月一个并发会话和一个浏览器小时。有关付费计划限制，请参见 [定价](https://www.browserbase.com/pricing)。
- 有关完整的 API 参考、SDK 指南和集成示例，请参见 [Browserbase 文档](https://docs.browserbase.com)。

## 安全性

关键思想：

- 浏览器控制仅限环回；访问通过 Gateway 的身份验证或节点配对流动。
- 独立环回浏览器 HTTP API 仅使用**共享密钥身份验证**：网关令牌承载身份验证、`x-openclaw-password` 或带有配置的网关密码的 HTTP 基本身份验证。
- Tailscale Serve 身份标头和 `gateway.auth.mode: "trusted-proxy"` **不**验证此独立环回浏览器 API。
- 如果启用了浏览器控制且未配置共享密钥身份验证，OpenClaw 会在启动时自动生成 `gateway.auth.token` 并将其持久化到配置中。
- 当 `gateway.auth.mode` 已经是 `password`、`none` 或 `trusted-proxy` 时，OpenClaw **不会**自动生成该令牌。
- 将 Gateway 和任何节点主机保持在专用网络（Tailscale）上；避免公开暴露。
- 将远程 CDP URL/令牌视为机密；首选环境变量或密钥管理器。

远程 CDP 提示：

- 尽可能首选加密端点（HTTPS 或 WSS）和短期令牌。
- 避免在配置文件中直接嵌入长期令牌。

## 配置文件（多浏览器）

OpenClaw 支持多个命名配置文件（路由配置）。配置文件可以是：

- **openclaw 管理**：具有自己的用户数据目录 + CDP 端口的专用基于 Chromium 的浏览器实例
- **远程**：显式 CDP URL（在其他地方运行的基于 Chromium 的浏览器）
- **现有会话**：通过 Chrome DevTools MCP 自动连接的现有 Chrome 配置文件

默认值：

- 如果缺少，`openclaw` 配置文件会自动创建。
- `user` 配置文件是内置的，用于 Chrome MCP 现有会话附加。
- 现有会话配置文件在 `user` 之外是可选的；使用 `--driver existing-session` 创建它们。
- 本地 CDP 端口默认从 **18800–18899** 分配。
- 删除配置文件会将其本地数据目录移动到回收站。

所有控制端点都接受 `?profile=<name>`；CLI 使用 `--browser-profile`。

## 通过 Chrome DevTools MCP 进行现有会话

OpenClaw 还可以通过官方 Chrome DevTools MCP 服务器附加到运行中的基于 Chromium 的浏览器配置文件。这会重用该浏览器配置文件中已经打开的标签页和登录状态。

官方背景和设置参考：

- [Chrome for Developers: Use Chrome DevTools MCP with your browser session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp)

内置配置文件：

- `user`

可选：如果你想要不同的名称、颜色或浏览器数据目录，创建自己的自定义现有会话配置文件。

默认行为：

- 内置的 `user` 配置文件使用 Chrome MCP 自动连接，目标是默认的本地 Google Chrome 配置文件。

对 Brave、Edge、Chromium 或非默认 Chrome 配置文件使用 `userDataDir`：

```json5
{
  browser: {
    profiles: {
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
    },
  },
}
```

然后在匹配的浏览器中：

1. 打开该浏览器的远程调试检查页面。
2. 启用远程调试。
3. 保持浏览器运行并在 OpenClaw 附加时批准连接提示。

常见检查页面：

- Chrome: `chrome://inspect/#remote-debugging`
- Brave: `brave://inspect/#remote-debugging`
- Edge: `edge://inspect/#remote-debugging`

实时附加烟雾测试：

```bash
openclaw browser --browser-profile user start
openclaw browser --browser-profile user status
openclaw browser --browser-profile user tabs
openclaw browser --browser-profile user snapshot --format ai
```

成功的样子：

- `status` 显示 `driver: existing-session`
- `status` 显示 `transport: chrome-mcp`
- `status` 显示 `running: true`
- `tabs` 列出你已经打开的浏览器标签页
- `snapshot` 从选定的活动标签页返回引用

如果附加不起作用，要检查的内容：

- 目标基于 Chromium 的浏览器是 `144+` 版本
- 该浏览器的检查页面中启用了远程调试
- 浏览器显示并你接受了附加同意提示
- `openclaw doctor` 迁移旧的基于扩展的浏览器配置并检查 Chrome 是否本地安装用于默认自动连接配置文件，但它不能为你启用浏览器端远程调试

代理使用：

- 当你需要用户的登录浏览器状态时，使用 `profile="user"`。
- 如果你使用自定义现有会话配置文件，请传递该显式配置文件名称。
- 仅当用户在计算机前批准附加提示时才选择此模式。
- Gateway 或节点主机可以生成 `npx chrome-devtools-mcp@latest --autoConnect`

注意：

- 此路径比隔离的 `openclaw` 配置文件风险更高，因为它可以在你的登录浏览器会话中行动。
- OpenClaw 不为此驱动程序启动浏览器；它仅附加到现有会话。
- OpenClaw 在此处使用官方 Chrome DevTools MCP `--autoConnect` 流程。如果设置了 `userDataDir`，OpenClaw 会将其传递以目标该显式 Chromium 用户数据目录。
- 现有会话屏幕截图支持页面捕获和来自快照的 `--ref` 元素捕获，但不支持 CSS `--element` 选择器。
- 现有会话页面屏幕截图通过 Chrome MCP 在没有 Playwright 的情况下工作。基于引用的元素屏幕截图（`--ref`）也在那里工作，但 `--full-page` 不能与 `--ref` 或 `--element` 结合使用。
- 现有会话动作仍然比管理浏览器路径更有限：
  - `click`、`type`、`hover`、`scrollIntoView`、`drag` 和 `select` 需要来自快照的引用，而不是 CSS 选择器
  - `click` 仅限左键（无按钮覆盖或修饰符）
  - `type` 不支持 `slowly=true`；使用 `fill` 或 `press`
  - `press` 不支持 `delayMs`
  - `hover`、`scrollIntoView`、`drag`、`select`、`fill` 和 `evaluate` 不支持每次调用的超时覆盖
  - `select` 当前仅支持单个值
- 现有会话 `wait --url` 支持精确、子字符串和 glob 模式，如其他浏览器驱动程序。`wait --load networkidle` 尚未支持。
- 现有会话上传钩子需要 `ref` 或 `inputRef`，一次支持一个文件，不支持 CSS `element` 目标。
- 现有会话对话框钩子不支持超时覆盖。
- 某些功能仍然需要管理浏览器路径，包括批处理动作、PDF 导出、下载拦截和 `responsebody`。
- 现有会话可以在选定的主机上或通过连接的浏览器节点附加。如果 Chrome 位于其他地方且没有连接浏览器节点，请使用远程 CDP 或节点主机。

## 隔离保证

- **专用用户数据目录**：永远不会触及你的个人浏览器配置文件。
- **专用端口**：避免 `9222` 以防止与开发工作流程冲突。
- **确定性标签页控制**：按 `targetId` 目标标签页，而不是“最后一个标签页”。

## 浏览器选择

当在本地启动时，OpenClaw 选择第一个可用的：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

你可以使用 `browser.executablePath` 覆盖。

平台：

- macOS：检查 `/Applications` 和 `~/Applications`。
- Linux：查找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：检查常见安装位置。

## 控制 API（可选）

仅用于本地集成，Gateway 公开一个小型环回 HTTP API：

- 状态/启动/停止：`GET /`、`POST /start`、`POST /stop`
- 标签页：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- 快照/截图：`GET /snapshot`、`POST /screenshot`
- 动作：`POST /navigate`、`POST /act`
- 钩子：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- 下载：`POST /download`、`POST /wait/download`
- 调试：`GET /console`、`POST /pdf`
- 调试：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- 网络：`POST /response/body`
- 状态：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 状态：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 设置：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

所有端点都接受 `?profile=<name>`。

如果配置了共享密钥网关身份验证，浏览器 HTTP 路由也需要身份验证：

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 或带有该密码的 HTTP 基本身份验证

注意：

- 此独立环回浏览器 API **不**使用受信任代理或 Tailscale Serve 身份标头。
- 如果 `gateway.auth.mode` 是 `none` 或 `trusted-proxy`，这些环回浏览器路由不会继承那些带有身份的模式；保持它们仅限环回。

### `/act` 错误合约

`POST /act` 对路由级验证和策略失败使用结构化错误响应：

```json
{ "error": "<message>", "code": "ACT_*" }
```

当前 `code` 值：

- `ACT_KIND_REQUIRED` (HTTP 400)：`kind` 缺失或未识别。
- `ACT_INVALID_REQUEST` (HTTP 400)：动作有效负载失败标准化或验证。
- `ACT_SELECTOR_UNSUPPORTED` (HTTP 400)：`selector` 与不支持的动作类型一起使用。
- `ACT_EVALUATE_DISABLED` (HTTP 403)：`evaluate`（或 `wait --fn`）被配置禁用。
- `ACT_TARGET_ID_MISMATCH` (HTTP 403)：顶级或批处理 `targetId` 与请求目标冲突。
- `ACT_EXISTING_SESSION_UNSUPPORTED` (HTTP 501)：动作不支持现有会话配置文件。

其他运行时失败可能仍然返回 `{ "error": "<message>" }` 而没有 `code` 字段。

### Playwright 要求

某些功能（导航/动作/AI 快照/角色快照、元素截图、PDF）需要 Playwright。如果 Playwright 未安装，这些端点会返回明确的 501 错误。

没有 Playwright 仍然可以工作的内容：

- ARIA 快照
- 当每个标签页 CDP WebSocket 可用时，管理的 `openclaw` 浏览器的页面截图
- `existing-session` / Chrome MCP 配置文件的页面截图
- 来自快照输出的 `existing-session` 基于引用的截图 (`--ref`)

仍然需要 Playwright 的内容：

- `navigate`
- `act`
- AI 快照 / 角色快照
- CSS 选择器元素截图 (`--element`)
- 完整浏览器 PDF 导出

元素截图也拒绝 `--full-page`；路由返回 `fullPage is not supported for element screenshots`。

如果你看到 `Playwright is not available in this gateway build`，请安装完整的 Playwright 包（不是 `playwright-core`）并重启网关，或重新安装带有浏览器支持的 OpenClaw。

#### Docker Playwright 安装

如果你的 Gateway 在 Docker 中运行，避免 `npx playwright`（npm 覆盖冲突）。改用捆绑的 CLI：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

要持久化浏览器下载，请设置 `PLAYWRIGHT_BROWSERS_PATH`（例如，`/home/node/.cache/ms-playwright`）并确保 `/home/node` 通过 `OPENCLAW_HOME_VOLUME` 或绑定挂载持久化。请参阅 [Docker](/install/docker)。

## 工作原理（内部）

高级流程：

- 一个小型**控制服务器**接受 HTTP 请求。
- 它通过**CDP** 连接到基于 Chromium 的浏览器（Chrome/Brave/Edge/Chromium）。
- 对于高级动作（点击/输入/快照/PDF），它在 CDP 之上使用**Playwright**。
- 当 Playwright 缺失时，只有非 Playwright 操作可用。

这种设计使代理保持在稳定、确定性的接口上，同时让你可以交换本地/远程浏览器和配置文件。

## CLI 快速参考

所有命令都接受 `--browser-profile <name>` 以目标特定配置文件。所有命令也接受 `--json` 以获得机器可读输出（稳定有效负载）。

基础：

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

检查：

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`

生命周期注意：

- 对于仅附加和远程 CDP 配置文件，`openclaw browser stop` 仍然是测试后正确的清理命令。它关闭活动控制会话并清除临时模拟覆盖，而不是杀死底层浏览器。
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

动作：

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 report.pdf`
- `openclaw browser waitfordownload report.pdf`
- `openclaw browser upload /tmp/openclaw/uploads/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

状态：

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --headers-json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

注意：

- `upload` 和 `dialog` 是**武装**调用；在触发选择器/对话框的点击/按下之前运行它们。
- 下载和跟踪输出路径限于 OpenClaw 临时根目录：
  - 跟踪：`/tmp/openclaw`（回退：`${os.tmpdir()}/openclaw`）
  - 下载：`/tmp/openclaw/downloads`（回退：`${os.tmpdir()}/openclaw/downloads`）
- 上传路径限于 OpenClaw 临时上传根目录：
  - 上传：`/tmp/openclaw/uploads`（回退：`${os.tmpdir()}/openclaw/uploads`）
- `upload` 也可以通过 `--input-ref` 或 `--element` 直接设置文件输入。
- `snapshot`：
  - `--format ai`（安装 Playwright 时默认）：返回带有数字引用的 AI 快照 (`aria-ref="<n>"`)。
  - `--format aria`：返回可访问性树（无引用；仅检查）。
  - `--efficient`（或 `--mode efficient`）：紧凑角色快照预设（交互式 + 紧凑 + 深度 + 较低的 maxChars）。
  - 配置默认值（仅工具/CLI）：设置 `browser.snapshotDefaults.mode: "efficient"` 以在调用者未传递模式时使用高效快照（见 [Gateway 配置](/gateway/configuration-reference#browser)）。
  - 角色快照选项（`--interactive`、`--compact`、`--depth`、`--selector`）强制基于角色的快照，引用如 `ref=e12`。
  - `--frame "<iframe selector>"` 将角色快照范围限定到 iframe（与角色引用如 `e12` 配对）。
  - `--interactive` 输出一个扁平、易于选择的交互式元素列表（最适合驱动动作）。
  - `--labels` 添加带有覆盖 `e12` 标签的视口截图（打印 `MEDIA:<path>`）。
- `click`/`type`/等需要来自 `snapshot` 的 `ref`（数字 `12` 或角色引用 `e12`）。CSS 选择器有意不支持动作。

## 快照和引用

OpenClaw 支持两种“快照”样式：

- **AI 快照（数字引用）**：`openclaw browser snapshot`（默认；`--format ai`）
  - 输出：包含数字引用的文本快照。
  - 动作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 内部，引用通过 Playwright 的 `aria-ref` 解析。

- **角色快照（角色引用如 `e12`）**：`openclaw browser snapshot --interactive`（或 `--compact`、`--depth`、`--selector`、`--frame`）
  - 输出：带有 `[ref=e12]`（和可选的 `[nth=1]`）的基于角色的列表/树。
  - 动作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 内部，引用通过 `getByRole(...)` 解析（加上 `nth()` 用于重复项）。
  - 添加 `--labels` 以包含带有覆盖 `e12` 标签的视口截图。

引用行为：

- 引用在**导航之间不稳定**；如果失败，重新运行 `snapshot` 并使用新的引用。
- 如果角色快照是用 `--frame` 拍摄的，角色引用会限定到该 iframe，直到下一个角色快照。

## 等待增强

你可以等待的不仅仅是时间/文本：

- 等待 URL（Playwright 支持 glob）：
  - `openclaw browser wait --url "**/dash"`
- 等待加载状态：
  - `openclaw browser wait --load networkidle`
- 等待 JS 谓词：
  - `openclaw browser wait --fn "window.ready===true"`
- 等待选择器变为可见：
  - `openclaw browser wait "#main"`

这些可以组合：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 调试工作流程

当动作失败时（例如“不可见”、“严格模式违规”、“被覆盖”）：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>` / `type <ref>`（在交互模式下首选角色引用）
3. 如果仍然失败：`openclaw browser highlight <ref>` 查看 Playwright 正在目标什么
4. 如果页面行为异常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 对于深度调试：记录跟踪：
   - `openclaw browser trace start`
   - 重现问题
   - `openclaw browser trace stop`（打印 `TRACE:<path>`）

## JSON 输出

`--json` 用于脚本和结构化工具。

示例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 中的角色快照包含 `refs` 加上一个小的 `stats` 块（行/字符/引用/交互），以便工具可以推理有效负载大小和密度。

## 状态和环境旋钮

这些对于“让网站表现得像 X”工作流程很有用：

- Cookie：`cookies`、`cookies set`、`cookies clear`
- 存储：`storage local|session get|set|clear`
- 离线：`set offline on|off`
- 标头：`set headers --headers-json '{"X-Debug":"1"}'`（旧 `set headers --json '{"X-Debug":"1"}'` 仍然受支持）
- HTTP 基本身份验证：`set credentials user pass`（或 `--clear`）
- 地理位置：`set geo <lat> <lon> --origin "https://example.com"`（或 `--clear`）
- 媒体：`set media dark|light|no-preference|none`
- 时区 / 区域设置：`set timezone ...`、`set locale ...`
- 设备 / 视口：
  - `set device "iPhone 14"`（Playwright 设备预设）
  - `set viewport 1280 720`

## 安全与隐私

- openclaw 浏览器配置文件可能包含登录会话；将其视为敏感。
- `browser act kind=evaluate` / `openclaw browser evaluate` 和 `wait --fn` 在页面上下文中执行任意 JavaScript。提示注入可以引导此操作。如果你不需要它，请使用 `browser.evaluateEnabled=false` 禁用它。
- 关于登录和反机器人说明（X/Twitter 等），请参阅 [浏览器登录 + X/Twitter 发布](/tools/browser-login)。
- 保持 Gateway/节点主机私有（环回或仅 tailnet）。
- 远程 CDP 端点功能强大；隧道并保护它们。

严格模式示例（默认阻止私有/内部目标）：

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"], // 可选的精确允许
    },
  },
}
```

## 故障排除

对于 Linux 特定问题（尤其是 snap Chromium），请参阅 [浏览器故障排除](/tools/browser-linux-troubleshooting)。

对于 WSL2 Gateway + Windows Chrome 分离主机设置，请参阅 [WSL2 + Windows + 远程 Chrome CDP 故障排除](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)。

### CDP 启动失败 vs 导航 SSRF 阻止

这些是不同的失败类别，它们指向不同的代码路径。

- **CDP 启动或就绪失败**意味着 OpenClaw 无法确认浏览器控制平面是否健康。
- **导航 SSRF 阻止**意味着浏览器控制平面健康，但页面导航目标被策略拒绝。

常见示例：

- CDP 启动或就绪失败：
  - `Chrome CDP websocket for profile "openclaw" is not reachable after start`
  - `Remote CDP for profile "<name>" is not reachable at <cdpUrl>`
- 导航 SSRF 阻止：
  - `open`、`navigate`、快照或标签页打开流程失败，出现浏览器/网络策略错误，而 `start` 和 `tabs` 仍然工作

使用此最小序列来分离两者：

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile openclaw open https://example.com
```

如何阅读结果：

- 如果 `start` 失败并显示 `not reachable after start`，首先排查 CDP 就绪性。
- 如果 `start` 成功但 `tabs` 失败，控制平面仍然不健康。将此视为 CDP 可达性问题，而不是页面导航问题。
- 如果 `start` 和 `tabs` 成功但 `open` 或 `navigate` 失败，浏览器控制平面已启动，失败在导航策略或目标页面中。
- 如果 `start`、`tabs` 和 `open` 都成功，基本的管理浏览器控制路径是健康的。

重要行为细节：

- 即使你未配置 `browser.ssrfPolicy`，浏览器配置默认也会使用故障关闭的 SSRF 策略对象。
- 对于本地环回 `openclaw` 管理配置文件，CDP 健康检查故意跳过 OpenClaw 自己的本地控制平面的浏览器 SSRF 可达性强制执行。
- 导航保护是分开的。成功的 `start` 或 `tabs` 结果并不意味着稍后的 `open` 或 `navigate` 目标被允许。

安全指导：

- 默认情况下**不要**放宽浏览器 SSRF 策略。
- 首选狭窄的主机例外，如 `hostnameAllowlist` 或 `allowedHostnames`，而不是广泛的私有网络访问。
- 仅在有意信任的环境中使用 `dangerouslyAllowPrivateNetwork: true`，其中需要并审查私有网络浏览器访问。

示例：导航被阻止，控制平面健康

- `start` 成功
- `tabs` 成功
- `open http://internal.example` 失败

这通常意味着浏览器启动正常，导航目标需要策略审查。

示例：在导航重要之前启动被阻止

- `start` 失败，显示 `not reachable after start`
- `tabs` 也失败或无法运行

这指向浏览器启动或 CDP 可达性，而不是页面 URL 允许列表问题。

## 代理工具 + 控制如何工作

代理获得**一个工具**用于浏览器自动化：

- `browser` — 状态/启动/停止/标签页/打开/聚焦/关闭/快照/截图/导航/动作

它如何映射：

- `browser snapshot` 返回稳定的 UI 树（AI 或 ARIA）。
- `browser act` 使用快照 `ref` ID 来点击/输入/拖动/选择。
- `browser screenshot` 捕获像素（全页或元素）。
- `browser` 接受：
  - `profile` 选择命名的浏览器配置文件（openclaw、chrome 或远程 CDP）。
  - `target` (`sandbox` | `host` | `node`) 选择浏览器所在的位置。
  - 在沙盒会话中，`target: "host"` 需要 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 如果省略 `target`：沙盒会话默认为 `sandbox`，非沙盒会话默认为 `host`。
  - 如果连接了支持浏览器的节点，工具可能会自动路由到它，除非你固定 `target="host"` 或 `target="node"`。

这保持代理确定性并避免脆弱的选择器。

## 相关

- [工具概述](/tools) — 所有可用的代理工具
- [沙盒](/gateway/sandboxing) — 沙盒环境中的浏览器控制
- [安全性](/gateway/security) — 浏览器控制风险和加固
