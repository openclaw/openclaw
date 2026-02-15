---
summary: "openclaw approvals CLI 參考（Gateway 或節點主機的執行核准）"
read_when:
  - 您想從 CLI 編輯執行核准
  - 您需要在 Gateway 或節點主機上管理允許清單
title: "approvals"
---

# `openclaw approvals`

管理**本機主機**、**Gateway 主機**或**節點主機**的執行核准。
預設情況下，指令會針對磁碟上的本機核准檔案。使用 `--gateway` 可針對 Gateway，或使用 `--node` 可針對特定節點。

相關：

- 執行核准：[執行核准](/tools/exec-approvals)
- 節點：[節點](/nodes)

## 常見指令

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 從檔案替換核准

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 允許清單輔助功能

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 備註

- `--node` 使用與 `openclaw nodes` 相同的解析器 (id、名稱、ip 或 id 前綴)。
- `--agent` 預設為 `"*"`，適用於所有智慧代理。
- 節點主機必須通告 `system.execApprovals.get/set` (macOS 應用程式或無頭節點主機)。
- 核准檔案會儲存在每個主機的 `~/.openclaw/exec-approvals.json` 中。
