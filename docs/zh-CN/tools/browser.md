---
read_when:
  - 添加智能体控制的浏览器自动化
  - 调试 openclaw 为何干扰了你自己的 Chrome
  - 在 macOS 应用中实现浏览器设置 + 生命周期
summary: 集成浏览器控制服务 + 操作命令
title: 浏览器（OpenClaw 托管）
x-i18n:
  generated_at: "2026-02-01T21:42:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9f182ea9701becdd710a2d9ed0f481f6556c8e2611aab60ead27693924e4b8ca
  source_path: tools/browser.md
  workflow: 15
---

# 浏览器（openclaw 托管）

OpenClaw 可以运行一个由智能体控制的**专用 Chrome/Brave/Edge/Chromium 配置文件**。
它与你的个人浏览器隔离，通过 Gateway网关内部的一个小型本地控制服务进行管理（仅限 local loopback）。

初学者视角：

- 可以把它看作一个**独立的、仅供智能体使用的浏览器**。
- `openclaw` 配置文件**不会**影响你的个人浏览器配置文件。
- 智能体可以在安全的通道中**打开标签页、读取页面、点击和输入**。
- 默认的 `chrome` 配置文件通过扩展中继使用**系统默认的 Chromium 浏览器**；切换到 `openclaw` 以使用隔离的托管浏览器。

## 你能获得什么

- 一个名为 **openclaw** 的独立浏览器配置文件（默认为橙色主题）。
- 确定性标签页控制（列出/打开/聚焦/关闭）。
- 智能体操作（点击/输入/拖拽/选择）、快照、截图、PDF。
- 可选的多配置文件支持（`openclaw`、`work`、`remote` 等）。

此浏览器**不是**你的日常浏览器。它是用于智能体自动化和验证的安全、隔离界面。

## 快速开始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果出现 "Browser disabled"，请在配置中启用它（见下文）并重启 Gateway网关。

## 配置文件：`openclaw` 与 `chrome`

- `openclaw`：托管的隔离浏览器（无需扩展）。
- `chrome`：通过本地中继连接到你的**系统浏览器**的扩展中继（需要将 OpenClaw 扩展附加到标签页）。

如果你希望默认使用托管模式，请设置 `browser.defaultProfile: "openclaw"`。

## 配置

浏览器设置位于 `~/.openclaw/openclaw.json`。

```json5
{
  browser: {
    enabled: true, // 默认值：true
    // cdpUrl: "http://127.0.0.1:18792", // 旧版单配置文件覆盖
    remoteCdpTimeoutMs: 1500, // 远程 CDP HTTP 超时（毫秒）
    remoteCdpHandshakeTimeoutMs: 3000, // 远程 CDP WebSocket 握手超时（毫秒）
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

说明：

- 浏览器控制服务绑定到 local loopback 的端口，该端口由 `gateway.port` 派生（默认值：`18791`，即 gateway + 2）。中继使用下一个端口（`18792`）。
- 如果你覆盖了 Gateway网关端口（`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`），派生的浏览器端口会相应偏移以保持在同一"族"内。
- `cdpUrl` 未设置时默认为中继端口。
- `remoteCdpTimeoutMs` 适用于远程（非 local loopback）CDP 可达性检查。
- `remoteCdpHandshakeTimeoutMs` 适用于远程 CDP WebSocket 可达性检查。
- `attachOnly: true` 表示"永远不启动本地浏览器；仅在已运行时附加"。
- `color` + 每个配置文件的 `color` 为浏览器 UI 着色，以便你识别当前活动的配置文件。
- 默认配置文件为 `chrome`（扩展中继）。使用 `defaultProfile: "openclaw"` 切换到托管浏览器。
- 自动检测顺序：如果系统默认浏览器是基于 Chromium 的则使用它；否则按 Chrome → Brave → Edge → Chromium → Chrome Canary 顺序查找。
- 本地 `openclaw` 配置文件会自动分配 `cdpPort`/`cdpUrl`——仅在远程 CDP 时才需要手动设置。

## 使用 Brave（或其他基于 Chromium 的浏览器）

如果你的**系统默认**浏览器是基于 Chromium 的（Chrome/Brave/Edge 等），OpenClaw 会自动使用它。设置 `browser.executablePath` 来覆盖自动检测：

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

## 本地控制与远程控制

- **本地控制（默认）：** Gateway网关启动 local loopback 控制服务，并可启动本地浏览器。
- **远程控制（节点主机）：** 在拥有浏览器的机器上运行节点主机；Gateway网关将浏览器操作代理到该节点。
- **远程 CDP：** 设置 `browser.profiles.<name>.cdpUrl`（或 `browser.cdpUrl`）以附加到远程基于 Chromium 的浏览器。在这种情况下，OpenClaw 不会启动本地浏览器。

远程 CDP URL 可以包含认证信息：

- 查询令牌（例如 `https://provider.example?token=<token>`）
- HTTP Basic 认证（例如 `https://user:pass@provider.example`）

OpenClaw 在调用 `/json/*` 端点和连接 CDP WebSocket 时会保留认证信息。建议使用环境变量或密钥管理器存储令牌，而不是将其提交到配置文件中。

## 节点浏览器代理（零配置默认）

如果你在拥有浏览器的机器上运行了**节点主机**，OpenClaw 可以自动将浏览器工具调用路由到该节点，无需额外的浏览器配置。这是远程 Gateway网关的默认路径。

说明：

- 节点主机通过**代理命令**暴露其本地浏览器控制服务。
- 配置文件来自节点自身的 `browser.profiles` 配置（与本地相同）。
- 如果不需要可以禁用：
  - 在节点上：`nodeHost.browserProxy.enabled=false`
  - 在 Gateway网关上：`gateway.nodes.browser.mode="off"`

## Browserless（托管远程 CDP）

[Browserless](https://browserless.io) 是一个托管的 Chromium 服务，通过 HTTPS 暴露 CDP 端点。你可以将 OpenClaw 浏览器配置文件指向 Browserless 的区域端点，并使用 API 密钥进行认证。

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
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

说明：

- 将 `<BROWSERLESS_API_KEY>` 替换为你的真实 Browserless 令牌。
- 选择与你的 Browserless 账户匹配的区域端点（参见其文档）。

## 安全性

核心要点：

- 浏览器控制仅限 local loopback；访问通过 Gateway网关的认证或节点配对进行。
- 保持 Gateway网关和所有节点主机在私有网络上（Tailscale）；避免公开暴露。
- 将远程 CDP URL/令牌视为敏感信息；建议使用环境变量或密钥管理器。

远程 CDP 建议：

- 尽可能使用 HTTPS 端点和短期令牌。
- 避免将长期有效的令牌直接嵌入配置文件中。

## 配置文件（多浏览器）

OpenClaw 支持多个命名配置文件（路由配置）。配置文件可以是：

- **openclaw 托管**：专用的基于 Chromium 的浏览器实例，拥有独立的用户数据目录 + CDP 端口
- **远程**：显式的 CDP URL（在其他地方运行的基于 Chromium 的浏览器）
- **扩展中继**：通过本地中继 + Chrome 扩展连接你现有的 Chrome 标签页

默认值：

- 如果缺少 `openclaw` 配置文件，会自动创建。
- `chrome` 配置文件是内置的 Chrome 扩展中继（默认指向 `http://127.0.0.1:18792`）。
- 本地 CDP 端口默认从 **18800–18899** 分配。
- 删除配置文件会将其本地数据目录移至废纸篓。

所有控制端点接受 `?profile=<name>`；CLI 使用 `--browser-profile`。

## Chrome 扩展中继（使用你现有的 Chrome）

OpenClaw 也可以通过本地 CDP 中继 + Chrome 扩展驱动**你现有的 Chrome 标签页**（无需单独的 "openclaw" Chrome 实例）。

完整指南：[Chrome 扩展](/tools/chrome-extension)

流程：

- Gateway网关在本地运行（同一台机器）或节点主机在浏览器所在机器上运行。
- 本地**中继服务器**在 local loopback `cdpUrl` 上监听（默认：`http://127.0.0.1:18792`）。
- 你点击标签页上的 **OpenClaw Browser Relay** 扩展图标以附加（不会自动附加）。
- 智能体通过普通的 `browser` 工具控制该标签页，选择正确的配置文件即可。

如果 Gateway网关在其他地方运行，请在浏览器所在机器上运行节点主机，以便 Gateway网关可以代理浏览器操作。

### 沙箱会话

如果智能体会话处于沙箱中，`browser` 工具可能默认使用 `target="sandbox"`（沙箱浏览器）。
Chrome 扩展中继接管需要宿主浏览器控制权，因此：

- 以非沙箱模式运行会话，或者
- 设置 `agents.defaults.sandbox.browser.allowHostControl: true` 并在调用工具时使用 `target="host"`。

### 设置

1. 加载扩展（开发者/未打包模式）：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 启用"开发者模式"
- "加载已解压的扩展程序" → 选择 `openclaw browser extension path` 输出的目录
- 固定该扩展，然后在你想要控制的标签页上点击它（徽章显示 `ON`）。

2. 使用：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 智能体工具：`browser`，设置 `profile="chrome"`

可选：如果你想使用不同的名称或中继端口，创建自己的配置文件：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

说明：

- 此模式依赖 Playwright-on-CDP 进行大部分操作（截图/快照/操作）。
- 再次点击扩展图标即可断开。

## 隔离保证

- **专用用户数据目录**：绝不接触你的个人浏览器配置文件。
- **专用端口**：避免使用 `9222` 以防止与开发工作流冲突。
- **确定性标签页控制**：通过 `targetId` 定位标签页，而非"最后一个标签页"。

## 浏览器选择

在本地启动时，OpenClaw 按以下顺序选择第一个可用的：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

你可以通过 `browser.executablePath` 覆盖。

各平台：

- macOS：检查 `/Applications` 和 `~/Applications`。
- Linux：查找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：检查常见安装位置。

## 控制 API（可选）

仅用于本地集成，Gateway网关暴露一个小型 local loopback HTTP API：

- 状态/启动/停止：`GET /`、`POST /start`、`POST /stop`
- 标签页：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- 快照/截图：`GET /snapshot`、`POST /screenshot`
- 操作：`POST /navigate`、`POST /act`
- 钩子：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- 下载：`POST /download`、`POST /wait/download`
- 调试：`GET /console`、`POST /pdf`
- 调试：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- 网络：`POST /response/body`
- 状态：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 状态：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 设置：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

所有端点接受 `?profile=<name>`。

### Playwright 要求

部分功能（导航/操作/AI 快照/角色快照、元素截图、PDF）需要 Playwright。如果未安装 Playwright，这些端点会返回明确的 501 错误。ARIA 快照和基本截图在 openclaw 托管的 Chrome 上仍然可用。对于 Chrome 扩展中继驱动，ARIA 快照和截图需要 Playwright。

如果你看到 `Playwright is not available in this gateway build`，请安装完整的 Playwright 包（而非 `playwright-core`）并重启 Gateway网关，或者重新安装带浏览器支持的 OpenClaw。

## 工作原理（内部）

高层流程：

- 一个小型**控制服务器**接受 HTTP 请求。
- 它通过 **CDP** 连接到基于 Chromium 的浏览器（Chrome/Brave/Edge/Chromium）。
- 对于高级操作（点击/输入/快照/PDF），它在 CDP 之上使用 **Playwright**。
- 当缺少 Playwright 时，仅非 Playwright 操作可用。

这种设计使智能体保持在稳定、确定性的接口上，同时允许你切换本地/远程浏览器和配置文件。

## CLI 快速参考

所有命令接受 `--browser-profile <name>` 来指定配置文件。
所有命令也接受 `--json` 来获取机器可读的输出（稳定的负载格式）。

基础操作：

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
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

操作：

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
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
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
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

说明：

- `upload` 和 `dialog` 是**预设**调用；在触发选择器/对话框的点击/按键之前运行它们。
- `upload` 还可以通过 `--input-ref` 或 `--element` 直接设置文件输入。
- `snapshot`：
  - `--format ai`（安装 Playwright 时的默认值）：返回带有数字引用（`aria-ref="<n>"`）的 AI 快照。
  - `--format aria`：返回无障碍树（无引用；仅供检查）。
  - `--efficient`（或 `--mode efficient`）：紧凑角色快照预设（交互式 + 紧凑 + 深度 + 更低的 maxChars）。
  - 配置默认值（仅限工具/CLI）：设置 `browser.snapshotDefaults.mode: "efficient"` 以在调用者未传递模式时使用高效快照（参见 [Gateway网关配置](/gateway/configuration#browser-openclaw-managed-browser)）。
  - 角色快照选项（`--interactive`、`--compact`、`--depth`、`--selector`）强制使用基于角色的快照，引用格式如 `ref=e12`。
  - `--frame "<iframe 选择器>"` 将角色快照限定在 iframe 范围内（配合角色引用如 `e12` 使用）。
  - `--interactive` 输出扁平的、易于选取的交互式元素列表（最适合驱动操作）。
  - `--labels` 添加一个带有叠加引用标签的视口截图（输出 `MEDIA:<path>`）。
- `click`/`type` 等需要来自 `snapshot` 的 `ref`（数字 `12` 或角色引用 `e12`）。
  操作有意不支持 CSS 选择器。

## 快照和引用

OpenClaw 支持两种"快照"风格：

- **AI 快照（数字引用）**：`openclaw browser snapshot`（默认；`--format ai`）
  - 输出：包含数字引用的文本快照。
  - 操作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 内部通过 Playwright 的 `aria-ref` 解析引用。

- **角色快照（角色引用如 `e12`）**：`openclaw browser snapshot --interactive`（或 `--compact`、`--depth`、`--selector`、`--frame`）
  - 输出：带有 `[ref=e12]`（以及可选的 `[nth=1]`）的基于角色的列表/树。
  - 操作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 内部通过 `getByRole(...)` 解析引用（重复时加上 `nth()`）。
  - 添加 `--labels` 可包含带有叠加 `e12` 标签的视口截图。

引用行为：

- 引用在**页面导航后不稳定**；如果操作失败，重新运行 `snapshot` 并使用新的引用。
- 如果角色快照使用了 `--frame`，角色引用将限定在该 iframe 范围内，直到下一次角色快照。

## 等待增强功能

你可以等待的不仅仅是时间/文本：

- 等待 URL（Playwright 支持通配符）：
  - `openclaw browser wait --url "**/dash"`
- 等待加载状态：
  - `openclaw browser wait --load networkidle`
- 等待 JS 谓词：
  - `openclaw browser wait --fn "window.ready===true"`
- 等待选择器变为可见：
  - `openclaw browser wait "#main"`

这些可以组合使用：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 调试工作流

当操作失败时（例如 "not visible"、"strict mode violation"、"covered"）：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>` / `type <ref>`（在交互模式下优先使用角色引用）
3. 如果仍然失败：`openclaw browser highlight <ref>` 查看 Playwright 的定位目标
4. 如果页面行为异常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 深度调试：录制追踪：
   - `openclaw browser trace start`
   - 重现问题
   - `openclaw browser trace stop`（输出 `TRACE:<path>`）

## JSON 输出

`--json` 用于脚本和结构化工具。

示例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 格式的角色快照包含 `refs` 以及一个小型 `stats` 块（行数/字符数/引用数/交互元素数），以便工具可以推理负载大小和密度。

## 状态和环境调节

这些对于"让网站表现得像 X"的工作流很有用：

- Cookies：`cookies`、`cookies set`、`cookies clear`
- 存储：`storage local|session get|set|clear`
- 离线：`set offline on|off`
- 请求头：`set headers --json '{"X-Debug":"1"}'`（或 `--clear`）
- HTTP 基本认证：`set credentials user pass`（或 `--clear`）
- 地理位置：`set geo <lat> <lon> --origin "https://example.com"`（或 `--clear`）
- 媒体：`set media dark|light|no-preference|none`
- 时区 / 语言区域：`set timezone ...`、`set locale ...`
- 设备 / 视口：
  - `set device "iPhone 14"`（Playwright 设备预设）
  - `set viewport 1280 720`

## 安全与隐私

- openclaw 浏览器配置文件可能包含已登录的会话；请将其视为敏感数据。
- `browser act kind=evaluate` / `openclaw browser evaluate` 和 `wait --fn` 在页面上下文中执行任意 JavaScript。提示注入可能操纵此功能。如果不需要，请通过 `browser.evaluateEnabled=false` 禁用。
- 有关登录和反机器人注意事项（X/Twitter 等），请参阅[浏览器登录 + X/Twitter 发帖](/tools/browser-login)。
- 保持 Gateway网关/节点主机为私有（仅限 local loopback 或 tailnet）。
- 远程 CDP 端点功能强大；请通过隧道保护它们。

## 故障排除

有关 Linux 特定问题（特别是 snap 版 Chromium），请参阅[浏览器故障排除](/tools/browser-linux-troubleshooting)。

## 智能体工具 + 控制工作原理

智能体获得**一个工具**用于浏览器自动化：

- `browser` — 状态/启动/停止/标签页/打开/聚焦/关闭/快照/截图/导航/操作

映射方式：

- `browser snapshot` 返回稳定的 UI 树（AI 或 ARIA）。
- `browser act` 使用快照 `ref` ID 来点击/输入/拖拽/选择。
- `browser screenshot` 捕获像素（整页或元素）。
- `browser` 接受：
  - `profile` 来选择命名的浏览器配置文件（openclaw、chrome 或远程 CDP）。
  - `target`（`sandbox` | `host` | `node`）来选择浏览器所在位置。
  - 在沙箱会话中，`target: "host"` 需要 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 如果省略 `target`：沙箱会话默认为 `sandbox`，非沙箱会话默认为 `host`。
  - 如果连接了支持浏览器的节点，工具可能会自动路由到该节点，除非你指定 `target="host"` 或 `target="node"`。

这使智能体保持确定性，避免脆弱的选择器。
