---
read_when:
  - 你希望智能体驱动现有的 Chrome 标签页（工具栏按钮）
  - 你需要通过 Tailscale 实现远程 Gateway 网关 + 本地浏览器自动化
  - 你想了解浏览器接管的安全影响
summary: Chrome 扩展：让 OpenClaw 驱动你现有的 Chrome 标签页
title: Chrome 扩展
x-i18n:
  generated_at: "2026-02-03T07:55:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3b77bdad7d3dab6adb76ff25b144412d6b54b915993b1c1f057f36dea149938b
  source_path: tools/chrome-extension.md
  workflow: 15
---

# Chrome 扩展（浏览器中继）

OpenClaw Chrome 扩展让智能体控制你**现有的 Chrome 标签页**（你的正常 Chrome 窗口），而不是启动一个单独的 openclaw 管理的 Chrome 配置文件。

附加/分离通过一个**单独的 Chrome 工具栏按钮**实现。

## 它是什么（概念）

有三个部分：

- **浏览器控制服务**（Gateway 网关或节点）：智能体/工具调用的 API（通过 Gateway 网关）
- **本地中继服务器**（loopback CDP）：在控制服务器和扩展之间桥接（默认 `http://127.0.0.1:18792`）
- **Chrome MV3 扩展**：使用 `chrome.debugger` 附加到活动标签页，并将 CDP 消息传送到中继

然后 OpenClaw 通过正常的 `browser` 工具界面控制附加的标签页（选择正确的配置文件）。

## 安装/加载（未打包）

1. 将扩展安装到稳定的本地路径：

```bash
openclaw browser extension install
```

2. 打印已安装扩展的目录路径：

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- 启用"开发者模式"
- "加载已解压的扩展程序" → 选择上面打印的目录

4. 固定扩展。

## 更新（无构建步骤）

扩展作为静态文件包含在 OpenClaw 发布版（npm 包）中。没有单独的"构建"步骤。

升级 OpenClaw 后：

- 重新运行 `openclaw browser extension install` 以刷新 OpenClaw 状态目录下的已安装文件。
- Chrome → `chrome://extensions` → 点击扩展上的"重新加载"。

## 使用它（无需额外配置）

OpenClaw 附带一个名为 `chrome` 的内置浏览器配置文件，它指向默认端口上的扩展中继。

使用它：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 智能体工具：`browser` 配合 `profile="chrome"`

如果你想要不同的名称或不同的中继端口，创建你自己的配置文件：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## 附加/分离（工具栏按钮）

- 打开你希望 OpenClaw 控制的标签页。
- 点击扩展图标。
  - 附加时徽章显示 `ON`。
- 再次点击以分离。

## 它控制哪个标签页？

- 它**不会**自动控制"你正在查看的任何标签页"。
- 它**仅**控制你通过点击工具栏按钮**明确附加的标签页**。
- 要切换：打开另一个标签页并在那里点击扩展图标。

## 徽章 + 常见错误

- `ON`：已附加；OpenClaw 可以驱动该标签页。
- `…`：正在连接到本地中继。
- `!`：中继不可达（最常见：浏览器中继服务器未在此机器上运行）。

如果你看到 `!`：

- 确保 Gateway 网关在本地运行（默认设置），或者如果 Gateway 网关在其他地方运行，在此机器上运行一个节点主机。
- 打开扩展选项页面；它会显示中继是否可达。

## 远程 Gateway 网关（使用节点主机）

### 本地 Gateway 网关（与 Chrome 在同一台机器上）——通常**无需额外步骤**

如果 Gateway 网关运行在与 Chrome 相同的机器上，它会在 loopback 上启动浏览器控制服务并自动启动中继服务器。扩展与本地中继通信；CLI/工具调用发送到 Gateway 网关。

### 远程 Gateway 网关（Gateway 网关运行在其他地方）——**运行节点主机**

如果你的 Gateway 网关运行在另一台机器上，在运行 Chrome 的机器上启动一个节点主机。Gateway 网关将把浏览器操作代理到该节点；扩展 + 中继保持在浏览器机器本地。

如果连接了多个节点，使用 `gateway.nodes.browser.node` 固定一个或设置 `gateway.nodes.browser.mode`。

## 沙箱隔离（工具容器）

如果你的智能体会话在沙箱中（`agents.defaults.sandbox.mode != "off"`），`browser` 工具可能受到限制：

- 默认情况下，沙箱隔离的会话通常指向**沙箱浏览器**（`target="sandbox"`），而不是你的主机 Chrome。
- Chrome 扩展中继接管需要控制**主机**浏览器控制服务器。

选项：

- 最简单：从**非沙箱隔离**的会话/智能体使用扩展。
- 或者为沙箱隔离的会话允许主机浏览器控制：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

然后确保工具未被工具策略拒绝，并（如果需要）以 `target="host"` 调用 `browser`。

调试：`openclaw sandbox explain`

## 远程访问提示

- 将 Gateway 网关和节点主机保持在同一个 tailnet 上；避免将中继端口暴露到 LAN 或公共 Internet。
- 有意配对节点；如果你不想要远程控制，禁用浏览器代理路由（`gateway.nodes.browser.mode="off"`）。

## "extension path"的工作原理

`openclaw browser extension path` 打印包含扩展文件的**已安装**磁盘目录。

CLI 有意**不**打印 `node_modules` 路径。始终先运行 `openclaw browser extension install` 将扩展复制到 OpenClaw 状态目录下的稳定位置。

如果你移动或删除该安装目录，Chrome 将把扩展标记为损坏，直到你从有效路径重新加载它。

## 安全影响（请阅读此内容）

这是强大且有风险的。将其视为给模型"在你的浏览器上动手"。

- 扩展使用 Chrome 的调试器 API（`chrome.debugger`）。附加时，模型可以：
  - 在该标签页中点击/输入/导航
  - 读取页面内容
  - 访问标签页已登录会话可以访问的任何内容
- **这不像**专用的 openclaw 管理配置文件那样隔离。
  - 如果你附加到你的日常使用配置文件/标签页，你就是在授予对该账户状态的访问权限。

建议：

- 对于扩展中继使用，优先使用专用的 Chrome 配置文件（与你的个人浏览分开）。
- 将 Gateway 网关和任何节点主机保持在仅限 tailnet；依赖 Gateway 网关身份验证 + 节点配对。
- 避免通过 LAN（`0.0.0.0`）暴露中继端口，避免使用 Funnel（公开）。
- 中继阻止非扩展来源，并要求 CDP 客户端提供内部身份验证令牌。

相关：

- 浏览器工具概述：[浏览器](/tools/browser)
- 安全审计：[安全](/gateway/security)
- Tailscale 设置：[Tailscale](/gateway/tailscale)
