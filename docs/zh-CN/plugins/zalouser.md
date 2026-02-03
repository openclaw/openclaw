---
read_when:
  - 你想在 OpenClaw 中使用 Zalo Personal（非官方）支持
  - 你正在配置或开发 zalouser 插件
summary: Zalo Personal 插件：通过 zca-cli 实现二维码登录和消息收发（插件安装 + 渠道配置 + CLI + 工具）
title: Zalo Personal 插件
x-i18n:
  generated_at: "2026-02-01T21:34:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b29b788b023cd50720e24fe6719f02e9f86c8bca9c73b3638fb53c2316718672
  source_path: plugins/zalouser.md
  workflow: 15
---

# Zalo Personal（插件）

通过插件为 OpenClaw 提供 Zalo Personal 支持，使用 `zca-cli` 自动化操作普通 Zalo 用户账号。

> **警告：**非官方自动化可能导致账号被暂停或封禁。使用风险自负。

## 命名

渠道 id 为 `zalouser`，以明确表示这是对**个人 Zalo 用户账号**的自动化操作（非官方）。我们将 `zalo` 保留给未来可能的官方 Zalo API 集成。

## 运行位置

此插件运行在 **Gateway网关进程内部**。

如果你使用远程 Gateway网关，请在**运行 Gateway网关的机器上**安装和配置此插件，然后重启 Gateway网关。

## 安装

### 方式 A：从 npm 安装

```bash
openclaw plugins install @openclaw/zalouser
```

安装后重启 Gateway网关。

### 方式 B：从本地文件夹安装（开发模式）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

安装后重启 Gateway网关。

## 前提条件：zca-cli

Gateway网关所在机器必须将 `zca` 添加到 `PATH` 中：

```bash
zca --version
```

## 配置

渠道配置位于 `channels.zalouser` 下（而非 `plugins.entries.*`）：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## 智能体工具

工具名称：`zalouser`

操作：`send`、`image`、`link`、`friends`、`groups`、`me`、`status`
