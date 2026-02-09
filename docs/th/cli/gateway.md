---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — รัน สอบถาม และค้นหาเกตเวย์"
read_when:
  - การรันGatewayจากCLI(สำหรับdevหรือเซิร์ฟเวอร์)
  - การดีบักการยืนยันตัวตน โหมดการ bind และการเชื่อมต่อของGateway
  - การค้นหาเกตเวย์ผ่านBonjour(LAN+tailnet)
title: "gateway"
---

# Gateway CLI

GatewayคือWebSocketเซิร์ฟเวอร์ของOpenClaw(ช่องทาง โหนด เซสชัน ฮุค)

คำสั่งย่อยในหน้านี้อยู่ภายใต้ `openclaw gateway …`.

เอกสารที่เกี่ยวข้อง:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## รัน Gateway

รันกระบวนการGatewayภายในเครื่อง:

```bash
openclaw gateway
```

นามแฝงแบบโฟร์กราวด์:

```bash
openclaw gateway run
```

หมายเหตุ:

- โดยค่าเริ่มต้นGatewayจะปฏิเสธการเริ่มต้นหากไม่ได้ตั้งค่า `gateway.mode=local` ใน `~/.openclaw/openclaw.json`. ใช้ `--allow-unconfigured` สำหรับการรันแบบชั่วคราว/โหมดdev
- การ bind เกินกว่า loopback โดยไม่มีการยืนยันตัวตนจะถูกบล็อก(ราวกันความปลอดภัย)
- `SIGUSR1` จะทริกเกอร์การรีสตาร์ตภายในโปรเซสเมื่อได้รับอนุญาต(เปิด `commands.restart` หรือใช้เครื่องมือ/คอนฟิก apply/update ของgateway)
- ตัวจัดการ `SIGINT`/`SIGTERM` จะหยุดโปรเซสgateway แต่จะไม่กู้คืนสถานะเทอร์มินัลที่กำหนดเอง หากคุณห่อหุ้มCLIด้วยTUIหรืออินพุตโหมดดิบ ให้คืนค่าเทอร์มินัลก่อนออก หากคุณห่อ CLI ด้วย TUI หรืออินพุตโหมดดิบ ให้กู้คืนสถานะเทอร์มินัลก่อนออก

### ตัวเลือก

- `--port <port>`: พอร์ตWebSocket(ค่าเริ่มต้นมาจากคอนฟิก/ตัวแปรสภาพแวดล้อม โดยปกติคือ `18789`)
- `--bind <loopback|lan|tailnet|auto|custom>`: โหมดการ bind ของตัวรับฟัง
- `--auth <token|password>`: บังคับโหมดการยืนยันตัวตน
- `--token <token>`: บังคับโทเคน(และตั้งค่า `OPENCLAW_GATEWAY_TOKEN` สำหรับโปรเซสด้วย)
- `--password <password>`: บังคับรหัสผ่าน(และตั้งค่า `OPENCLAW_GATEWAY_PASSWORD` สำหรับโปรเซสด้วย)
- `--tailscale <off|serve|funnel>`: เปิดเผยGatewayผ่านTailscale
- `--tailscale-reset-on-exit`: รีเซ็ตคอนฟิกTailscale serve/funnel เมื่อปิดเครื่อง
- `--allow-unconfigured`: อนุญาตให้เริ่มGatewayโดยไม่มี `gateway.mode=local` ในคอนฟิก
- `--dev`: สร้างคอนฟิกdev+เวิร์กสเปซหากยังไม่มี(ข้าม BOOTSTRAP.md)
- `--reset`: รีเซ็ตคอนฟิกdev+ข้อมูลรับรอง+เซสชัน+เวิร์กสเปซ(ต้องใช้ `--dev`)
- `--force`: ปิดตัวรับฟังที่มีอยู่บนพอร์ตที่เลือกก่อนเริ่ม
- `--verbose`: ล็อกแบบละเอียด
- `--claude-cli-logs`: แสดงเฉพาะล็อกของclaude-cliในคอนโซล(และเปิด stdout/stderr ของมัน)
- `--ws-log <auto|full|compact>`: รูปแบบล็อกwebsocket(ค่าเริ่มต้น `auto`)
- `--compact`: นามแฝงสำหรับ `--ws-log compact`
- `--raw-stream`: บันทึกอีเวนต์สตรีมดิบของโมเดลเป็น jsonl
- `--raw-stream-path <path>`: พาธของ raw stream jsonl

## สอบถามGatewayที่กำลังรันอยู่

คำสั่งสอบถามทั้งหมดใช้WebSocket RPC

โหมดเอาต์พุต:

- ค่าเริ่มต้น: อ่านง่ายสำหรับมนุษย์(มีสีเมื่อเป็นTTY)
- `--json`: JSONที่อ่านโดยเครื่อง(ไม่มีสไตล์/สปินเนอร์)
- `--no-color`(หรือ `NO_COLOR=1`): ปิดANSIแต่คงเลย์เอาต์แบบมนุษย์

ตัวเลือกที่ใช้ร่วมกัน(เมื่อรองรับ):

- `--url <url>`: URLของGateway WebSocket
- `--token <token>`: โทเคนGateway
- `--password <password>`: รหัสผ่านGateway
- `--timeout <ms>`: timeout/งบประมาณ(แตกต่างตามคำสั่ง)
- `--expect-final`: รอการตอบกลับแบบ“final”(การเรียกเอเจนต์)

หมายเหตุ: เมื่อคุณตั้งค่า `--url` แล้วCLIจะไม่ย้อนกลับไปใช้ข้อมูลรับรองจากคอนฟิกหรือสภาพแวดล้อม
ต้องส่ง `--token` หรือ `--password` อย่างชัดเจน การขาดข้อมูลรับรองที่ระบุชัดถือเป็นข้อผิดพลาด
Pass `--token` or `--password` explicitly. การขาดข้อมูลรับรองที่ระบุอย่างชัดเจนถือเป็นข้อผิดพลาด

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` แสดงบริการGateway(launchd/systemd/schtasks) พร้อมการโพรบRPCเสริม

```bash
openclaw gateway status
openclaw gateway status --json
```

ตัวเลือก:

- `--url <url>`: บังคับ URL สำหรับโพรบ
- `--token <token>`: การยืนยันตัวตนด้วยโทเคนสำหรับโพรบ
- `--password <password>`: การยืนยันตัวตนด้วยรหัสผ่านสำหรับโพรบ
- `--timeout <ms>`: timeout ของโพรบ(ค่าเริ่มต้น `10000`)
- `--no-probe`: ข้ามการโพรบRPC(ดูเฉพาะบริการ)
- `--deep`: สแกนบริการระดับระบบด้วย

### `gateway probe`

`gateway probe` คือคำสั่ง“ดีบักทุกอย่าง” มันจะโพรบเสมอ: It always probes:

- เกตเวย์ระยะไกลที่คุณตั้งค่าไว้(ถ้ามี) และ
- localhost(loopback) **แม้จะตั้งค่ารีโมตไว้แล้ว**

หากสามารถเข้าถึงเกตเวย์ได้หลายตัว จะพิมพ์แสดงทั้งหมด หากเข้าถึงเกตเวย์ได้หลายตัว มันจะแสดงทั้งหมด รองรับหลายเกตเวย์เมื่อคุณใช้โปรไฟล์/พอร์ตที่แยกกัน(เช่นบอตกู้ภัย) แต่การติดตั้งส่วนใหญ่ยังคงรันเกตเวย์เดียว

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### รีโมตผ่านSSH(ความเท่าเทียมกับแอปMac)

โหมด“Remote over SSH”ของแอปmacOSใช้การทำพอร์ตฟอร์เวิร์ดในเครื่อง เพื่อให้เกตเวย์ระยะไกล(ซึ่งอาจ bind แค่ loopback) เข้าถึงได้ที่ `ws://127.0.0.1:<port>`.

เทียบเท่าในCLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

ตัวเลือก:

- `--ssh <target>`: `user@host` หรือ `user@host:port`(พอร์ตค่าเริ่มต้นคือ `22`)
- `--ssh-identity <path>`: ไฟล์ identity
- `--ssh-auto`: เลือกโฮสต์Gatewayที่ค้นพบเป็นอันดับแรกเป็นเป้าหมายSSH(LAN/WABเท่านั้น)

คอนฟิก(ไม่บังคับ ใช้เป็นค่าเริ่มต้น):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

ตัวช่วยRPCระดับล่าง

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## จัดการบริการGateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

หมายเหตุ:

- `gateway install` รองรับ `--port`, `--runtime`, `--token`, `--force`, `--json`.
- คำสั่งวงจรชีวิตรับ `--json` สำหรับงานสคริปต์

## ค้นหาเกตเวย์(Bonjour)

`gateway discover` สแกนหาบีคอนของGateway(`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD(Wide-Area Bonjour): เลือกโดเมน(ตัวอย่าง: `openclaw.internal.`) และตั้งค่า split DNS + เซิร์ฟเวอร์DNS ดู [/gateway/bonjour](/gateway/bonjour)

เฉพาะเกตเวย์ที่เปิดใช้การค้นพบผ่านBonjour(ค่าเริ่มต้น)เท่านั้นที่จะประกาศบีคอน

เรคคอร์ดการค้นพบแบบWide-Areaประกอบด้วย(TXT):

- `role`(คำใบ้บทบาทของgateway)
- `transport`(คำใบ้ทรานสปอร์ต เช่น `gateway`)
- `gatewayPort`(พอร์ตWebSocket โดยปกติคือ `18789`)
- `sshPort`(พอร์ตSSH; ค่าเริ่มต้นคือ `22` หากไม่มี)
- `tailnetDns`(ชื่อโฮสต์MagicDNS เมื่อมี)
- `gatewayTls`/`gatewayTlsSha256`(เปิดใช้TLS+ลายนิ้วมือใบรับรอง)
- `cliPath`(คำใบ้เสริมสำหรับการติดตั้งแบบรีโมต)

### `gateway discover`

```bash
openclaw gateway discover
```

ตัวเลือก:

- `--timeout <ms>`: timeout ต่อคำสั่ง(browse/resolve); ค่าเริ่มต้น `2000`.
- `--json`: เอาต์พุตที่อ่านโดยเครื่อง(และปิดสไตล์/สปินเนอร์)

ตัวอย่าง:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
