---
read_when:
  - 为 OpenClaw 设置 Zalo Personal
  - 调试 Zalo Personal 登录或消息流
summary: 通过 zca-cli（二维码登录）支持 Zalo 个人账号，功能与配置说明
title: Zalo Personal
x-i18n:
  generated_at: "2026-02-01T19:58:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2a249728d556e5cc52274627bdaf390fa10e815afa04f4497feb57a2a0cb9261
  source_path: channels/zalouser.md
  workflow: 14
---

# Zalo Personal（非官方）

状态：实验性。此集成通过 `zca-cli` 自动化操作一个**个人 Zalo 账号**。

> **警告：** 这是一个非官方集成，可能导致账号被暂停或封禁。使用风险自负。

## 需要安装插件

Zalo Personal 以插件形式提供，不包含在核心安装包中。

- 通过 CLI 安装：`openclaw plugins install @openclaw/zalouser`
- 或从源码检出安装：`openclaw plugins install ./extensions/zalouser`
- 详情：[插件](/plugin)

## 前置条件：zca-cli

Gateway网关所在机器必须在 `PATH` 中包含 `zca` 可执行文件。

- 验证：`zca --version`
- 如果缺失，请安装 zca-cli（参见 `extensions/zalouser/README.md` 或上游 zca-cli 文档）。

## 快速设置（入门）

1. 安装插件（见上文）。
2. 登录（二维码方式，在 Gateway网关机器上操作）：
   - `openclaw channels login --channel zalouser`
   - 使用 Zalo 手机应用扫描终端中的二维码。
3. 启用渠道：

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

4. 重启 Gateway网关（或完成新手引导）。
5. 私信访问默认为配对模式；首次联系时需批准配对码。

## 功能说明

- 使用 `zca listen` 接收入站消息。
- 使用 `zca msg ...` 发送回复（文本/媒体/链接）。
- 专为 Zalo Bot API 不可用时的"个人账号"使用场景设计。

## 命名说明

渠道 ID 为 `zalouser`，以明确表示这是对**个人 Zalo 用户账号**的自动化操作（非官方）。我们将 `zalo` 保留给未来可能的官方 Zalo API 集成。

## 查找 ID（通讯录）

使用通讯录 CLI 发现联系人/群组及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 限制

- 出站文本按约 2000 字符分块（Zalo 客户端限制）。
- 流式传输默认被禁用。

## 访问控制（私信）

`channels.zalouser.dmPolicy` 支持：`pairing | allowlist | open | disabled`（默认：`pairing`）。
`channels.zalouser.allowFrom` 接受用户 ID 或名称。向导在可用时通过 `zca friend find` 将名称解析为 ID。

通过以下方式批准：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群组访问（可选）

- 默认：`channels.zalouser.groupPolicy = "open"`（允许群组）。未设置时使用 `channels.defaults.groupPolicy` 覆盖默认值。
- 通过允许列表进行限制：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（键为群组 ID 或名称）
- 禁止所有群组：`channels.zalouser.groupPolicy = "disabled"`。
- 配置向导可以提示设置群组允许列表。
- 启动时，OpenClaw 会将允许列表中的群组/用户名称解析为 ID 并记录映射关系；未解析的条目保持原样。

示例：

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## 多账号

账号映射到 zca 配置文件。示例：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## 故障排除

**找不到 `zca`：**

- 安装 zca-cli 并确保 Gateway网关进程的 `PATH` 中包含该命令。

**登录状态无法保持：**

- `openclaw channels status --probe`
- 重新登录：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
