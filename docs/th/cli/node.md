---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw node` (โฮสต์โหนดแบบไร้ส่วนติดต่อ)"
read_when:
  - เมื่อรันโฮสต์โหนดแบบไร้ส่วนติดต่อ
  - การจับคู่โหนดที่ไม่ใช่macOSสำหรับ system.run
title: "node"
---

# `openclaw node`

รัน **โฮสต์โหนดแบบไร้ส่วนติดต่อ** ที่เชื่อมต่อกับ Gateway WebSocket และเปิดให้ใช้งาน
`system.run` / `system.which` บนเครื่องนี้

## ทำไมต้องใช้โฮสต์โหนด?

ใช้โฮสต์โหนดเมื่อคุณต้องการให้เอเจนต์ **รันคำสั่งบนเครื่องอื่น** ในเครือข่ายของคุณ
โดยไม่ต้องติดตั้งแอปคู่หูmacOSแบบเต็มบนเครื่องเหล่านั้น

กรณีใช้งานทั่วไป:

- รันคำสั่งบนเครื่อง Linux/Windows ระยะไกล (เซิร์ฟเวอร์บิลด์ เครื่องแล็บ NAS)
- คงการรัน exec ให้เป็น **sandboxed** บนเกตเวย์ แต่กระจายงานที่ได้รับอนุมัติไปยังโฮสต์อื่น
- จัดเตรียมเป้าหมายการรันแบบเบา ไร้ส่วนติดต่อ สำหรับออโตเมชันหรือโหนด CI

การรันยังคงถูกควบคุมด้วย **exec approvals** และ allowlist ต่อเอเจนต์บนโฮสต์โหนด
เพื่อให้การเข้าถึงคำสั่งมีขอบเขตและชัดเจน

## Browser proxy (zero-config)

โฮสต์โหนดจะประกาศ browser proxy โดยอัตโนมัติหาก `browser.enabled` ไม่ได้ถูกปิดใช้งานบนโหนด
ซึ่งช่วยให้เอเจนต์ใช้การทำงานอัตโนมัติของเบราว์เซอร์บนโหนดนั้นได้โดยไม่ต้องตั้งค่าเพิ่มเติม สิ่งนี้ทำให้เอเจนต์สามารถใช้ระบบอัตโนมัติของเบราว์เซอร์บนโหนดนั้นได้
โดยไม่ต้องตั้งค่าเพิ่มเติม

หากจำเป็น สามารถปิดใช้งานบนโหนดได้ดังนี้:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Run (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

ตัวเลือก:

- `--host <host>`: โฮสต์Gateway WebSocket (ค่าเริ่มต้น: `127.0.0.1`)
- `--port <port>`: พอร์ตGateway WebSocket (ค่าเริ่มต้น: `18789`)
- `--tls`: ใช้ TLS สำหรับการเชื่อมต่อกับเกตเวย์
- `--tls-fingerprint <sha256>`: ลายนิ้วมือใบรับรอง TLS ที่คาดหวัง (sha256)
- `--node-id <id>`: แทนที่ node id (ล้างโทเคนการจับคู่)
- `--display-name <name>`: แทนที่ชื่อแสดงผลของโหนด

## Service (background)

ติดตั้งโฮสต์โหนดแบบไร้ส่วนติดต่อเป็นบริการระดับผู้ใช้

```bash
openclaw node install --host <gateway-host> --port 18789
```

ตัวเลือก:

- `--host <host>`: โฮสต์Gateway WebSocket (ค่าเริ่มต้น: `127.0.0.1`)
- `--port <port>`: พอร์ตGateway WebSocket (ค่าเริ่มต้น: `18789`)
- `--tls`: ใช้ TLS สำหรับการเชื่อมต่อกับเกตเวย์
- `--tls-fingerprint <sha256>`: ลายนิ้วมือใบรับรอง TLS ที่คาดหวัง (sha256)
- `--node-id <id>`: แทนที่ node id (ล้างโทเคนการจับคู่)
- `--display-name <name>`: แทนที่ชื่อแสดงผลของโหนด
- `--runtime <runtime>`: รันไทม์ของบริการ (`node` หรือ `bun`)
- `--force`: ติดตั้งใหม่/เขียนทับหากติดตั้งไว้แล้ว

จัดการบริการ:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

ใช้ `openclaw node run` สำหรับโฮสต์โหนดแบบ foreground (ไม่ใช้บริการ)

คำสั่งบริการรองรับ `--json` สำหรับเอาต์พุตที่อ่านได้โดยเครื่อง

## Pairing

การเชื่อมต่อครั้งแรกจะสร้างคำขอจับคู่โหนดที่รอดำเนินการบน Gateway
อนุมัติได้ผ่าน:
อนุมัติผ่าน:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

โฮสต์โหนดจะจัดเก็บ node id, โทเคน, ชื่อแสดงผล และข้อมูลการเชื่อมต่อกับเกตเวย์ไว้ใน
`~/.openclaw/node.json`

## Exec approvals

`system.run` ถูกควบคุมด้วยการอนุมัติการรันคำสั่งในเครื่อง:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (แก้ไขจาก Gateway)
