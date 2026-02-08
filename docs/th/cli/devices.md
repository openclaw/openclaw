---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw devices` (การจับคู่อุปกรณ์+การหมุนเวียน/เพิกถอนโทเคนอุปกรณ์)"
read_when:
  - คุณกำลังอนุมัติคำขอจับคู่อุปกรณ์
  - คุณต้องการหมุนเวียนหรือเพิกถอนโทเคนอุปกรณ์
title: "อุปกรณ์"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:53Z
---

# `openclaw devices`

จัดการคำขอจับคู่อุปกรณ์และโทเคนที่กำหนดขอบเขตต่ออุปกรณ์

## Commands

### `openclaw devices list`

แสดงรายการคำขอจับคู่ที่รอดำเนินการและอุปกรณ์ที่จับคู่แล้ว

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

อนุมัติคำขอจับคู่อุปกรณ์ที่รอดำเนินการ

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

ปฏิเสธคำขอจับคู่อุปกรณ์ที่รอดำเนินการ

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

หมุนเวียนโทเคนอุปกรณ์สำหรับบทบาทที่ระบุ(สามารถอัปเดตขอบเขตได้ตามต้องการ)

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

เพิกถอนโทเคนอุปกรณ์สำหรับบทบาทที่ระบุ

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: URL WebSocket ของ Gateway (ค่าเริ่มต้นเป็น `gateway.remote.url` เมื่อมีการกำหนดค่า)
- `--token <token>`: โทเคนของ Gateway (หากจำเป็น)
- `--password <password>`: รหัสผ่านของ Gateway (การยืนยันตัวตนด้วยรหัสผ่าน)
- `--timeout <ms>`: เวลาหมดอายุของ RPC
- `--json`: เอาต์พุตJSON(แนะนำสำหรับการเขียนสคริปต์)

Note: เมื่อคุณตั้งค่า `--url` แล้ว CLI จะไม่ย้อนกลับไปใช้คอนฟิกหรือข้อมูลรับรองจากตัวแปรสภาพแวดล้อม
โปรดส่ง `--token` หรือ `--password` โดยระบุชัดเจน การขาดข้อมูลรับรองที่ระบุชัดเจนถือเป็นข้อผิดพลาด

## Notes

- การหมุนเวียนโทเคนจะส่งคืนโทเคนใหม่(ข้อมูลอ่อนไหว) ควรปฏิบัติต่อโทเคนนี้เหมือนความลับ
- คำสั่งเหล่านี้ต้องการขอบเขต `operator.pairing` (หรือ `operator.admin`)
