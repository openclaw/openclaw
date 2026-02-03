---
read_when:
  - 使用或修改 exec 工具时
  - 调试标准输入或 TTY 行为时
summary: Exec 工具用法、标准输入模式与 TTY 支持
title: Exec 工具
x-i18n:
  generated_at: "2026-02-01T21:42:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0d515b6039b43f7923b8cc6cd63717e3d029128e523b06c78003ca8077c20a21
  source_path: tools/exec.md
  workflow: 15
---

# Exec 工具

在工作区中运行 shell 命令。通过 `process` 支持前台和后台执行。
如果 `process` 被禁用，`exec` 将同步运行并忽略 `yieldMs`/`background`。
后台会话按智能体隔离；`process` 只能查看同一智能体的会话。

## 参数

- `command`（必填）
- `workdir`（默认为当前工作目录）
- `env`（键/值覆盖）
- `yieldMs`（默认 10000）：延迟后自动转为后台运行
- `background`（布尔值）：立即转为后台运行
- `timeout`（秒，默认 1800）：超时后终止
- `pty`（布尔值）：在可用时使用伪终端运行（仅 TTY 的 CLI、编程智能体、终端 UI）
- `host`（`sandbox | gateway | node`）：执行位置
- `security`（`deny | allowlist | full`）：`gateway`/`node` 的执行策略模式
- `ask`（`off | on-miss | always`）：`gateway`/`node` 的审批提示
- `node`（字符串）：`host=node` 时的节点 ID/名称
- `elevated`（布尔值）：请求提权模式（gateway 主机）；仅当提权解析为 `full` 时才强制 `security=full`

说明：

- `host` 默认为 `sandbox`。
- 当沙箱关闭时，`elevated` 被忽略（exec 已直接在主机上运行）。
- `gateway`/`node` 的审批由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要已配对的节点（伴侣应用或无头节点主机）。
- 如果有多个节点可用，请设置 `exec.node` 或 `tools.exec.node` 来选择一个。
- 在非 Windows 主机上，exec 在设置了 `SHELL` 时使用该 shell；如果 `SHELL` 是 `fish`，它会优先从 `PATH` 中选择 `bash`（或 `sh`）以避免 fish 不兼容的脚本，如果两者都不存在则回退到 `SHELL`。
- 重要：沙箱**默认关闭**。如果沙箱关闭，`host=sandbox` 将直接在 Gateway网关主机上运行（无容器）且**不需要审批**。要启用审批，请使用 `host=gateway` 并配置 exec 审批（或启用沙箱）。

## 配置

- `tools.exec.notifyOnExit`（默认：true）：为 true 时，后台 exec 会话在退出时会排入系统事件并请求心跳。
- `tools.exec.approvalRunningNoticeMs`（默认：10000）：当需要审批的 exec 运行超过此时间时，发出一条"运行中"通知（设为 0 禁用）。
- `tools.exec.host`（默认：`sandbox`）
- `tools.exec.security`（默认：sandbox 为 `deny`，未设置时 gateway + node 为 `allowlist`）
- `tools.exec.ask`（默认：`on-miss`）
- `tools.exec.node`（默认：未设置）
- `tools.exec.pathPrepend`：exec 运行时要添加到 `PATH` 前面的目录列表。
- `tools.exec.safeBins`：仅通过标准输入的安全二进制文件，无需显式添加到允许列表即可运行。

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

- `host=gateway`：将你的登录 shell `PATH` 合并到 exec 环境中（除非 exec 调用已设置 `env.PATH`）。守护进程本身仍使用最小 `PATH` 运行：
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：在容器内运行 `sh -lc`（登录 shell），因此 `/etc/profile` 可能会重置 `PATH`。OpenClaw 在 profile 加载后通过内部环境变量添加 `env.PATH`（无 shell 插值）；`tools.exec.pathPrepend` 在此同样适用。
- `host=node`：仅发送你传递的 env 覆盖到节点。`tools.exec.pathPrepend` 仅在 exec 调用已设置 `env.PATH` 时适用。无头节点主机仅在 `PATH` 为节点主机 PATH 前缀时接受 `PATH` 覆盖（不支持替换）。macOS 节点完全忽略 `PATH` 覆盖。

按智能体绑定节点（在配置中使用智能体列表索引）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制界面：节点选项卡包含一个"Exec 节点绑定"面板，用于相同的设置。

## 会话覆盖（`/exec`）

使用 `/exec` 设置 `host`、`security`、`ask` 和 `node` 的**按会话**默认值。
不带参数发送 `/exec` 可查看当前值。

示例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授权模型

`/exec` 仅对**已授权的发送者**生效（渠道允许列表/配对加 `commands.useAccessGroups`）。
它仅更新**会话状态**，不会写入配置。要彻底禁用 exec，请通过工具策略拒绝它（`tools.deny: ["exec"]` 或按智能体设置）。除非你显式设置 `security=full` 和 `ask=off`，否则主机审批仍然适用。

## Exec 审批（伴侣应用 / 节点主机）

沙箱隔离的智能体可以要求在 `exec` 于 Gateway网关或节点主机上运行前进行逐次审批。
请参阅 [Exec 审批](/tools/exec-approvals) 了解策略、允许列表和 UI 流程。

当需要审批时，exec 工具会立即返回 `status: "approval-pending"` 和一个审批 ID。一旦被批准（或拒绝/超时），Gateway网关会发出系统事件（`Exec finished` / `Exec denied`）。如果命令在 `tools.exec.approvalRunningNoticeMs` 之后仍在运行，会发出一条 `Exec running` 通知。

## 允许列表与安全二进制文件

允许列表执行仅匹配**已解析的二进制文件路径**（不匹配基本名称）。当 `security=allowlist` 时，shell 命令仅在每个管道段都在允许列表中或属于安全二进制文件时才会自动放行。在允许列表模式下，链式操作（`;`、`&&`、`||`）和重定向会被拒绝。

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

提交（仅发送回车）：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

粘贴（默认带括号标记）：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（实验性）

`apply_patch` 是 `exec` 的子工具，用于结构化的多文件编辑。
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

说明：

- 仅适用于 OpenAI/OpenAI Codex 模型。
- 工具策略仍然适用；`allow: ["exec"]` 隐式允许 `apply_patch`。
- 配置位于 `tools.exec.applyPatch` 下。
