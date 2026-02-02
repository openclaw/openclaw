---
read_when: 当你遇到 '沙箱隔离' 或看到工具/提权拒绝提示，想要了解需要修改的确切配置键时阅读。
status: active
summary: 工具被阻止的原因：沙箱运行时、工具允许/拒绝策略以及提权执行门控
title: 沙箱 vs 工具策略 vs 提权模式
x-i18n:
  generated_at: "2026-02-01T20:38:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 863ea5e6d137dfb61f12bd686b9557d6df1fd0c13ba5f15861bf72248bc975f1
  source_path: gateway/sandbox-vs-tool-policy-vs-elevated.md
  workflow: 14
---

# 沙箱 vs 工具策略 vs 提权模式

OpenClaw 有三个相关（但不同的）控制机制：

1. **沙箱** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) 决定**工具在哪里运行**（Docker 还是宿主机）。
2. **工具策略** (`tools.*`、`tools.sandbox.tools.*`、`agents.list[].tools.*`) 决定**哪些工具可用/被允许**。
3. **提权模式** (`tools.elevated.*`、`agents.list[].tools.elevated.*`) 是一个**仅限 exec 的逃逸通道**，用于在沙箱环境下在宿主机上运行。

## 快速调试

使用检查器查看 OpenClaw *实际*在做什么：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

它会输出：

- 生效的沙箱模式/范围/工作区访问权限
- 当前会话是否处于沙箱中（主会话 vs 非主会话）
- 生效的沙箱工具允许/拒绝策略（以及该策略来源于智能体级/全局级/默认级）
- 提权门控及修复路径

## 沙箱：工具在哪里运行

沙箱由 `agents.defaults.sandbox.mode` 控制：

- `"off"`：所有内容在宿主机上运行。
- `"non-main"`：仅非主会话被沙箱隔离（对群组/渠道来说常常出乎意料）。
- `"all"`：所有内容都被沙箱隔离。

完整的配置矩阵（范围、工作区挂载、镜像）请参阅[沙箱隔离](/gateway/sandboxing)。

### 绑定挂载（安全快速检查）

- `docker.binds` 会*穿透*沙箱文件系统：你挂载的任何内容都会以你设置的模式（`:ro` 或 `:rw`）在容器内可见。
- 如果省略模式，默认为读写；建议对源代码/密钥使用 `:ro`。
- `scope: "shared"` 会忽略每个智能体的绑定（仅全局绑定生效）。
- 绑定 `/var/run/docker.sock` 实际上会将宿主机控制权交给沙箱；请仅在有意为之时使用。
- 工作区访问（`workspaceAccess: "ro"`/`"rw"`）与绑定模式相互独立。

## 工具策略：哪些工具存在/可调用

两个层面需要关注：

- **工具配置文件**：`tools.profile` 和 `agents.list[].tools.profile`（基础允许列表）
- **提供商工具配置文件**：`tools.byProvider[provider].profile` 和 `agents.list[].tools.byProvider[provider].profile`
- **全局/每智能体工具策略**：`tools.allow`/`tools.deny` 和 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **提供商工具策略**：`tools.byProvider[provider].allow/deny` 和 `agents.list[].tools.byProvider[provider].allow/deny`
- **沙箱工具策略**（仅在沙箱隔离时适用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 和 `agents.list[].tools.sandbox.tools.*`

经验法则：

- `deny` 始终优先。
- 如果 `allow` 非空，其他所有工具都视为被阻止。
- 工具策略是硬性限制：`/exec` 无法覆盖被拒绝的 `exec` 工具。
- `/exec` 仅为授权发送者更改会话默认设置；它不会授予工具访问权限。
  提供商工具键接受 `provider`（如 `google-antigravity`）或 `provider/model`（如 `openai/gpt-5.2`）格式。

### 工具组（简写）

工具策略（全局、智能体、沙箱）支持 `group:*` 条目，可展开为多个工具：

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

可用的组：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有内置 OpenClaw 工具（不包括提供商插件）

## 提权模式：仅限 exec 的"在宿主机运行"

提权模式**不会**授予额外的工具；它仅影响 `exec`。

- 如果你处于沙箱中，`/elevated on`（或带 `elevated: true` 的 `exec`）会在宿主机上运行（审批可能仍然适用）。
- 使用 `/elevated full` 可跳过当前会话的 exec 审批。
- 如果你已经在直接运行模式下，提权实际上是无操作（仍然受门控限制）。
- 提权模式**不是**Skills 范围的，也**不会**覆盖工具允许/拒绝策略。
- `/exec` 与提权模式是分开的。它仅为授权发送者调整每会话的 exec 默认设置。

门控：

- 启用：`tools.elevated.enabled`（以及可选的 `agents.list[].tools.elevated.enabled`）
- 发送者允许列表：`tools.elevated.allowFrom.<provider>`（以及可选的 `agents.list[].tools.elevated.allowFrom.<provider>`）

参阅[提权模式](/tools/elevated)。

## 常见"沙箱隔离"修复方法

### "工具 X 被沙箱工具策略阻止"

修复键（任选其一）：

- 禁用沙箱：`agents.defaults.sandbox.mode=off`（或每智能体 `agents.list[].sandbox.mode=off`）
- 在沙箱内允许该工具：
  - 从 `tools.sandbox.tools.deny`（或每智能体 `agents.list[].tools.sandbox.tools.deny`）中移除它
  - 或将其添加到 `tools.sandbox.tools.allow`（或每智能体允许列表）

### "我以为这是主会话，为什么被沙箱隔离了？"

在 `"non-main"` 模式下，群组/渠道键*不是*主会话。请使用主会话键（通过 `sandbox explain` 查看）或将模式切换为 `"off"`。
