---
summary: >-
  CLI reference for `openclaw approvals` (exec approvals for gateway or node
  hosts)
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: approvals
---

# `openclaw approvals`

管理 **本地主機**、**閘道主機** 或 **節點主機** 的執行批准。預設情況下，命令會針對磁碟上的本地批准檔案。使用 `--gateway` 來針對閘道，或使用 `--node` 來針對特定節點。

[[BLOCK_1]]

- 執行批准: [Exec approvals](/tools/exec-approvals)
- 節點: [Nodes](/nodes)

## 常用指令

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 從檔案中替換批准事項

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 允許清單輔助工具

bash
openclaw approvals allowlist add "~/Projects/\*_/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "_" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/\*\*/bin/rg"

## Notes

- `--node` 使用與 `openclaw nodes` 相同的解析器（id、name、ip 或 id 前綴）。
- `--agent` 預設為 `"*"`，適用於所有代理。
- 節點主機必須廣播 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。
- 批准檔案按主機儲存於 `~/.openclaw/exec-approvals.json`。
