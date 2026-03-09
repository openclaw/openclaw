---
read_when:
  - 为 OpenClaw 设置 Zalo Personal
  - 调试 Zalo Personal 登录或消息流程
summary: 通过 zca-cli（QR 登录）支持 Zalo 个人账户、功能和配置
title: Zalo Personal
x-i18n:
  generated_at: "2026-02-03T07:44:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2a249728d556e5cc52274627bdaf390fa10e815afa04f4497feb57a2a0cb9261
  source_path: channels/zalouser.md
  workflow: 15
---

# Zalo Personal（非官方）

状态：实验性。此集成通过 `zca-cli` 自动化**个人 Zalo 账户**。

> **警告：**这是一个非官方集成，可能导致账户被暂停/封禁。使用风险自负。

## 需要插件

Zalo Personal 作为插件提供，不包含在核心安装中。

- 通过 CLI 安装：`openclaw plugins install @openclaw/zalouser`
- 或从源码检出安装：`openclaw plugins install ./extensions/zalouser`
- 详情：[插件](/tools/plugin)

## 前置条件：zca-cli

Gateway 网关机器必须在 `PATH` 中有可用的 `zca` 二进制文件。

- 验证：`zca --version`
- 如果缺失，请安装 zca-cli（参见 `extensions/zalouser/README.md` 或上游 zca-cli 文档）。

## 快速设置（新手）

1. 安装插件（见上文）。
2. 登录（QR，在 Gateway 网关机器上）：
   - `openclaw channels login --channel zalouser`
   - 用 Zalo 手机应用扫描终端中的二维码。
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

4. 重启 Gateway 网关（或完成新手引导）。
5. 私信访问默认为配对模式；首次联系时批准配对码。

## 这是什么

- 使用 `zca listen` 接收入站消息。
- 使用 `zca msg ...` 发送回复（文本/媒体/链接）。
- 专为"个人账户"使用场景设计，适用于 Zalo Bot API 不可用的情况。

## 命名

渠道 ID 为 `zalouser`，以明确表示这是自动化**个人 Zalo 用户账户**（非官方）。我们保留 `zalo` 用于未来可能的官方 Zalo API 集成。

## 查找 ID（目录）

使用目录 CLI 发现联系人/群组及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 限制

- 出站文本分块为约 2000 字符（Zalo 客户端限制）。
- 默认阻止流式传输。

## 访问控制（私信）

`channels.zalouser.dmPolicy` 支持：`pairing | allowlist | open | disabled`（默认：`pairing`）。
`channels.zalouser.allowFrom` 接受用户 ID 或名称。向导会在可用时通过 `zca friend find` 将名称解析为 ID。

通过以下方式批准：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群组访问（可选）

- 默认：`channels.zalouser.groupPolicy = "open"`（允许群组）。使用 `channels.defaults.groupPolicy` 在未设置时覆盖默认值。
- 通过以下方式限制为允许列表：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（键为群组 ID 或名称）
- 阻止所有群组：`channels.zalouser.groupPolicy = "disabled"`。
- 配置向导可以提示输入群组允许列表。
- 启动时，OpenClaw 将允许列表中的群组/用户名称解析为 ID 并记录映射；未解析的条目保持原样。

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

## 多账户

账户映射到 zca 配置文件。示例：

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

- 安装 zca-cli 并确保它在 Gateway 网关进程的 `PATH` 中。

**登录不保持：**

- `openclaw channels status --probe`
- 重新登录：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
