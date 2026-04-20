---
summary: "通过外部 openclaw-weixin 插件设置 WeChat 频道"
read_when:
  - 您想将 OpenClaw 连接到 WeChat 或 Weixin
  - 您正在安装或排查 openclaw-weixin 频道插件
  - 您需要了解外部频道插件如何在网关旁边运行
title: "WeChat"
---

# WeChat

OpenClaw 通过腾讯的外部 `@tencent-weixin/openclaw-weixin` 频道插件连接到 WeChat。

状态：外部插件。支持直接聊天和媒体。当前插件功能元数据未声明支持群聊。

## 命名

- **WeChat** 是这些文档中的用户面向名称。
- **Weixin** 是腾讯包和插件 ID 使用的名称。
- `openclaw-weixin` 是 OpenClaw 频道 ID。
- `@tencent-weixin/openclaw-weixin` 是 npm 包。

在 CLI 命令和配置路径中使用 `openclaw-weixin`。

## 工作原理

WeChat 代码不位于 OpenClaw 核心仓库中。OpenClaw 提供通用频道插件契约，外部插件提供 WeChat 特定的运行时：

1. `openclaw plugins install` 安装 `@tencent-weixin/openclaw-weixin`。
2. 网关发现插件清单并加载插件入口点。
3. 插件注册频道 ID `openclaw-weixin`。
4. `openclaw channels login --channel openclaw-weixin` 启动 QR 登录。
5. 插件将账户凭证存储在 OpenClaw 状态目录下。
6. 当网关启动时，插件为每个配置的账户启动其 Weixin 监视器。
7. 入站 WeChat 消息通过频道契约标准化，路由到选定的 OpenClaw 代理，并通过插件出站路径发送回去。

这种分离很重要：OpenClaw 核心应该保持频道无关。WeChat 登录、腾讯 iLink API 调用、媒体上传/下载、上下文令牌和账户监控都由外部插件负责。

## 安装

快速安装：

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

手动安装：

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

安装后重启网关：

```bash
openclaw gateway restart
```

## 登录

在运行网关的同一台机器上运行 QR 登录：

```bash
openclaw channels login --channel openclaw-weixin
```

用手机上的 WeChat 扫描 QR 码并确认登录。插件在成功扫描后在本地保存账户令牌。

要添加另一个 WeChat 账户，再次运行相同的登录命令。对于多个账户，按账户、频道和发送者隔离直接消息会话：

```bash
openclaw config set session.dmScope per-account-channel-peer
```

## 访问控制

直接消息使用 OpenClaw 为频道插件提供的常规配对和允许列表模型。

批准新发送者：

```bash
openclaw pairing list openclaw-weixin
openclaw pairing approve openclaw-weixin <CODE>
```

有关完整的访问控制模型，请参见[配对](/channels/pairing)。

## 兼容性

插件在启动时检查主机 OpenClaw 版本。

| 插件版本 | OpenClaw 版本 | npm 标签 |
| ----------- | ----------------------- | -------- |
| `2.x` | `>=2026.3.22` | `latest` |
| `1.x` | `>=2026.1.0 <2026.3.22` | `legacy` |

如果插件报告您的 OpenClaw 版本太旧，请更新 OpenClaw 或安装旧版插件：

```bash
openclaw plugins install @tencent-weixin/openclaw-weixin@legacy
```

## 侧车进程

WeChat 插件可以在监控腾讯 iLink API 的同时在网关旁边运行辅助工作。在问题 #68451 中，该辅助路径暴露了 OpenClaw 通用陈旧网关清理中的一个错误：子进程可能尝试清理父网关进程，导致在 systemd 等进程管理器下的重启循环。

当前的 OpenClaw 启动清理排除了当前进程及其祖先，因此频道辅助程序不得杀死启动它的网关。此修复是通用的；它不是核心中的 WeChat 特定路径。

## 故障排除

检查安装和状态：

```bash
openclaw plugins list
openclaw channels status --probe
openclaw --version
```

如果频道显示已安装但未连接，请确认插件已启用并重启：

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw gateway restart
```

如果启用 WeChat 后网关反复重启，请更新 OpenClaw 和插件：

```bash
npm view @tencent-weixin/openclaw-weixin version
openclaw plugins install "@tencent-weixin/openclaw-weixin" --force
openclaw gateway restart
```

临时禁用：

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled false
openclaw gateway restart
```

## 相关文档

- 频道概述：[聊天频道](/channels)
- 配对：[配对](/channels/pairing)
- 频道路由：[频道路由](/channels/channel-routing)
- 插件架构：[插件架构](/plugins/architecture)
- 频道插件 SDK：[频道插件 SDK](/plugins/sdk-channel-plugins)
- 外部包：[@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)