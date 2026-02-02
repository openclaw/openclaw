---
read_when:
  - 使用 `openclaw browser` 并需要常见任务的示例
  - 想要通过节点主机控制运行在另一台机器上的浏览器
  - 想要使用 Chrome 扩展中继（通过工具栏按钮附加/分离）
summary: "`openclaw browser` 的 CLI 参考（配置文件、标签页、操作、扩展中继）"
title: browser
x-i18n:
  generated_at: "2026-02-01T19:58:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: af35adfd68726fd519c704d046451effd330458c2b8305e713137fb07b2571fd
  source_path: cli/browser.md
  workflow: 14
---

# `openclaw browser`

管理 OpenClaw 的浏览器控制服务器并执行浏览器操作（标签页、快照、截图、导航、点击、输入）。

相关内容：

- 浏览器工具 + API：[浏览器工具](/tools/browser)
- Chrome 扩展中继：[Chrome 扩展](/tools/chrome-extension)

## 常用标志

- `--url <gatewayWsUrl>`：Gateway网关 WebSocket URL（默认使用配置值）。
- `--token <token>`：Gateway网关令牌（如需要）。
- `--timeout <ms>`：请求超时时间（毫秒）。
- `--browser-profile <name>`：选择浏览器配置文件（默认使用配置值）。
- `--json`：机器可读输出（在支持的情况下）。

## 快速开始（本地）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 配置文件

配置文件是命名的浏览器路由配置。实际使用中：

- `openclaw`：启动/附加到一个专用的 OpenClaw 管理的 Chrome 实例（隔离的用户数据目录）。
- `chrome`：通过 Chrome 扩展中继控制你现有的 Chrome 标签页。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

使用特定配置文件：

```bash
openclaw browser --browser-profile work tabs
```

## 标签页

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## 快照 / 截图 / 操作

快照：

```bash
openclaw browser snapshot
```

截图：

```bash
openclaw browser screenshot
```

导航/点击/输入（基于引用的 UI 自动化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 扩展中继（通过工具栏按钮附加）

此模式允许智能体控制你手动附加的现有 Chrome 标签页（不会自动附加）。

将未打包的扩展安装到稳定路径：

```bash
openclaw browser extension install
openclaw browser extension path
```

然后在 Chrome 中 → `chrome://extensions` → 启用"开发者模式" → "加载已解压的扩展程序" → 选择打印出的文件夹。

完整指南：[Chrome 扩展](/tools/chrome-extension)

## 远程浏览器控制（节点主机代理）

如果 Gateway网关与浏览器运行在不同的机器上，请在安装了 Chrome/Brave/Edge/Chromium 的机器上运行**节点主机**。Gateway网关会将浏览器操作代理到该节点（无需单独的浏览器控制服务器）。

使用 `gateway.nodes.browser.mode` 控制自动路由，使用 `gateway.nodes.browser.node` 在多个节点连接时固定到特定节点。

安全性 + 远程设置：[浏览器工具](/tools/browser)、[远程访问](/gateway/remote)、[Tailscale](/gateway/tailscale)、[安全](/gateway/security)
