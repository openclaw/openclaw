---
read_when: You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change.
status: active
summary: 工具被阻止的原因：沙箱运行时、工具允许/拒绝策略和提权 exec 限制
title: 沙箱 vs 工具策略 vs 提权
x-i18n:
  generated_at: "2026-02-03T07:48:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 863ea5e6d137dfb61f12bd686b9557d6df1fd0c13ba5f15861bf72248bc975f1
  source_path: gateway/sandbox-vs-tool-policy-vs-elevated.md
  workflow: 15
---

# 沙箱 vs 工具策略 vs 提权

OpenClaw 有三个相关（但不同）的控制：

1. **沙箱**（`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`）决定**工具在哪里运行**（Docker vs 主机）。
2. **工具策略**（`tools.*`、`tools.sandbox.tools.*`、`agents.list[].tools.*`）决定**哪些工具可用/允许**。
3. **提权**（`tools.elevated.*`、`agents.list[].tools.elevated.*`）是一个**仅限 exec 的逃逸通道**，允许在沙箱隔离时在主机上运行。

## 快速调试

使用检查器查看 OpenClaw *实际*在做什么：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

它会打印：

- 生效的沙箱模式/范围/工作区访问
- 会话当前是否被沙箱隔离（主 vs 非主）
- 生效的沙箱工具允许/拒绝（以及它来自智能体/全局/默认哪里）
- 提权限制和修复键路径

## 沙箱：工具在哪里运行

沙箱隔离由 `agents.defaults.sandbox.mode` 控制：

- `"off"`：所有内容在主机上运行。
- `"non-main"`：仅非主会话被沙箱隔离（群组/渠道的常见"意外"）。
- `"all"`：所有内容都被沙箱隔离。

参见[沙箱隔离](/gateway/sandboxing)了解完整矩阵（范围、工作区挂载、镜像）。

### 绑定挂载（安全快速检查）

- `docker.binds` *穿透*沙箱文件系统：你挂载的任何内容在容器内以你设置的模式（`:ro` 或 `:rw`）可见。
- 如果省略模式，默认为读写；对于源代码/密钥优先使用 `:ro`。
- `scope: "shared"` 忽略每个智能体的绑定（仅全局绑定适用）。
- 绑定 `/var/run/docker.sock` 实际上将主机控制权交给沙箱；只有在有意为之时才这样做。
- 工作区访问（`workspaceAccess: "ro"`/`"rw"`）独立于绑定模式。

## 工具策略：哪些工具存在/可调用

两个层次很重要：

- **工具配置文件**：`tools.profile` 和 `agents.list[].tools.profile`（基础允许列表）
- **提供商工具配置文件**：`tools.byProvider[provider].profile` 和 `agents.list[].tools.byProvider[provider].profile`
- **全局/每个智能体工具策略**：`tools.allow`/`tools.deny` 和 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **提供商工具策略**：`tools.byProvider[provider].allow/deny` 和 `agents.list[].tools.byProvider[provider].allow/deny`
- **沙箱工具策略**（仅在沙箱隔离时适用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 和 `agents.list[].tools.sandbox.tools.*`

经验法则：

- `deny` 始终优先。
- 如果 `allow` 非空，其他所有内容都被视为阻止。
- 工具策略是硬性停止：`/exec` 无法覆盖被拒绝的 `exec` 工具。
- `/exec` 仅为授权发送者更改会话默认值；它不授予工具访问权限。
  提供商工具键接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具组（简写）

工具策略（全局、智能体、沙箱）支持 `group:*` 条目，它们会展开为多个工具：

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

## 提权：仅限 exec 的"在主机上运行"

提权**不会**授予额外工具；它仅影响 `exec`。

- 如果你被沙箱隔离，`/elevated on`（或带 `elevated: true` 的 `exec`）在主机上运行（审批可能仍然适用）。
- 使用 `/elevated full` 跳过该会话的 exec 审批。
- 如果你已经直接运行，提权实际上是空操作（仍然受限）。
- 提权**不是** skill 范围的，**不会**覆盖工具允许/拒绝。
- `/exec` 与提权是分开的。它仅为授权发送者调整每个会话的 exec 默认值。

限制：

- 启用：`tools.elevated.enabled`（以及可选的 `agents.list[].tools.elevated.enabled`）
- 发送者允许列表：`tools.elevated.allowFrom.<provider>`（以及可选的 `agents.list[].tools.elevated.allowFrom.<provider>`）

参见[提权模式](/tools/elevated)。

## 常见"沙箱困境"修复

### "工具 X 被沙箱工具策略阻止"

修复键（选一个）：

- 禁用沙箱：`agents.defaults.sandbox.mode=off`（或每个智能体 `agents.list[].sandbox.mode=off`）
- 在沙箱内允许该工具：
  - 从 `tools.sandbox.tools.deny` 中移除它（或每个智能体 `agents.list[].tools.sandbox.tools.deny`）
  - 或将它添加到 `tools.sandbox.tools.allow`（或每个智能体 allow）

### "我以为这是主会话，为什么被沙箱隔离了？"

在 `"non-main"` 模式下，群组/渠道键*不是*主会话。使用主会话键（由 `sandbox explain` 显示）或将模式切换为 `"off"`。
