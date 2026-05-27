---
read_when:
  - 使用或修改 exec 工具
  - 调试 stdin 或 TTY 行为
summary: Exec 工具用法、stdin 模式和 TTY 支持
title: Exec 工具
x-i18n:
  generated_at: "2026-02-03T09:26:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3b32238dd8dce93d4f24100eaa521ce9f8485eff6d8498e2680ce9ed6045d25f
  source_path: tools/exec.md
  workflow: 15
---

# Exec 工具

在工作区中运行 shell 命令。通过 `process` 支持前台和后台执行。
如果 `process` 被禁用，`exec` 将同步运行并忽略 `yieldMs`/`background`。
后台会话按智能体隔离；`process` 只能看到同一智能体的会话。

## 参数

- `command`（必填）
- `workdir`（默认为当前工作目录）
- `env`（键值对覆盖）
- `yieldMs`（默认 10000）：延迟后自动转入后台
- `background`（布尔值）：立即转入后台
- `timeout`（秒，默认 1800）：超时后终止
- `pty`（布尔值）：在可用时使用伪终端运行（仅限 TTY 的 CLI、编程智能体、终端 UI）
- `host`（`sandbox | gateway | node`）：执行位置
- `security`（`deny | allowlist | full`）：`gateway`/`node` 的执行策略
- `ask`（`off | on-miss | always`）：`gateway`/`node` 的审批提示
- `node`（字符串）：`host=node` 时的节点 id/名称
- `elevated`（布尔值）：请求提升模式（gateway 主机）；仅当 elevated 解析为 `full` 时才强制 `security=full`

注意事项：

- `host` 默认为 `sandbox`。
- 当沙箱隔离关闭时，`elevated` 会被忽略（exec 已在主机上运行）。
- `gateway`/`node` 审批由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要已配对的节点（配套应用或无头节点主机）。
- 如果有多个可用节点，设置 `exec.node` 或 `tools.exec.node` 来选择一个。
- 在非 Windows 主机上，exec 会使用已设置的 `SHELL`；如果 `SHELL` 是 `fish`，它会优先从 `PATH` 中选择 `bash`（或 `sh`）以避免 fish 不兼容的脚本，如果两者都不存在则回退到 `SHELL`。
- 主机执行（`gateway`/`node`）会拒绝 `env.PATH` 和加载器覆盖（`LD_*`/`DYLD_*`），以防止二进制劫持或代码注入。
- 重要提示：沙箱隔离**默认关闭**。如果沙箱隔离关闭，`host=sandbox` 将直接在 Gateway 网关主机上运行（无容器）且**不需要审批**。如需审批，请使用 `host=gateway` 运行并配置 exec 审批（或启用沙箱隔离）。

## 配置

- `tools.exec.notifyOnExit`（默认：true）：为 true 时，后台 exec 会话在退出时会入队系统事件并请求心跳。
- `tools.exec.approvalRunningNoticeMs`（默认：10000）：当需要审批的 exec 运行时间超过此值时发出单次"运行中"通知（0 表示禁用）。
- `tools.exec.host`（默认：`sandbox`）
- `tools.exec.security`（默认：sandbox 为 `deny`，gateway + node 未设置时为 `allowlist`）
- `tools.exec.ask`（默认：`on-miss`）
- `tools.exec.node`（默认：未设置）
- `tools.exec.pathPrepend`：exec 运行时添加到 `PATH` 前面的目录列表。
- `tools.exec.safeBins`：仅限 stdin 的安全二进制文件，无需显式白名单条目即可运行。

示例：

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH 处理

- `host=gateway`：将你的登录 shell `PATH` 合并到 exec 环境中。主机执行时会拒绝 `env.PATH` 覆盖。守护进程本身仍使用最小 `PATH` 运行：
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：在容器内运行 `sh -lc`（登录 shell），因此 `/etc/profile` 可能会重置 `PATH`。OpenClaw 在 profile 加载后通过内部环境变量将 `env.PATH` 添加到前面（无 shell 插值）；`tools.exec.pathPrepend` 在此也适用。
- `host=node`：只有你传递的未被阻止的 env 覆盖会发送到节点。主机执行时会拒绝 `env.PATH` 覆盖。无头节点主机仅在 `PATH` 添加到节点主机 PATH 前面时才接受（不允许替换）。macOS 节点完全丢弃 `PATH` 覆盖。

按智能体绑定节点（在配置中使用智能体列表索引）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制 UI：Nodes 标签页包含一个小的"Exec 节点绑定"面板用于相同的设置。

## 会话覆盖（`/exec`）

使用 `/exec` 为 `host`、`security`、`ask` 和 `node` 设置**每会话**默认值。
不带参数发送 `/exec` 可显示当前值。

示例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授权模型

`/exec` 仅对**已授权发送者**（渠道白名单/配对加 `commands.useAccessGroups`）生效。
它仅更新**会话状态**，不写入配置。要彻底禁用 exec，请通过工具策略拒绝它（`tools.deny: ["exec"]` 或按智能体配置）。除非你显式设置 `security=full` 和 `ask=off`，否则主机审批仍然适用。

## Exec 审批（配套应用/节点主机）

沙箱隔离的智能体可以要求在 `exec` 于 Gateway 网关或节点主机上运行前进行逐请求审批。
参阅 [Exec 审批](/tools/exec-approvals) 了解策略、白名单和 UI 流程。

当需要审批时，exec 工具会立即返回 `status: "approval-pending"` 和审批 id。一旦被批准（或拒绝/超时），Gateway 网关会发出系统事件（`Exec finished` / `Exec denied`）。如果命令在 `tools.exec.approvalRunningNoticeMs` 之后仍在运行，会发出单次 `Exec running` 通知。

## 白名单 + 安全二进制文件

白名单执行仅匹配**解析后的二进制路径**（不匹配基本名称）。当 `security=allowlist` 时，仅当每个管道段都在白名单中或是安全二进制文件时，shell 命令才会自动允许。在白名单模式下，链式命令（`;`、`&&`、`||`）和重定向会被拒绝。

## 示例

前台：

```json
{ "tool": "exec", "command": "ls -la" }
```

后台 + 轮询：

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

发送按键（tmux 风格）：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

提交（仅发送 CR）：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

粘贴（默认带括号）：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（实验性）

`apply_patch` 是 `exec` 的子工具，用于结构化多文件编辑。
需显式启用：

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注意事项：

- 仅适用于 OpenAI/OpenAI Codex 模型。
- 工具策略仍然适用；`allow: ["exec"]` 隐式允许 `apply_patch`。
- 配置位于 `tools.exec.applyPatch` 下。
