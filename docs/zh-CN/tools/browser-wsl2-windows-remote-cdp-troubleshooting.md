---
summary: "排查 WSL2 Gateway + Windows Chrome 远程 CDP 分层问题"
read_when:
  - 在 WSL2 中运行 OpenClaw Gateway 而 Chrome 在 Windows 上
  - 在 WSL2 和 Windows 之间看到重叠的浏览器/控制 UI 错误
  - 在分离主机设置中在主机本地 Chrome MCP 和原始远程 CDP 之间选择
title: "WSL2 + Windows + 远程 Chrome CDP 故障排除"
---

# WSL2 + Windows + 远程 Chrome CDP 故障排除

本指南涵盖常见的分离主机设置：

- OpenClaw Gateway 在 WSL2 内部运行
- Chrome 在 Windows 上运行
- 浏览器控制必须跨越 WSL2/Windows 边界

它还涵盖了来自分层故障模式的问题：几个独立的问题可能同时出现，这使得错误的层看起来首先损坏。

## 首先选择正确的浏览器模式

您有两种有效模式：

### 选项 1：从 WSL2 到 Windows 的原始远程 CDP

使用从 WSL2 指向 Windows Chrome CDP 端点的远程浏览器配置文件。

选择此选项当：

- Gateway 保持在 WSL2 内部
- Chrome 在 Windows 上运行
- 浏览器控制必须跨越 WSL2/Windows 边界

### 选项 2：主机本地 Chrome MCP

当 Gateway 与 Chrome 在同一主机上运行时，使用 `existing-session` / `user`。

选择此选项当：

- OpenClaw 和 Chrome 在同一台机器上
- 您需要本地登录的浏览器状态
- 您不需要跨主机浏览器传输

对于 WSL2 Gateway + Windows Chrome，首选原始远程 CDP。Chrome MCP 是主机本地的，不是 WSL2 到 Windows 的桥接。

## 工作架构

参考形状：

- WSL2 在 `127.0.0.1:18789` 上运行 Gateway
- Windows 在正常浏览器中打开 Control UI：`http://127.0.0.1:18789/`
- Windows Chrome 在端口 `9222` 上暴露 CDP 端点
- WSL2 可以到达该 Windows CDP 端点
- OpenClaw 将浏览器配置文件指向从 WSL2 可达的地址

## 为什么这个设置令人困惑

几个故障可能重叠：

- WSL2 无法到达 Windows CDP 端点
- Control UI 从非安全源打开
- `gateway.controlUi.allowedOrigins` 与页面源不匹配
- 令牌或配对缺失
- 浏览器配置文件指向错误地址

因此，修复一层可能仍然留下不同的可见错误。

## Control UI 的关键规则

当 UI 从 Windows 打开时，除非您有故意的 HTTPS 设置，否则使用 Windows localhost。

使用：

`http://127.0.0.1:18789/`

不要将 LAN IP 作为 Control UI 的默认值。普通 HTTP 在 LAN 或 tailnet 地址上可能触发与 CDP 本身无关的不安全源/设备认证行为。

## 分层验证

自上而下工作。不要跳过。

### 第 1 层：验证 Chrome 正在 Windows 上提供 CDP

在 Windows 上启动带有远程调试功能的 Chrome：

```powershell
chrome.exe --remote-debugging-port=9222
```

从 Windows，首先验证 Chrome 本身：

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

如果这在 Windows 上失败，OpenClaw 还不是问题。

### 第 2 层：验证 WSL2 可以到达该 Windows 端点

从 WSL2，测试您计划在 `cdpUrl` 中使用的确切地址：

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

好的结果：

- `/json/version` 返回带有 Browser / Protocol-Version 元数据的 JSON
- `/json/list` 返回 JSON（如果没有打开的页面，空数组也可以）

如果这失败：

- Windows 尚未向 WSL2 暴露端口
- 地址对于 WSL2 端是错误的
- 防火墙/端口转发/本地代理仍然缺失

在触及 OpenClaw 配置之前修复。

### 第 3 层：配置正确的浏览器配置文件

对于原始远程 CDP，将 OpenClaw 指向从 WSL2 可达的地址：

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: "http://WINDOWS_HOST_OR_IP:9222",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

### 第 4 层：单独验证 Control UI 层

从 Windows 打开 UI：

`http://127.0.0.1:18789/`

然后验证：

- 页面源与 `gateway.controlUi.allowedOrigins` 期望的匹配
- 令牌认证或配对配置正确
- 您没有将 Control UI 认证问题作为浏览器问题调试

### 第 5 层：验证端到端浏览器控制

从 WSL2：

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

好的结果：

- 标签页在 Windows Chrome 中打开
- `openclaw browser tabs` 返回目标
- 后续操作（`snapshot`、`screenshot`、`navigate`）从同一配置文件工作

## 常见误导性错误

将每个消息视为特定于层的线索：

- `control-ui-insecure-auth` — UI 源/安全上下文问题，不是 CDP 传输问题
- `token_missing` — 认证配置问题
- `pairing required` — 设备批准问题
- `Remote CDP for profile "remote" is not reachable` — WSL2 无法到达配置的 `cdpUrl`
- `gateway timeout after 1500ms` — 通常仍然是 CDP 可达性或慢/不可达的远程端点
- `No Chrome tabs found for profile="user"` — 在没有主机本地标签可用的地方选择了本地 Chrome MCP 配置文件

## 快速分类检查清单

1. Windows：`curl http://127.0.0.1:9222/json/version` 工作吗？
2. WSL2：`curl http://WINDOWS_HOST_OR_IP:9222/json/version` 工作吗？
3. OpenClaw 配置：`browser.profiles.<name>.cdpUrl` 使用那个从 WSL2 可达的确切地址吗？
4. Control UI：您打开的是 `http://127.0.0.1:18789/` 而不是 LAN IP 吗？
5. 您是在跨 WSL2 和 Windows 尝试使用 `existing-session` 而不是原始远程 CDP 吗？