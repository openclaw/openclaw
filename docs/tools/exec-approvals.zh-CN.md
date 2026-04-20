---
summary: "执行审批、允许列表和沙盒逃逸提示"
read_when:
  - 配置执行审批或允许列表
  - 在 macOS 应用中实现执行审批用户界面
  - 审查沙盒逃逸提示及其影响
title: "执行审批"
---

# 执行审批

执行审批是**配套应用 / 节点主机护栏**，用于让沙盒化代理在真实主机（`gateway` 或 `node`）上运行命令。可以将其视为安全互锁：只有当策略 + 允许列表 +（可选）用户审批都同意时，命令才被允许。

执行审批是**除了**工具策略和提升门控之外的额外措施（除非提升设置为 `full`，这会跳过审批）。

有效策略是 `tools.exec.*` 和审批默认值中**更严格**的那个；如果省略审批字段，则使用 `tools.exec` 值。

主机执行还使用该机器上的本地审批状态。主机本地的 `~/.openclaw/exec-approvals.json` 中的 `ask: "always"` 会持续提示，即使会话或配置默认请求 `ask: "on-miss"`。

使用 `openclaw approvals get`、`openclaw approvals get --gateway` 或 `openclaw approvals get --node <id|name|ip>` 来检查请求的策略、主机策略来源和有效结果。

对于本地机器，`openclaw exec-policy show` 暴露相同的合并视图，`openclaw exec-policy set|preset` 可以一步同步本地请求策略与本地主机审批文件。当本地作用域请求 `host=node` 时，`openclaw exec-policy show` 报告该作用域在运行时由节点管理，而不是假装本地审批文件是有效事实的来源。

如果配套应用 UI**不可用**，任何需要提示的请求都由**询问回退**（默认：拒绝）解决。

原生聊天审批客户端还可以在待审批消息上暴露特定于通道的功能。例如，Matrix 可以在审批提示上植入反应快捷键（`✅` 允许一次，`❌` 拒绝，`♾️` 允许始终，当可用时），同时仍然在消息中保留 `/approve ...` 命令作为回退。

## 适用范围

执行审批在执行主机上本地执行：

- **网关主机** → 网关机器上的 `openclaw` 进程
- **节点主机** → 节点运行器（macOS 配套应用或无头节点主机）

信任模型说明：

- 网关认证的调用者是该网关的受信任操作员。
- 配对节点将该受信任操作员能力扩展到节点主机。
- 执行审批减少意外执行风险，但不是每个用户的认证边界。
- 批准的节点主机运行绑定规范执行上下文：规范 cwd、精确 argv、存在时的环境绑定，以及适用时的固定可执行路径。
- 对于 shell 脚本和直接解释器/运行时文件调用，OpenClaw 还尝试绑定一个具体的本地文件操作数。如果该绑定文件在审批后但执行前发生变化，运行会被拒绝，而不是执行漂移的内容。
- 这种文件绑定是有意的最大努力，而不是每个解释器/运行时加载器路径的完整语义模型。如果审批模式无法识别一个确切的具体本地文件来绑定，它会拒绝创建基于审批的运行，而不是假装完全覆盖。

macOS 拆分：

- **节点主机服务** 通过本地 IPC 将 `system.run` 转发到**macOS 应用**。
- **macOS 应用** 强制执行审批 + 在 UI 上下文中执行命令。

## 设置和存储

审批存在于执行主机上的本地 JSON 文件中：

`~/.openclaw/exec-approvals.json`

示例模式：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## 无审批 "YOLO" 模式

如果你希望主机执行在没有审批提示的情况下运行，你必须打开**两个**策略层：

- OpenClaw 配置中的请求执行策略 (`tools.exec.*`)
- `~/.openclaw/exec-approvals.json` 中的主机本地审批策略

现在这是默认的主机行为，除非你明确收紧：

- `tools.exec.security`: `full` 在 `gateway`/`node` 上
- `tools.exec.ask`: `off`
- 主机 `askFallback`: `full`

重要区别：

- `tools.exec.host=auto` 选择 exec 运行的位置：可用时沙盒，否则网关。
- YOLO 选择主机 exec 的批准方式：`security=full` 加上 `ask=off`。
- 在 YOLO 模式下，OpenClaw 不会在配置的主机 exec 策略之上添加单独的启发式命令混淆审批门控。
- `auto` 不会使网关路由成为从沙盒化会话的自由覆盖。从 `auto` 允许每调用 `host=node` 请求，只有当没有沙盒运行时活动时，才允许从 `auto` 进行 `host=gateway`。如果你想要稳定的非自动默认值，设置 `tools.exec.host` 或显式使用 `/exec host=...`。

如果你想要更保守的设置，将任一层收紧回 `allowlist` / `on-miss` 或 `deny`。

持久网关主机 "从不提示" 设置：

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.security full
openclaw config set tools.exec.ask off
openclaw gateway restart
```

然后将主机审批文件设置为匹配：

```bash
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

当前机器上相同网关主机策略的本地快捷方式：

```bash
openclaw exec-policy preset yolo
```

该本地快捷方式更新两者：

- 本地 `tools.exec.host/security/ask`
- 本地 `~/.openclaw/exec-approvals.json` 默认值

它是有意的本地唯一。如果你需要远程更改网关主机或节点主机审批，继续使用 `openclaw approvals set --gateway` 或 `openclaw approvals set --node <id|name|ip>`。

对于节点主机，在该节点上应用相同的审批文件：

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

重要的本地唯一限制：

- `openclaw exec-policy` 不同步节点审批
- `openclaw exec-policy set --host node` 被拒绝
- 节点执行审批在运行时从节点获取，因此节点目标更新必须使用 `openclaw approvals --node ...`

会话唯一快捷方式：

- `/exec security=full ask=off` 仅更改当前会话。
- `/elevated full` 是一个紧急快捷方式，也会跳过该会话的执行审批。

如果主机审批文件保持比配置更严格，更严格的主机策略仍然获胜。

## 策略旋钮

### 安全 (`exec.security`)

- **deny**: 阻止所有主机执行请求。
- **allowlist**: 仅允许允许列表中的命令。
- **full**: 允许一切（相当于 elevated）。

### 询问 (`exec.ask`)

- **off**: 从不提示。
- **on-miss**: 仅当允许列表不匹配时提示。
- **always**: 每个命令都提示。
- `allow-always` 持久信任不会在有效询问模式为 `always` 时抑制提示

### 询问回退 (`askFallback`)

如果需要提示但无法到达 UI，回退决定：

- **deny**: 阻止。
- **allowlist**: 仅当允许列表匹配时允许。
- **full**: 允许。

### 内联解释器评估强化 (`tools.exec.strictInlineEval`)

当 `tools.exec.strictInlineEval=true` 时，OpenClaw 将内联代码评估形式视为仅审批，即使解释器二进制文件本身在允许列表中。

示例：

- `python -c`
- `node -e`, `node --eval`, `node -p`
- `ruby -e`
- `perl -e`, `perl -E`
- `php -r`
- `lua -e`
- `osascript -e`

这是针对不能干净地映射到一个稳定文件操作数的解释器加载器的纵深防御。在严格模式下：

- 这些命令仍然需要明确审批；
- `allow-always` 不会自动为它们持久化新的允许列表条目。

## 允许列表（每个代理）

允许列表是**每个代理**的。如果存在多个代理，在 macOS 应用中切换你正在编辑的代理。模式是**大小写不敏感的 glob 匹配**。模式应该解析为**二进制路径**（仅基本名称条目被忽略）。

旧版 `agents.default` 条目在加载时迁移到 `agents.main`。

Shell 链如 `echo ok && pwd` 仍然需要每个顶级段满足允许列表规则。

示例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每个允许列表条目跟踪：

- **id** 用于 UI 身份的稳定 UUID（可选）
- **last used** 时间戳
- **last used command** 最后使用的命令
- **last resolved path** 最后解析的路径

## 自动允许技能 CLI

当**自动允许技能 CLI** 启用时，由已知技能引用的可执行文件在节点（macOS 节点或无头节点主机）上被视为允许列表。这使用 `skills.bins` 通过 Gateway RPC 获取技能 bin 列表。如果你想要严格的手动允许列表，请禁用此功能。

重要信任说明：

- 这是一个**隐式便利允许列表**，与手动路径允许列表条目分开。
- 它旨在用于 Gateway 和节点在同一信任边界内的受信任操作员环境。
- 如果你需要严格的显式信任，保持 `autoAllowSkills: false` 并仅使用手动路径允许列表条目。

## 安全 bin（仅 stdin）

`tools.exec.safeBins` 定义了一小部分**仅 stdin** 二进制文件（例如 `cut`），它们可以在允许列表模式下**无需**显式允许列表条目运行。安全 bin 拒绝位置文件参数和类似路径的令牌，因此它们只能对传入流进行操作。将此视为流过滤器的窄快速路径，而不是一般信任列表。

**不要**将解释器或运行时二进制文件（例如 `python3`、`node`、`ruby`、`bash`、`sh`、`zsh`）添加到 `safeBins`。如果命令可以评估代码、执行子命令或按设计读取文件，更喜欢显式允许列表条目并保持审批提示启用。

自定义安全 bin 必须在 `tools.exec.safeBinProfiles.<bin>` 中定义显式配置文件。

验证仅从 argv 形状确定性（无主机文件系统存在检查），这可以防止文件存在 oracle 行为与允许/拒绝差异。

默认安全 bin 拒绝面向文件的选项（例如 `sort -o`、`sort --output`、`sort --files0-from`、`sort --compress-program`、`sort --random-source`、`sort --temporary-directory`/`-T`、`wc --files0-from`、`jq -f/--from-file`、`grep -f/--file`）。

安全 bin 还对破坏仅 stdin 行为的选项强制执行明确的每二进制标志策略（例如 `sort -o/--output/--compress-program` 和 grep 递归标志）。

长选项在安全 bin 模式下验证为失败关闭：未知标志和模糊缩写被拒绝。

安全 bin 配置文件拒绝的标志：

[//]: # "SAFE_BIN_DENIED_FLAGS:START"

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o`
- `wc`: `--files0-from`

[//]: # "SAFE_BIN_DENIED_FLAGS:END"

安全 bin 还强制 argv 令牌在执行时被视为**字面文本**（对于仅 stdin 段，没有 globbing 和 `$VARS` 扩展），因此像 `*` 或 `$HOME/...` 这样的模式不能用于走私文件读取。

安全 bin 还必须从受信任的二进制目录（系统默认值加上可选的 `tools.exec.safeBinTrustedDirs`）解析。`PATH` 条目从不自动受信任。

默认受信任的安全 bin 目录有意最小：`/bin`、`/usr/bin`。

如果你的安全 bin 可执行文件位于包管理器/用户路径（例如 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`/snap/bin`），请将它们显式添加到 `tools.exec.safeBinTrustedDirs`。

Shell 链接和重定向在允许列表模式下不自动允许。

Shell 链接 (`&&`、`||`、`;`) 当每个顶级段满足允许列表（包括安全 bin 或技能自动允许）时被允许。重定向在允许列表模式下仍然不支持。

命令替换 (`$()` / 反引号) 在允许列表解析期间被拒绝，包括在双引号内；如果你需要字面 `$()` 文本，请使用单引号。

在 macOS 配套应用审批中，包含 shell 控制或扩展语法 (`&&`、`||`、`;`、`|`、`` ` ``、`$`、`<`、`>`、`(`、`)`) 的原始 shell 文本被视为允许列表未命中，除非 shell 二进制文件本身在允许列表中。

对于 shell 包装器 (`bash|sh|zsh ... -c/-lc`)，请求范围的环境覆盖减少到一个小的显式允许列表 (`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`)。

对于允许列表模式中的 allow-always 决策，已知的调度包装器 (`env`、`nice`、`nohup`、`stdbuf`、`timeout`) 持久化内部可执行路径而不是包装器路径。Shell 多路复用器 (`busybox`、`toybox`) 也为 shell 小程序 (`sh`、`ash` 等) 解包，因此内部可执行文件被持久化而不是多路复用器二进制文件。如果包装器或多路复用器不能安全解包，则不会自动持久化允许列表条目。

如果你允许列表解释器如 `python3` 或 `node`，更喜欢 `tools.exec.strictInlineEval=true`，这样内联评估仍然需要明确审批。在严格模式下，`allow-always` 仍然可以持久化良性解释器/脚本调用，但内联评估载体不会自动持久化。

默认安全 bin：

[//]: # "SAFE_BIN_DEFAULTS:START"

`cut`, `uniq`, `head`, `tail`, `tr`, `wc`

[//]: # "SAFE_BIN_DEFAULTS:END"

`grep` 和 `sort` 不在默认列表中。如果你选择加入，为它们的非 stdin 工作流保留显式允许列表条目。

对于安全 bin 模式下的 `grep`，使用 `-e`/`--regexp` 提供模式；拒绝位置模式形式，因此文件操作数不能作为模糊位置被走私。

### 安全 bin 与允许列表

| 主题     | `tools.exec.safeBins`                 | 允许列表 (`exec-approvals.json`)              |
| -------- | ------------------------------------- | --------------------------------------------- |
| 目标     | 自动允许窄 stdin 过滤器               | 明确信任特定可执行文件                        |
| 匹配类型 | 可执行名称 + 安全 bin argv 策略       | 解析的可执行路径 glob 模式                    |
| 参数范围 | 受安全 bin 配置文件和字面令牌规则限制 | 仅路径匹配；参数否则由你负责                  |
| 典型示例 | `head`, `tail`, `tr`, `wc`            | `jq`, `python3`, `node`, `ffmpeg`, 自定义 CLI |
| 最佳用途 | 管道中的低风险文本转换                | 任何具有更广泛行为或副作用的工具              |

配置位置：

- `safeBins` 来自配置 (`tools.exec.safeBins` 或每个代理的 `agents.list[].tools.exec.safeBins`)。
- `safeBinTrustedDirs` 来自配置 (`tools.exec.safeBinTrustedDirs` 或每个代理的 `agents.list[].tools.exec.safeBinTrustedDirs`)。
- `safeBinProfiles` 来自配置 (`tools.exec.safeBinProfiles` 或每个代理的 `agents.list[].tools.exec.safeBinProfiles`)。每个代理的配置文件键覆盖全局键。
- 允许列表条目存在于主机本地 `~/.openclaw/exec-approvals.json` 中的 `agents.<id>.allowlist`（或通过 Control UI / `openclaw approvals allowlist ...`）。
- `openclaw security audit` 当解释器/运行时 bin 出现在 `safeBins` 中而没有显式配置文件时，会警告 `tools.exec.safe_bins_interpreter_unprofiled`。
- `openclaw doctor --fix` 可以为缺少的自定义 `safeBinProfiles.<bin>` 条目搭建 `{}`（之后审查并收紧）。解释器/运行时 bin 不会自动搭建。

自定义配置文件示例：

```json5
{
  tools: {
    exec: {
      safeBins: ["jq", "myfilter"],
      safeBinProfiles: {
        myfilter: {
          minPositional: 0,
          maxPositional: 0,
          allowedValueFlags: ["-n", "--limit"],
          deniedFlags: ["-f", "--file", "-c", "--command"],
        },
      },
    },
  },
}
```

如果你明确将 `jq` 选择加入 `safeBins`，OpenClaw 仍然在安全 bin 模式下拒绝 `env` 内置，因此 `jq -n env` 不能在没有显式允许列表路径或审批提示的情况下转储主机进程环境。

## Control UI 编辑

使用**Control UI → Nodes → Exec approvals** 卡片编辑默认值、每代理覆盖和允许列表。选择一个作用域（Defaults 或代理），调整策略，添加/删除允许列表模式，然后**保存**。UI 显示每个模式的**最后使用**元数据，以便你可以保持列表整洁。

目标选择器选择**Gateway**（本地审批）或**Node**。节点必须通告 `system.execApprovals.get/set`（macOS 应用或无头节点主机）。如果节点尚未通告执行审批，请直接编辑其本地 `~/.openclaw/exec-approvals.json`。

CLI: `openclaw approvals` 支持网关或节点编辑（见 [Approvals CLI](/cli/approvals)）。

## 审批流程

当需要提示时，网关向操作员客户端广播 `exec.approval.requested`。Control UI 和 macOS 应用通过 `exec.approval.resolve` 解决它，然后网关将批准的请求转发到节点主机。

对于 `host=node`，审批请求包含规范的 `systemRunPlan` 有效负载。网关使用该计划作为转发批准的 `system.run` 请求时的权威命令/cwd/会话上下文。

这对于异步审批延迟很重要：

- 节点执行路径预先准备一个规范计划
- 审批记录存储该计划及其绑定元数据
- 一旦批准，最终转发的 `system.run` 调用重用存储的计划，而不是信任后来的调用者编辑
- 如果调用者在创建审批请求后更改 `command`、`rawCommand`、`cwd`、`agentId` 或 `sessionKey`，网关会拒绝转发的运行作为审批不匹配

## 解释器/运行时命令

基于审批的解释器/运行时运行有意保守：

- 精确的 argv/cwd/env 上下文始终绑定。
- 直接 shell 脚本和直接运行时文件形式最大努力绑定到一个具体的本地文件快照。
- 仍然解析为一个直接本地文件的常见包管理器包装形式（例如 `pnpm exec`、`pnpm node`、`npm exec`、`npx`）在绑定前解包。
- 如果 OpenClaw 无法为解释器/运行时命令识别一个确切的具体本地文件（例如包脚本、评估形式、运行时特定的加载器链或模糊的多文件形式），基于审批的执行会被拒绝，而不是声称它没有的语义覆盖。
- 对于这些工作流，更喜欢沙盒、单独的主机边界或显式受信任的允许列表/完整工作流，其中操作员接受更广泛的运行时语义。

当需要审批时，exec 工具立即返回审批 ID。使用该 ID 关联稍后的系统事件（`Exec finished` / `Exec denied`）。如果在超时前没有决策到达，请求被视为审批超时并作为拒绝原因浮出水面。

### 后续交付行为

批准的异步 exec 完成后，OpenClaw 向同一会话发送后续 `agent` 轮次。

- 如果存在有效的外部交付目标（可交付通道加目标 `to`），后续交付使用该通道。
- 在仅 webchat 或没有外部目标的内部会话流程中，后续交付保持会话唯一（`deliver: false`）。
- 如果调用者明确请求严格的外部交付但没有可解析的外部通道，请求失败并显示 `INVALID_REQUEST`。
- 如果启用了 `bestEffortDeliver` 且无法解析外部通道，交付降级为会话唯一而不是失败。

确认对话框包括：

- 命令 + 参数
- cwd
- 代理 ID
- 解析的可执行路径
- 主机 + 策略元数据

操作：

- **允许一次** → 现在运行
- **始终允许** → 添加到允许列表 + 运行
- **拒绝** → 阻止

## 审批转发到聊天频道

你可以将执行审批提示转发到任何聊天频道（包括插件频道）并用 `/approve` 批准它们。这使用正常的出站交付管道。

配置：

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // 子字符串或正则表达式
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

在聊天中回复：

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

`/approve` 命令处理执行审批和插件审批。如果 ID 与待处理的执行审批不匹配，它会自动检查插件审批。

### 插件审批转发

插件审批转发使用与执行审批相同的交付管道，但在 `approvals.plugin` 下有自己独立的配置。启用或禁用一个不影响另一个。

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

配置形状与 `approvals.exec` 相同：`enabled`、`mode`、`agentFilter`、`sessionFilter` 和 `targets` 以相同方式工作。

支持共享交互式回复的频道为执行和插件审批渲染相同的审批按钮。没有共享交互式 UI 的频道回退到带有 `/approve` 指令的纯文本。

### 任何频道上的同一聊天审批

当执行或插件审批请求源自可交付的聊天表面时，同一聊天现在默认可以用 `/approve` 批准它。这适用于 Slack、Matrix 和 Microsoft Teams 等频道，以及现有的 Web UI 和终端 UI 流程。

这个共享文本命令路径使用该对话的正常频道认证模型。如果原始聊天已经可以发送命令和接收回复，审批请求不再需要单独的原生交付适配器来保持待处理。

Discord 和 Telegram 也支持同一聊天 `/approve`，但这些频道仍然使用它们解析的审批者列表进行授权，即使原生审批交付被禁用。

对于 Telegram 和其他直接调用 Gateway 的原生审批客户端，此回退有意限于"未找到审批"失败。真正的执行审批拒绝/错误不会作为插件审批静默重试。

### 原生审批交付

一些频道还可以作为原生审批客户端。原生客户端在共享的同一聊天 `/approve` 流程之上添加审批者 DM、原始聊天扇形和特定于频道的交互式审批 UX。

当原生审批卡片/按钮可用时，该原生 UI 是主要的面向代理的路径。代理不应也回显重复的纯聊天 `/approve` 命令，除非工具结果表示聊天审批不可用或手动审批是唯一剩余路径。

通用模型：

- 主机执行策略仍然决定是否需要执行审批
- `approvals.exec` 控制将审批提示转发到其他聊天目的地
- `channels.<channel>.execApprovals` 控制该频道是否作为原生审批客户端

当所有这些都为真时，原生审批客户端自动启用 DM 优先交付：

- 频道支持原生审批交付
- 审批者可以从显式 `execApprovals.approvers` 或该频道记录的回退源解析
- `channels.<channel>.execApprovals.enabled` 未设置或为 `"auto"`

设置 `enabled: false` 明确禁用原生审批客户端。设置 `enabled: true` 在审批者解析时强制启用它。公共原始聊天交付通过 `channels.<channel>.execApprovals.target` 保持显式。

FAQ: [为什么聊天审批有两个执行审批配置？](/help/faq#why-are-there-two-exec-approval-configs-for-chat-approvals)

- Discord: `channels.discord.execApprovals.*`
- Slack: `channels.slack.execApprovals.*`
- Telegram: `channels.telegram.execApprovals.*`

这些原生审批客户端在共享的同一聊天 `/approve` 流程和共享审批按钮之上添加 DM 路由和可选的频道扇形。

共享行为：

- Slack、Matrix、Microsoft Teams 和类似的可交付聊天使用同一聊天 `/approve` 的正常频道认证模型
- 当原生审批客户端自动启用时，默认的原生交付目标是审批者 DM
- 对于 Discord 和 Telegram，只有解析的审批者可以批准或拒绝
- Discord 审批者可以是显式的 (`execApprovals.approvers`) 或从 `commands.ownerAllowFrom` 推断
- Telegram 审批者可以是显式的 (`execApprovals.approvers`) 或从现有所有者配置推断 (`allowFrom`，加上支持的直接消息 `defaultTo`)
- Slack 审批者可以是显式的 (`execApprovals.approvers`) 或从 `commands.ownerAllowFrom` 推断
- Slack 原生按钮保留审批 ID 类型，因此 `plugin:` ID 可以解析插件审批，无需第二个 Slack 本地回退层
- Matrix 原生 DM/频道路由和反应快捷键处理执行和插件审批；插件授权仍然来自 `channels.matrix.dm.allowFrom`
- 请求者不需要是审批者
- 原始聊天可以直接用 `/approve` 批准，当该聊天已经支持命令和回复时
- 原生 Discord 审批按钮按审批 ID 类型路由：`plugin:` ID 直接进入插件审批，其他一切进入执行审批
- 原生 Telegram 审批按钮遵循与 `/approve` 相同的有限执行到插件回退
- 当原生 `target` 启用原始聊天交付时，审批提示包含命令文本
- 待处理的执行审批默认 30 分钟后过期
- 如果没有操作员 UI 或配置的审批客户端可以接受请求，提示回退到 `askFallback`

Telegram 默认为审批者 DM (`target: "dm"`)。当你希望审批提示也出现在原始 Telegram 聊天/主题中时，你可以切换到 `channel` 或 `both`。对于 Telegram 论坛主题，OpenClaw 为审批提示和批准后的后续保持主题。

请参阅：

- [Discord](/channels/discord)
- [Telegram](/channels/telegram)

### macOS IPC 流程

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

安全说明：

- Unix 套接字模式 `0600`，令牌存储在 `exec-approvals.json` 中。
- 相同 UID 对等检查。
- 挑战/响应（随机数 + HMAC 令牌 + 请求哈希）+ 短 TTL。

## 系统事件

执行生命周期作为系统消息浮出水面：

- `Exec running`（仅当命令超过运行通知阈值时）
- `Exec finished`
- `Exec denied`

这些在节点报告事件后发布到代理的会话。

网关主机执行审批在命令完成时（以及可选地当运行时间超过阈值时）发出相同的生命周期事件。

基于审批的执行在这些消息中重用审批 ID 作为 `runId`，以便于关联。

## 被拒绝的审批行为

当异步执行审批被拒绝时，OpenClaw 防止代理在会话中重用任何先前运行相同命令的输出。拒绝原因传递明确的指导，即没有命令输出可用，这会阻止代理声称有新输出或使用先前成功运行的陈旧结果重复被拒绝的命令。

## 影响

- **full** 功能强大；尽可能使用允许列表。
- **ask** 让你保持在循环中，同时仍然允许快速审批。
- 每个代理的允许列表防止一个代理的审批泄漏到其他代理。
- 审批仅适用于来自**授权发送者**的主机执行请求。未授权的发送者不能发出 `/exec`。
- `/exec security=full` 是授权操作员的会话级便利，按设计跳过审批。要硬阻止主机执行，将审批安全性设置为 `deny` 或通过工具策略拒绝 `exec` 工具。

相关：

- [执行工具](/tools/exec)
- [Elevated 模式](/tools/elevated)
- [技能](/tools/skills)

## 相关

- [执行](/tools/exec) — shell 命令执行工具
- [沙盒化](/gateway/sandboxing) — 沙盒模式和工作区访问
- [安全](/gateway/security) — 安全模型和强化
- [沙盒 vs 工具策略 vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) — 何时使用每个
