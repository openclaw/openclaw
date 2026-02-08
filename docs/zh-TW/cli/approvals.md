---
summary: "「openclaw approvals」的 CLI 參考（用於 Gateway 閘道器或節點主機的 exec 核准）"
read_when:
  - 「你想要從 CLI 編輯 exec 核准」
  - 「你需要管理 Gateway 閘道器或節點主機上的允許清單」
title: "核准"
x-i18n:
  source_path: cli/approvals.md
  source_hash: 4329cdaaec2c5f5d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:15Z
---

# `openclaw approvals`

管理**本機主機**、**閘道器主機**或**節點主機**的 exec 核准。
預設情況下，指令會鎖定磁碟上的本機核准檔案。使用 `--gateway` 以鎖定閘道器，或使用 `--node` 以鎖定特定節點。

相關：

- Exec 核准：[Exec approvals](/tools/exec-approvals)
- 節點：[Nodes](/nodes)

## 常用指令

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 從檔案取代核准

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 允許清單輔助工具

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 注意事項

- `--node` 使用與 `openclaw nodes` 相同的解析器（id、名稱、ip 或 id 前綴）。
- `--agent` 預設為 `"*"`，此設定會套用至所有代理程式。
- 節點主機必須公告 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。
- 每個主機的核准檔案會儲存在 `~/.openclaw/exec-approvals.json`。
