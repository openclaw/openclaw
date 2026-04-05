---
read_when:
  - 你想通过 CLI 编辑执行审批
  - 你需要管理 Gateway 网关或节点主机上的允许列表
summary: CLI 参考：`mullusi approvals`（Gateway 网关或节点主机的执行审批）
title: approvals
x-i18n:
  generated_at: "2026-02-03T10:04:09Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: 4329cdaaec2c5f5d619415b6431196512d4834dc1ccd7363576f03dd9b845130
  source_path: cli/approvals.md
  workflow: 15
---

# `mullusi approvals`

管理**本地主机**、**Gateway 网关主机**或**节点主机**的执行审批。
默认情况下，命令针对磁盘上的本地审批文件。使用 `--gateway` 可针对 Gateway 网关，使用 `--node` 可针对特定节点。

相关内容：

- 执行审批：[执行审批](/tools/exec-approvals)
- 节点：[节点](/nodes)

## 常用命令

```bash
mullusi approvals get
mullusi approvals get --node <id|name|ip>
mullusi approvals get --gateway
```

## 从文件替换审批

```bash
mullusi approvals set --file ./exec-approvals.json
mullusi approvals set --node <id|name|ip> --file ./exec-approvals.json
mullusi approvals set --gateway --file ./exec-approvals.json
```

## 允许列表辅助命令

```bash
mullusi approvals allowlist add "~/Projects/**/bin/rg"
mullusi approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
mullusi approvals allowlist add --agent "*" "/usr/bin/uname"

mullusi approvals allowlist remove "~/Projects/**/bin/rg"
```

## 注意事项

- `--node` 使用与 `mullusi nodes` 相同的解析器（id、name、ip 或 id 前缀）。
- `--agent` 默认为 `"*"`，表示适用于所有智能体。
- 节点主机必须公开 `system.execApprovals.get/set`（macOS 应用或无头节点主机）。
- 审批文件按主机存储在 `~/.mullusi/exec-approvals.json`。
