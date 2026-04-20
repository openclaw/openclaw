---
summary: "Exec 工具用法、标准输入模式和 TTY 支持"
read_when:
  - 使用或修改 exec 工具
  - 调试标准输入或 TTY 行为
title: "执行工具"
---

# 执行工具

在工作区中运行 shell 命令。通过 `process` 支持前台 + 后台执行。
如果 `process` 被禁止，`exec` 会同步运行并忽略 `yieldMs`/`background`。
后台会话按代理作用域；`process` 只看到来自同一代理的会话。

## 参数

- `command`（必需）
- `workdir`（默认为当前工作目录）
- `env`（键/值覆盖）
- `yieldMs`（默认 10000）：延迟后自动后台化
- `background`（布尔值）：立即后台化
- `timeout`（秒，默认 1800）：到期后终止
- `pty`（布尔值）：在可用时在伪终端中运行（仅 TTY 的 CLI、编码代理、终端 UI）
- `host`（`auto | sandbox | gateway | node`）：执行位置
- `security`（`deny | allowlist | full`）：`gateway`/`node` 的强制执行模式
- `ask`（`off | on-miss | always`）：`gateway`/`node` 的批准提示
- `node`（字符串）：`host=node` 的节点 ID/名称
- `elevated`（布尔值）：请求提升模式（逃离沙盒到配置的主机路径）；仅当 elevated 解析为 `full` 时才强制 `security=full`

注意：

- `host` 默认为 `auto`：当会话的沙盒运行时活跃时为沙盒，否则为网关。
- `auto` 是默认路由策略，不是通配符。从 `auto` 允许每个调用的 `host=node`；仅当沙盒运行时不活跃时，才允许每个调用的 `host=gateway`。
- 没有额外配置时，`host=auto` 仍然"正常工作"：无沙盒意味着它解析为 `gateway`；活跃沙盒意味着它停留在沙盒中。
- `elevated` 逃离沙盒到配置的主机路径：默认是 `gateway`，或当 `tools.exec.host=node`（或会话默认是 `host=node`）时是 `node`。仅当当前会话/提供者启用了提升访问时才可用。
- `gateway`/`node` 批准由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要配对节点（ companion app 或无头节点主机）。
- 如果有多个节点可用，设置 `exec.node` 或 `tools.exec.node` 来选择一个。
- `exec host=node` 是节点的唯一 shell 执行路径；旧的 `nodes.run` 包装器已被移除。
- 在非 Windows 主机上，exec 在设置 `SHELL` 时使用它；如果 `SHELL` 是 `fish`，它优先选择 `PATH` 中的 `bash`（或 `sh`）
  以避免与 fish 不兼容的脚本，如果两者都不存在，则回退到 `SHELL`。
- 在 Windows 主机上，exec 优先选择 PowerShell 7（`pwsh`）发现（Program Files、ProgramW6432，然后是 PATH），
  然后回退到 Windows PowerShell 5.1。
- 主机执行（`gateway`/`node`）拒绝 `env.PATH` 和加载器覆盖（`LD_*`/`DYLD_*`）以
  防止二进制劫持或注入代码。
- OpenClaw 在生成的命令环境（包括 PTY 和沙盒执行）中设置 `OPENCLAW_SHELL=exec`，以便 shell/profile 规则可以检测 exec-tool 上下文。
- 重要：沙盒默认是**关闭**的。如果沙盒关闭，隐式 `host=auto`
  解析为 `gateway`。显式 `host=sandbox` 仍然会关闭失败，而不是在网关主机上静默运行。启用沙盒或使用带有批准的 `host=gateway`。
- 脚本预检检查（针对常见的 Python/Node shell 语法错误）仅检查有效的
  `workdir` 边界内的文件。如果脚本路径解析到 `workdir` 之外，该文件的预检将被跳过。
- 对于现在开始的长时间运行的工作，启动一次并在启用自动完成唤醒时依赖它
  当命令发出输出或失败时。
  使用 `process` 进行日志、状态、输入或干预；不要模拟
  带有睡眠循环、超时循环或重复轮询的调度。
- 对于应该在以后或按计划发生的工作，使用 cron 而不是
  `exec` 睡眠/延迟模式。

## 配置

- `tools.exec.notifyOnExit`（默认：true）：当为 true 时，后台化的 exec 会话在退出时入队系统事件并请求心跳。
- `tools.exec.approvalRunningNoticeMs`（默认：10000）：当需要批准的 exec 运行时间超过此时，发出单个"运行中"通知（0 禁用）。
- `tools.exec.host`（默认：`auto`；当沙盒运行时活跃时解析为 `sandbox`，否则为 `gateway`）
- `tools.exec.security`（默认：沙盒为 `deny`，未设置时网关 + 节点为 `full`）
- `tools.exec.ask`（默认：`off`）
- 无批准主机执行是网关 + 节点的默认设置。如果你想要批准/允许列表行为，收紧 `tools.exec.*` 和主机 `~/.openclaw/exec-approvals.json`；请参阅 [Exec approvals](/tools/exec-approvals#no-approval-yolo-mode)。
- YOLO 来自主机策略默认值（`security=full`，`ask=off`），而不是来自 `host=auto`。如果你想强制网关或节点路由，设置 `tools.exec.host` 或使用 `/exec host=...`。
- 在 `security=full` 加 `ask=off` 模式下，主机执行直接遵循配置的策略；没有额外的启发式命令混淆预过滤器。
- `tools.exec.node`（默认：未设置）
- `tools.exec.strictInlineEval`（默认：false）：当为 true 时，内联解释器 eval 形式如 `python -c`、`node -e`、`ruby -e`、`perl -e`、`php -r`、`lua -e` 和 `osascript -e` 始终需要显式批准。`allow-always` 仍然可以持久化良性解释器/脚本调用，但内联 eval 形式仍然每次都提示。
- `tools.exec.pathPrepend`：在 exec 运行时要添加到 `PATH` 前面的目录列表（仅网关 + 沙盒）。
- `tools.exec.safeBins`：仅标准输入的安全二进制文件，可以在没有显式允许列表条目的情况下运行。有关行为详情，请参阅 [Safe bins](/tools/exec-approvals#safe-bins-stdin-only)。
- `tools.exec.safeBinTrustedDirs`：`safeBins` 路径检查的额外显式受信任目录。`PATH` 条目永远不会被自动信任。内置默认值是 `/bin` 和 `/usr/bin`。
- `tools.exec.safeBinProfiles`：每个安全二进制文件的可选自定义 argv 策略（`minPositional`、`maxPositional`、`allowedValueFlags`、`deniedFlags`）。

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

- `host=gateway`：将你的登录 shell `PATH` 合并到 exec 环境中。`env.PATH` 覆盖被
  拒绝用于主机执行。守护进程本身仍然使用最小 `PATH` 运行：
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：在容器内运行 `sh -lc`（登录 shell），因此 `/etc/profile` 可能会重置 `PATH`。
  OpenClaw 通过内部环境变量在 profile 源后添加 `env.PATH`（无 shell 插值）；
  `tools.exec.pathPrepend` 也适用于这里。
- `host=node`：只有你传递的非阻塞环境覆盖会发送到节点。`env.PATH` 覆盖被
  拒绝用于主机执行并被节点主机忽略。如果你需要节点上的额外 PATH 条目，
  配置节点主机服务环境（systemd/launchd）或将工具安装在标准位置。

按代理节点绑定（在配置中使用代理列表面索引）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制 UI：节点选项卡包括用于相同设置的小型"Exec node binding"面板。

## 会话覆盖（`/exec`）

使用 `/exec` 为 `host`、`security`、`ask` 和 `node` 设置**每会话**默认值。
发送无参数的 `/exec` 以显示当前值。

示例：

```
/exec host=auto security=allowlist ask=on-miss node=mac-1
```

## 授权模型

`/exec` 仅对**授权发送者**（频道允许列表/配对加上 `commands.useAccessGroups`）生效。
它仅更新**会话状态**，不写入配置。要硬禁用 exec，通过工具
策略拒绝它（`tools.deny: ["exec"]` 或按代理）。除非你明确设置
`security=full` 和 `ask=off`，否则主机批准仍然适用。

## 执行批准（companion app / 节点主机）

沙盒化的代理可能需要在 `exec` 在网关或节点主机上运行之前进行每个请求的批准。
有关策略、允许列表和 UI 流程，请参阅 [Exec approvals](/tools/exec-approvals)。

当需要批准时，exec 工具立即返回
`status: "approval-pending"` 和批准 ID。一旦批准（或拒绝/超时），
网关会发出系统事件（`Exec finished` / `Exec denied`）。如果命令在 `tools.exec.approvalRunningNoticeMs` 后仍然运行，会发出单个 `Exec running` 通知。
在具有原生批准卡片/按钮的频道上，代理应首先依赖该
原生 UI，并且仅当工具
结果明确表示聊天批准不可用或手动批准是唯一路径时，才包括手动 `/approve` 命令。

## 允许列表 + 安全二进制文件

手动允许列表强制执行仅匹配**解析的二进制路径**（无基本名称匹配）。当
`security=allowlist` 时，只有当每个管道段都被允许列表或安全二进制文件允许时，shell 命令才会被自动允许。链接（`;`、`&&`、`||`）和重定向在允许列表模式下被拒绝，除非每个顶级段都满足允许列表（包括安全二进制文件）。
重定向仍然不受支持。
持久的 `allow-always` 信任不会绕过该规则：链接命令仍然要求每个顶级段匹配。

`autoAllowSkills` 是 exec 批准中的单独便捷路径。它与手动路径允许列表条目不同。对于严格的显式信任，保持 `autoAllowSkills` 禁用。

为不同的作业使用两个控件：

- `tools.exec.safeBins`：小型、仅标准输入的流过滤器。
- `tools.exec.safeBinTrustedDirs`：安全二进制可执行路径的显式额外受信任目录。
- `tools.exec.safeBinProfiles`：自定义安全二进制文件的显式 argv 策略。
- 允许列表：可执行路径的显式信任。

不要将 `safeBins` 视为通用允许列表，也不要添加解释器/运行时二进制文件（例如 `python3`、`node`、`ruby`、`bash`）。如果你需要这些，请使用显式允许列表条目并保持批准提示启用。
`openclaw security audit` 会在解释器/运行时 `safeBins` 条目缺少显式配置文件时发出警告，`openclaw doctor --fix` 可以搭建缺失的自定义 `safeBinProfiles` 条目。
`openclaw security audit` 和 `openclaw doctor` 还会在你明确将广泛行为的二进制文件（如 `jq`）添加回 `safeBins` 时发出警告。
如果你明确允许列表解释器，请启用 `tools.exec.strictInlineEval`，以便内联代码 eval 形式仍然需要新的批准。

有关完整的策略详情和示例，请参阅 [Exec approvals](/tools/exec-approvals#safe-bins-stdin-only) 和 [Safe bins versus allowlist](/tools/exec-approvals#safe-bins-versus-allowlist)。

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

轮询用于按需状态，不是等待循环。如果启用了自动完成唤醒，命令可以在发出输出或失败时唤醒会话。

发送键（tmux 风格）：

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

## apply_patch

`apply_patch` 是 `exec` 的子工具，用于结构化多文件编辑。
它默认对 OpenAI 和 OpenAI Codex 模型启用。仅在你想要禁用它或将其限制为特定模型时使用配置：

```json5
{
  tools: {
    exec: {
      applyPatch: { workspaceOnly: true, allowModels: ["gpt-5.4"] },
    },
  },
}
```

注意：

- 仅对 OpenAI/OpenAI Codex 模型可用。
- 工具策略仍然适用；`allow: ["write"]` 隐式允许 `apply_patch`。
- 配置位于 `tools.exec.applyPatch` 下。
- `tools.exec.applyPatch.enabled` 默认为 `true`；将其设置为 `false` 以禁用 OpenAI 模型的工具。
- `tools.exec.applyPatch.workspaceOnly` 默认为 `true`（工作区包含）。仅当你有意希望 `apply_patch` 在工作区目录之外写入/删除时，才将其设置为 `false`。

## 相关

- [执行批准](/tools/exec-approvals) — shell 命令的批准门控
- [沙盒化](/gateway/sandboxing) — 在沙盒环境中运行命令
- [后台进程](/gateway/background-process) — 长时间运行的 exec 和 process 工具
- [安全性](/gateway/security) — 工具策略和提升访问