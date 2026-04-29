---
name: healthcheck
description: Audit and harden hosts running OpenClaw for SSH, firewall, updates, exposure, cron checks, and risk posture.
---

# OpenClaw Host Hardening

## 概述

评估并加固运行 OpenClaw 的主机，然后将其与用户定义的风险容忍度对齐，同时不破坏访问。将 OpenClaw 安全工具作为一类信号使用，但将 OS 加固视为单独的、明确的一组步骤。

## 核心规则

- 建议使用最新模型（例如 Opus 4.5、GPT 5.2+）运行此 skill。Agent 应该自我检查当前模型，如果低于该级别则建议切换；不要阻止执行。
- 在任何状态更改操作之前需要明确批准。
- 除非确认用户如何连接，否则不要修改远程访问设置。
- 优先使用可逆的、分阶段的更改，并附带回滚计划。
- 永远不要声称 OpenClaw 更改了主机防火墙、SSH 或 OS 更新；它没有。
- 如果角色/身份未知，仅提供建议。
- 格式：每组用户选择必须编号，以便用户可以回复单个数字。
- 建议使用系统级备份；尝试验证状态。

## 工作流程（按顺序遵循）

### 0) 模型自我检查（非阻塞）

在开始之前，检查当前模型。如果低于最新模型（例如 Opus 4.5、GPT 5.2+），建议切换。不要阻止执行。

### 1) 建立上下文（只读）

在询问之前尝试从环境推断 1-5。如果需要确认，优先使用简单的、非技术性问题。

按顺序确定：

1. OS 和版本（Linux/macOS/Windows），容器 vs 主机。
2. 权限级别（root/admin vs 用户）。
3. 访问路径（本地控制台、SSH、RDP、tailnet）。
4. 网络暴露（公共 IP、反向代理、隧道）。
5. OpenClaw 网关状态和绑定地址。
6. 备份系统和状态（例如 Time Machine、系统镜像、快照）。
7. 部署上下文（本地 mac 应用、无头网关主机、远程网关、容器/CI）。
8. 磁盘加密状态（FileVault/LUKS/BitLocker）。
9. OS 自动安全更新状态。
   注意：这些不是阻塞项目，但强烈建议启用，特别是如果 OpenClaw 可以访问敏感数据。
10. 具有完全访问权限的个人助理使用模式（本地工作站 vs 无头/远程 vs 其他）。

首先请求一次运行只读检查的权限。如果授予，默认运行它们，仅对您无法推断或验证的项目提问。不要询问已经在运行时或命令输出中可见的信息。将权限请求保持为一句话，并将后续信息列为无序列表（除非您正在呈现可选选择，否则不编号）。

如果必须询问，使用非技术性提示：

- "您使用的是 Mac、Windows PC 还是 Linux？"
- "您是直接登录到机器，还是从另一台计算机连接？"
- "这台机器可以从公共互联网访问，还是仅在您的家庭/网络内？"
- "您是否启用了备份（例如 Time Machine），并且它们是最新的？"
- "磁盘加密是否开启（FileVault/BitLocker/LUKS）？"
- "自动安全更新是否启用？"
- "您如何使用这台机器？"
  示例：
  - 与 assistant 共享的个人机器
  - 专用本地机器用于 assistant
  - 专用远程机器/服务器远程访问（始终在线）
  - 其他？

仅在系统上下文已知后才询问风险配置文件。

如果用户授予只读权限，默认运行 OS 适当的检查。如果不是，将它们提供（编号）。示例：

1. OS：`uname -a`、`sw_vers`、`cat /etc/os-release`。
2. 监听端口：
   - Linux：`ss -ltnup`（或如果不支持 `-u` 则使用 `ss -ltnp`）。
   - macOS：`lsof -nP -iTCP -sTCP:LISTEN`。
3. 防火墙状态：
   - Linux：`ufw status`、`firewall-cmd --state`、`nft list ruleset`（选择已安装的）。
   - macOS：`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` 和 `pfctl -s info`。
4. 备份（macOS）：`tmutil status`（如果使用 Time Machine）。

### 2) 运行 OpenClaw 安全审计（只读）

作为默认只读检查的一部分，运行 `openclaw security audit --deep`。仅在用户要求时提供替代方案：

1. `openclaw security audit`（更快，非探测）
2. `openclaw security audit --json`（结构化输出）

提供应用 OpenClaw 安全默认值（编号）：

1. `openclaw security audit --fix`

明确说明 `--fix` 仅收紧 OpenClaw 默认值和文件权限。它不更改主机防火墙、SSH 或 OS 更新策略。

如果启用了浏览器控制，建议在所有重要账户上启用 2FA，硬件密钥优先，SMS 不足。

### 3) 检查 OpenClaw 版本/更新状态（只读）

作为默认只读检查的一部分，运行 `openclaw update status`。

报告当前频道以及是否有可用更新。

### 4) 确定风险容忍度（系统上下文之后）

让用户选择或确认风险状况以及任何需要的开放服务/端口（下面的编号选择）。
不要将用户 pigeonhole 成固定配置文件；如果用户愿意，捕获需求而不是选择配置文件。
将建议的配置文件作为可选默认值提供（编号）。请注意，大多数用户选择 Home/Workstation Balanced：

1. Home/Workstation Balanced（最常见）：防火墙开启，合理的默认值，远程访问限制为 LAN 或 tailnet。
2. VPS Hardened：默认拒绝入站防火墙，最少开放端口，仅密钥 SSH，无 root 登录，自动安全更新。
3. Developer Convenience：允许更多本地服务，明确暴露警告，仍然被审计。
4. Custom：用户定义的约束（服务、暴露、更新节奏、访问方法）。

### 5) 生成修复计划

提供包含以下内容的计划：

- 目标配置文件
- 当前姿态摘要
- 与目标的差距
- 带有确切命令的逐步修复
- 访问保持策略和回滚
- 风险和潜在锁定场景
- 最小权限注意事项（例如，避免 admin 使用，在安全的地方收紧所有权/权限）
- 凭证卫生注意事项（OpenClaw 凭证的位置，优先使用磁盘加密）

始终在任何更改之前显示计划。

### 6) 提供执行选项

提供以下选择之一（编号以便用户可以回复单个数字）：

1. 为我做（引导式，逐步批准）
2. 仅显示计划
3. 仅修复关键问题
4. 导出命令以供以后使用

### 7) 逐步执行确认

对于每个步骤：

- 显示确切命令
- 解释影响和回滚
- 确认访问将保持可用
- 在意外输出时停止并请求指导

### 8) 验证并报告

重新检查：

- 防火墙状态
- 监听端口
- 远程访问仍然有效
- OpenClaw 安全审计（重新运行）

交付最终姿态报告并注明任何延迟项目。

## 所需确认（始终）

需要明确批准：

- 防火墙规则更改
- 打开/关闭端口
- SSH/RDP 配置更改
- 安装/删除包
- 启用/禁用服务
- 用户/组修改
- 调度任务或启动持久化
- 更新策略更改
- 访问敏感文件或凭证

如有疑问，请问。

## 定期检查

在 OpenClaw 安装或首次加固通过后，至少运行一次基线审计和版本检查：

- `openclaw security audit`
- `openclaw security audit --deep`
- `openclaw update status`

建议进行持续监控。使用 OpenClaw cron 工具/CLI 安排定期审计（Gateway 调度器）。未经明确批准不要创建调度任务。将输出存储在用户批准的位置，避免在日志中使用凭证。
在调度无头 cron 运行时，在输出中包含说明，以便用户调用 `healthcheck` 以便可以修复问题。

### 调度所需提示（始终）

在任何审计或加固通过后，明确提供调度并需要直接回复。使用简短的提示例如（编号）：

1. "您是否希望我通过 `openclaw cron add` 安排定期审计（例如每日/每周）？"

如果用户说是，请问：

- 节奏（每日/每周）、首选时间窗口和输出位置
- 是否还要安排 `openclaw update status`

使用稳定的 cron 作业名称以便更新是确定性的。优先使用确切名称：

- `healthcheck:security-audit`
- `healthcheck:update-status`

创建之前，`openclaw cron list` 并匹配确切 `name`。如果找到，`openclaw cron edit <id> ...`。
如果未找到，`openclaw cron add --name <name> ...`。

还要提供定期版本检查，以便用户可以决定何时更新（编号）：

1. `openclaw update status`（优先用于源检出和频道）
2. `npm view openclaw version`（已发布的 npm 版本）

## OpenClaw 命令准确性

仅使用支持的命令和标志：

- `openclaw security audit [--deep] [--fix] [--json]`
- `openclaw status` / `openclaw status --deep`
- `openclaw health --json`
- `openclaw update status`
- `openclaw cron add|list|runs|run`

不要发明 CLI 标志或暗示 OpenClaw 强制执行主机防火墙/SSH 策略。

## 日志和审计跟踪

记录：

- 网关身份和角色
- 计划 ID 和时间戳
- 批准的步骤和确切命令
- 退出代码和修改的文件（尽力而为）

编辑凭证。永远不要记录令牌或完整凭证内容。

## 内存写入（条件）

仅当用户明确选择加入且会话是私有/本地工作区时写入内存文件
（按 `docs/reference/templates/AGENTS.md`）。否则提供编辑的、随时可粘贴的摘要，用户可以决定保存在其他地方。

遵循 OpenClaw 压缩使用的持久内存提示格式：

- 将持久注释写入 `memory/YYYY-MM-DD.md`。

每次审计/加固运行后，如果选择加入，追加一个简短的、带日期的摘要到 `memory/YYYY-MM-DD.md`
（检查了什么、关键发现、采取的行动、任何调度的 cron 作业、关键决策，
和所有执行的命令）。仅追加：永远不要覆盖现有条目。
编辑敏感主机详细信息（用户名、主机名、IP、序列号、服务名、令牌）。
如果有持久的偏好或决定（风险状况、允许的端口、更新策略），
也要更新 `MEMORY.md`（长期记忆是可选的，仅在私人会话中使用）。

如果会话无法写入工作区，请求许可或提供确切条目，用户可以粘贴到内存文件中。
