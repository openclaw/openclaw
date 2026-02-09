---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw config` (get/set/unset ค่าคอนฟิก)"
read_when:
  - คุณต้องการอ่านหรือแก้ไขคอนฟิกแบบไม่โต้ตอบ
title: "config"
---

# `openclaw config`

ตัวช่วยคอนฟิก: get/set/unset ค่าโดยอ้างอิงตามพาธ ตัวช่วยคอนฟิก: get/set/unset ค่าโดยอ้างอิงตามพาธ รันโดยไม่ระบุคำสั่งย่อยเพื่อเปิดวิซาร์ดการตั้งค่า
(เหมือนกับ `openclaw configure`).

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

พาธสามารถใช้รูปแบบจุดหรือวงเล็บได้:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

ใช้ดัชนีของรายการเอเจนต์เพื่อกำหนดเป้าหมายไปยังเอเจนต์เฉพาะ:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

ค่าจะถูกแยกวิเคราะห์เป็นJSON5เมื่อเป็นไปได้ มิฉะนั้นจะถูกจัดการเป็นสตริง
ใช้ `--json` เพื่อบังคับให้แยกวิเคราะห์เป็นJSON5
ใช้ `--json` เพื่อบังคับการพาร์สแบบ JSON5

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

รีสตาร์ทGatewayหลังจากแก้ไขแล้ว
