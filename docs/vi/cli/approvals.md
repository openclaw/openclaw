---
summary: "Tài liệu tham chiếu CLI cho `openclaw approvals` (phê duyệt exec cho gateway hoặc máy chủ node)"
read_when:
  - Bạn muốn chỉnh sửa phê duyệt exec từ CLI
  - Bạn cần quản lý danh sách cho phép trên gateway hoặc máy chủ node
title: "approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.

Liên quan:

- Phê duyệt exec: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Các lệnh thường dùng

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Thay thế phê duyệt từ một tệp

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Trợ giúp danh sách cho phép

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Ghi chú

- `--node` dùng cùng bộ phân giải như `openclaw nodes` (id, name, ip, hoặc tiền tố id).
- `--agent` mặc định là `"*"`, áp dụng cho tất cả các tác tử.
- Máy chủ node phải quảng bá `system.execApprovals.get/set` (ứng dụng macOS hoặc máy chủ node headless).
- Tệp phê duyệt được lưu theo từng máy chủ tại `~/.openclaw/exec-approvals.json`.
