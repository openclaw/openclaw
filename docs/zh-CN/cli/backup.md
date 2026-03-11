---
summary: "`openclaw backup` CLI 参考（创建本地备份存档）"
read_when:
  - 需要为本地 OpenClaw 状态创建备份存档
  - 想在重置或卸载前预览将包含哪些路径
title: "backup"
---

# `openclaw backup`

为 OpenClaw 的状态、配置、凭证、会话以及可选的工作区创建本地备份存档。

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

## 说明

- 存档包含一个 `manifest.json` 文件，记录了解析后的源路径和存档布局。
- 默认输出为当前工作目录中带时间戳的 `.tar.gz` 存档。
- 如果当前工作目录在某个已备份的源目录树中，OpenClaw 会回退到主目录作为默认存档位置。
- 现有的存档文件永远不会被覆盖。
- 位于源状态/工作区目录树内的输出路径会被拒绝，以避免自包含。
- `openclaw backup verify <archive>` 验证存档是否只包含一个根 manifest，拒绝路径穿越式的存档路径，并检查 manifest 中声明的每个载荷都存在于 tarball 中。
- `openclaw backup create --verify` 在写入存档后立即执行该验证。
- `openclaw backup create --only-config` 仅备份当前活跃的 JSON 配置文件。

## 备份内容

`openclaw backup create` 从本地 OpenClaw 安装规划备份源：

- OpenClaw 本地状态解析器返回的状态目录，通常是 `~/.openclaw`
- 活跃配置文件路径
- OAuth / 凭证目录
- 从当前配置发现的工作区目录，除非传入 `--no-include-workspace`

使用 `--only-config` 时，OpenClaw 跳过状态、凭证和工作区发现，仅备份活跃配置文件路径。

OpenClaw 在构建存档前会规范化路径。如果配置、凭证或工作区已在状态目录内，它们不会作为单独的顶级备份源重复出现。缺失的路径会被跳过。

存档载荷存储这些源目录树中的文件内容，嵌入的 `manifest.json` 记录了解析后的绝对源路径以及每个资产使用的存档布局。

## 无效配置行为

`openclaw backup` 有意跳过正常的配置预检，以便在恢复时仍然可用。由于工作区发现依赖于有效配置，当配置文件存在但无效且工作区备份仍启用时，`openclaw backup create` 现在会快速失败。

如果仍需要部分备份，请重新运行：

```bash
openclaw backup create --no-include-workspace
```

这样可以保留状态、配置和凭证的范围，同时完全跳过工作区发现。

如果只需要配置文件本身的副本，`--only-config` 在配置格式错误时也能工作，因为它不依赖配置解析来发现工作区。

## 大小和性能

OpenClaw 不强制内置最大备份大小或单文件大小限制。

实际限制来自本地机器和目标文件系统：

- 临时存档写入加最终存档的可用空间
- 遍历大型工作区目录树并压缩为 `.tar.gz` 的时间
- 使用 `openclaw backup create --verify` 或运行 `openclaw backup verify` 时重新扫描存档的时间
- 目标路径的文件系统行为。OpenClaw 优先使用不覆盖的硬链接发布步骤，在不支持硬链接时回退到独占复制

大型工作区通常是存档大小的主要驱动因素。如果需要更小或更快的备份，使用 `--no-include-workspace`。

最小存档请使用 `--only-config`。
