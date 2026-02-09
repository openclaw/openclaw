---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw approvals` (การอนุมัติการรันคำสั่งสำหรับGatewayหรือโฮสต์โหนด)"
read_when:
  - คุณต้องการแก้ไขการอนุมัติการรันคำสั่งจากCLI
  - คุณต้องการจัดการรายการอนุญาตบนโฮสต์Gatewayหรือโฮสต์โหนด
title: "approvals"
---

# `openclaw approvals`

จัดการการอนุมัติการรันคำสั่งสำหรับ **โฮสต์ภายในเครื่อง**, **โฮสต์Gateway**, หรือ **โฮสต์โหนด**
โดยค่าเริ่มต้น คำสั่งจะกำหนดเป้าหมายไปที่ไฟล์การอนุมัติภายในเครื่องบนดิสก์ ใช้ `--gateway` เพื่อกำหนดเป้าหมายไปที่Gateway หรือใช้ `--node` เพื่อกำหนดเป้าหมายไปที่โหนดที่ระบุ
ตามค่าเริ่มต้น คำสั่งจะชี้ไปยังไฟล์ approvals แบบโลคัลบนดิสก์ ใช้ `--gateway` เพื่อชี้ไปยังเกตเวย์ หรือ `--node` เพื่อชี้ไปยังโหนดที่ระบุ

เกี่ยวข้อง:

- การอนุมัติการรันคำสั่ง: [Exec approvals](/tools/exec-approvals)
- โหนด: [Nodes](/nodes)

## คำสั่งที่ใช้บ่อย

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## แทนที่การอนุมัติจากไฟล์

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## ตัวช่วยสำหรับรายการอนุญาต

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## หมายเหตุ

- `--node` ใช้ตัวแก้ไขเดียวกันกับ `openclaw nodes` (id, name, ip หรือคำนำหน้าid)
- `--agent` มีค่าเริ่มต้นเป็น `"*"` ซึ่งมีผลกับเอเจนต์ทั้งหมด
- โฮสต์โหนดต้องโฆษณา `system.execApprovals.get/set` (แอปmacOSหรือโฮสต์โหนดแบบไม่ต้องมีหัว)
- ไฟล์การอนุมัติจะถูกจัดเก็บแยกตามโฮสต์ที่ `~/.openclaw/exec-approvals.json`
