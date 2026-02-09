---
summary: "「openclaw approvals」的 CLI 參考（用於 Gateway 閘道器或節點主機的 exec 核准）"
read_when:
  - You want to edit exec approvals from the CLI
  - 你需要管理 Gateway 閘道器或節點主機上的允許清單
title: "cli/approvals.md"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.

Related:

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
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).
- 每個主機的核准檔案會儲存在 `~/.openclaw/exec-approvals.json`。
