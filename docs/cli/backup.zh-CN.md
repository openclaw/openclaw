---
summary: "`openclaw backup` 的 CLI 参考（创建本地备份档案）"
read_when:
  - 您想要本地 OpenClaw 状态的一等备份档案
  - 您想在重置或卸载前预览哪些路径会被包含

title: "backup"
---

# `openclaw backup`

为 OpenClaw 状态、配置、身份验证配置文件、通道/提供商凭据、会话以及可选的工作区创建本地备份档案。

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

## 注意

- 档案包含一个 `manifest.json` 文件，其中包含解析的源路径和档案布局。
- 默认输出是当前工作目录中带有时间戳的 `.tar.gz` 档案。
- 如果当前工作目录在备份的源树内，OpenClaw 会回退到您的主目录作为默认档案位置。
- 现有档案文件永远不会被覆盖。
- 源状态/工作区树内的输出路径被拒绝，以避免自包含。
- `openclaw backup verify <archive>` 验证档案是否包含恰好一个根清单，拒绝遍历样式的档案路径，并检查每个清单声明的有效负载是否存在于 tarball 中。
- `openclaw backup create --verify` 在写入档案后立即运行该验证。
- `openclaw backup create --only-config` 仅备份活动的 JSON 配置文件。

## 备份内容

`openclaw backup create` 从本地 OpenClaw 安装规划备份源：

- OpenClaw 本地状态解析器返回的状态目录，通常是 `~/.openclaw`
- 活动配置文件路径
- 当凭据目录存在于状态目录外时的解析 `credentials/` 目录
- 从当前配置发现的工作区目录，除非您传递 `--no-include-workspace`

模型身份验证配置文件已经是状态目录的一部分，位于
`agents/<agentId>/agent/auth-profiles.json`，因此它们通常被状态备份条目覆盖。

如果您使用 `--only-config`，OpenClaw 会跳过状态、凭据目录和工作区发现，只归档活动配置文件路径。

OpenClaw 在构建档案之前规范化路径。如果配置、
凭据目录或工作区已经位于状态目录内，
它们不会作为单独的顶级备份源被复制。缺少的路径会被跳过。

档案有效负载存储来自这些源树的文件内容，嵌入式 `manifest.json` 记录解析的绝对源路径以及每个资产使用的档案布局。

## 无效配置行为

`openclaw backup` 有意绕过正常的配置预检，以便在恢复过程中仍然可以提供帮助。由于工作区发现依赖于有效的配置，当配置文件存在但无效且工作区备份仍启用时，`openclaw backup create` 现在会快速失败。

如果在这种情况下您仍然想要部分备份，请重新运行：

```bash
openclaw backup create --no-include-workspace
```

这会保持状态、配置和外部凭据目录的范围，同时
完全跳过工作区发现。

如果您只需要配置文件本身的副本，`--only-config` 在配置格式错误时也能工作，因为它不依赖于解析配置来发现工作区。

## 大小和性能

OpenClaw 不强制执行内置的最大备份大小或每文件大小限制。

实际限制来自本地机器和目标文件系统：

- 临时档案写入和最终档案的可用空间
- 遍历大型工作区树并将其压缩为 `.tar.gz` 的时间
- 如果使用 `openclaw backup create --verify` 或运行 `openclaw backup verify`，重新扫描档案的时间
- 目标路径的文件系统行为。OpenClaw 首选无覆盖硬链接发布步骤，当硬链接不受支持时回退到独占复制

大型工作区通常是档案大小的主要驱动因素。如果您想要更小或更快的备份，请使用 `--no-include-workspace`。

对于最小的档案，请使用 `--only-config`。