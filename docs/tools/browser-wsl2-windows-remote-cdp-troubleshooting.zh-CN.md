---
summary: "分层排查 WSL2 网关 + Windows Chrome 远程 CDP 问题"
read_when:
  - 在 WSL2 中运行 OpenClaw 网关，而 Chrome 在 Windows 上运行
  - 在 WSL2 和 Windows 之间看到重叠的浏览器/控制 UI 错误
  - 在分离主机设置中决定使用主机本地 Chrome MCP 还是原始远程 CDP
title: "WSL2 + Windows + 远程 Chrome CDP 故障排除"
---

# WSL2 + Windows + 远程 Chrome CDP 故障排除

本指南涵盖常见的分离主机设置，其中：

- OpenClaw 网关在 WSL2 内部运行
- Chrome 在 Windows 上运行
- 浏览器控制必须跨越 WSL2/Windows 边界

它还涵盖了 [issue #39369](https://github.com/openclaw/openclaw/issues/39369) 中的分层失败模式：多个独立问题可能同时出现，这使得错误的层首先看起来被破坏。

## 首先选择正确的浏览器模式

你有两种有效的模式：

### 选项 1：从 WSL2 到 Windows 的原始远程 CDP

使用从 WSL2 指向 Windows Chrome CDP 端点的远程浏览器配置文件。

当以下情况时选择此选项：

- 网关保持在 WSL2 内部
- Chrome 在 Windows 上运行
- 你需要浏览器控制跨越 WSL2/Windows 边界

### 选项 2：主机本地 Chrome MCP

仅当网关本身与 Chrome 在同一主机上运行时，使用 `existing-session` / `user`。

当以下情况时选择此选项：

- OpenClaw 和 Chrome 在同一台机器上
- 你希望使用本地已登录的浏览器状态
- 你不需要跨主机浏览器传输
- 你不需要高级托管/仅原始 CDP 路由，如 `responsebody`、PDF
  导出、下载拦截或批量操作

对于 WSL2 网关 + Windows Chrome，优先选择原始远程 CDP。Chrome MCP 是主机本地的，不是 WSL2 到 Windows 的桥接。

## 工作架构

参考结构：

- WSL2 在 `127.0.0.1:18789` 上运行网关
- Windows 在正常浏览器中打开控制 UI，地址为 `http://127.0.0.1:18789/`
- Windows Chrome 在端口 `9222` 上公开 CDP 端点
- WSL2 可以访问该 Windows CDP 端点
- OpenClaw 将浏览器配置文件指向从 WSL2 可访问的地址

## 为什么此设置令人困惑

多个失败可能重叠：

- WSL2 无法访问 Windows CDP 端点
- 控制 UI 从未安全源打开
- `gateway.controlUi.allowedOrigins` 与页面源不匹配
- 缺少令牌或配对
- 浏览器配置文件指向错误的地址

因此，修复一层可能仍然会留下不同的可见错误。

## 控制 UI 的关键规则

当从 Windows 打开 UI 时，除非你有故意的 HTTPS 设置，否则请使用 Windows 本地主机。

使用：

`http://127.0.0.1:18789/`

不要为控制 UI 默认使用 LAN IP。LAN 或 tailnet 地址上的纯 HTTP 可能会触发与 CDP 本身无关的不安全源/设备认证行为。请参阅 [Control UI](/web/control-ui)。

## 分层验证

从上到下工作。不要跳过。

### 第 1 层：验证 Chrome 在 Windows 上提供 CDP

在 Windows 上启动启用远程调试的 Chrome：

```powershell
chrome.exe --remote-debugging-port=9222
```

从 Windows 首先验证 Chrome 本身：

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

如果这在 Windows 上失败，OpenClaw 还不是问题。

### 第 2 层：验证 WSL2 可以访问该 Windows 端点

从 WSL2，测试你计划在 `cdpUrl` 中使用的确切地址：

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

良好结果：

- `/json/version` 返回带有浏览器/协议版本元数据的 JSON
- `/json/list` 返回 JSON（如果没有打开页面，空数组是可以的）

如果这失败：

- Windows 尚未向 WSL2 公开端口
- 地址在 WSL2 侧是错误的
- 防火墙/端口转发/本地代理仍缺失

在触摸 OpenClaw 配置之前修复它。

### 第 3 层：配置正确的浏览器配置文件

对于原始远程 CDP，将 OpenClaw 指向从 WSL2 可访问的地址：

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

注意：

- 使用 WSL2 可访问的地址，而不是仅在 Windows 上有效的地址
- 对于外部管理的浏览器，保持 `attachOnly: true`
- `cdpUrl` 可以是 `http://`、`https://`、`ws://` 或 `wss://`
- 当你希望 OpenClaw 发现 `/json/version` 时使用 HTTP(S)
- 仅当浏览器提供者为你提供直接的 DevTools 套接字 URL 时使用 WS(S)
- 在期望 OpenClaw 成功之前，使用 `curl` 测试相同的 URL

### 第 4 层：单独验证控制 UI 层

从 Windows 打开 UI：

`http://127.0.0.1:18789/`

然后验证：

- 页面源与 `gateway.controlUi.allowedOrigins` 期望的匹配
- 令牌认证或配对配置正确
- 你不是在调试控制 UI 认证问题，好像它是浏览器问题一样

有用的页面：

- [Control UI](/web/control-ui)

### 第 5 层：验证端到端浏览器控制

从 WSL2：

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

良好结果：

- 标签在 Windows Chrome 中打开
- `openclaw browser tabs` 返回目标
- 后续操作（`snapshot`、`screenshot`、`navigate`）在同一配置文件中工作

## 常见误导性错误

将每条消息视为特定于层的线索：

- `control-ui-insecure-auth`
  - UI 源/安全上下文问题，不是 CDP 传输问题
- `token_missing`
  - 认证配置问题
- `pairing required`
  - 设备批准问题
- `Remote CDP for profile "remote" is not reachable`
  - WSL2 无法访问配置的 `cdpUrl`
- `Browser attachOnly is enabled and CDP websocket for profile "remote" is not reachable`
  - HTTP 端点响应，但 DevTools WebSocket 仍然无法打开
- 远程会话后的陈旧视口/暗模式/区域设置/离线覆盖
  - 运行 `openclaw browser stop --browser-profile remote`
  - 这会关闭活动控制会话并释放 Playwright/CDP 模拟状态，而无需重启网关或外部浏览器
- `gateway timeout after 1500ms`
  - 通常仍然是 CDP 可达性或缓慢/不可达的远程端点
- `No Chrome tabs found for profile="user"`
  - 选择了本地 Chrome MCP 配置文件，但没有可用的主机本地标签

## 快速分类清单

1. Windows：`curl http://127.0.0.1:9222/json/version` 是否工作？
2. WSL2：`curl http://WINDOWS_HOST_OR_IP:9222/json/version` 是否工作？
3. OpenClaw 配置：`browser.profiles.<name>.cdpUrl` 是否使用该确切的 WSL2 可访问地址？
4. 控制 UI：你是否打开 `http://127.0.0.1:18789/` 而不是 LAN IP？
5. 你是否尝试跨 WSL2 和 Windows 使用 `existing-session` 而不是原始远程 CDP？

## 实用结论

设置通常是可行的。困难的部分是浏览器传输、控制 UI 源安全性和令牌/配对可能各自独立失败，同时从用户侧看起来相似。

有疑问时：

- 首先在本地验证 Windows Chrome 端点
- 其次从 WSL2 验证相同的端点
- 然后再调试 OpenClaw 配置或控制 UI 认证
