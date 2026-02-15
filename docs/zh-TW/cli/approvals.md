---
summary: "openclaw approvals 的 CLI 參考文件（Gateway 或節點主機的執行核准）"
read_when:
  - "想要從 CLI 編輯執行核准"
  - "需要在 Gateway 或節點主機上管理白名單"
title: "approvals"
---

# `openclaw approvals`

管理**本地主機**、**Gateway 主機**或**節點主機**的執行核准。
預設情況下，指令會針對磁碟上的本地核准檔案。使用 `--gateway` 鎖定 Gateway，或使用 `--node` 鎖定特定節點。

相關內容：

- 執行核准：[執行核准](/tools/exec-approvals)
- 節點：[節點](/nodes)

## 常見指令

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 從檔案替換核准設定

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 白名單輔助指令

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 注意事項

- `--node` 使用與 `openclaw nodes` 相同的解析器（id、名稱、ip 或 id 前綴）。
- `--agent` 預設為 `"*"`，適用於所有智慧代理。
- 節點主機必須公告 `system.execApprovals.get/set`（macOS 應用程式或無介面節點主機）。
- 核准檔案按主機儲存於 `~/.openclaw/exec-approvals.json`。
