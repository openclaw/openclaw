---
summary: "การค้นพบ Bonjour/mDNS + การดีบัก (บีคอนของGateway ไคลเอนต์ และโหมดความล้มเหลวที่พบบ่อย)"
read_when:
  - การดีบักปัญหาการค้นพบ Bonjour บน macOS/iOS
  - การเปลี่ยนชนิดบริการ mDNS ระเบียน TXT หรือ UX การค้นพบ
title: "การค้นพบด้วย Bonjour"
---

# การค้นพบด้วย Bonjour / mDNS

OpenClaw ใช้ Bonjour (mDNS / DNS‑SD) เป็น **ความสะดวกเฉพาะภายในLAN** เพื่อค้นหา
Gateway ที่กำลังทำงานอยู่ (ปลายทาง WebSocket) เป็นแบบพยายามอย่างดีที่สุด และ **ไม่**
ใช้แทนการเชื่อมต่อผ่าน SSH หรือ Tailnet It is best‑effort and does **not** replace SSH or
Tailnet-based connectivity.

## Bonjour แบบเครือข่ายกว้าง (Unicast DNS‑SD) ผ่าน Tailscale

If the node and gateway are on different networks, multicast mDNS won’t cross the
boundary. หากโหนดและGateway อยู่คนละเครือข่าย การมัลติคาสต์ mDNS จะไม่ข้ามขอบเขตเครือข่าย
คุณสามารถคง UX การค้นหาเดิมได้โดยสลับไปใช้ **unicast DNS‑SD**
("Wide‑Area Bonjour") ผ่าน Tailscale

ขั้นตอนระดับสูง:

1. รันเซิร์ฟเวอร์ DNS บนโฮสต์Gateway (เข้าถึงได้ผ่าน Tailnet)
2. เผยแพร่ระเบียน DNS‑SD สำหรับ `_openclaw-gw._tcp` ภายใต้โซนเฉพาะ
   (ตัวอย่าง: `openclaw.internal.`)
3. ตั้งค่า **split DNS** ของ Tailscale เพื่อให้โดเมนที่เลือกแก้ชื่อผ่าน
   เซิร์ฟเวอร์ DNS นั้นสำหรับไคลเอนต์ (รวมถึง iOS)

OpenClaw รองรับโดเมนการค้นหาใดๆ; `openclaw.internal.` เป็นเพียงตัวอย่าง
โหนด iOS/Android จะเรียกดูทั้ง `local.` และโดเมนแบบเครือข่ายกว้างที่คุณตั้งค่า
iOS/Android nodes browse both `local.` and your configured wide‑area domain.

### คอนฟิกGateway (แนะนำ)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### การตั้งค่าเซิร์ฟเวอร์ DNS แบบครั้งเดียว (โฮสต์Gateway)

```bash
openclaw dns setup --apply
```

การตั้งค่านี้จะติดตั้ง CoreDNS และกำหนดค่าให้:

- รับฟังพอร์ต 53 เฉพาะบนอินเทอร์เฟซ Tailscale ของGateway
- ให้บริการโดเมนที่เลือก (ตัวอย่าง: `openclaw.internal.`) จาก `~/.openclaw/dns/<domain>.db`

ตรวจสอบจากเครื่องที่เชื่อมต่อ tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### การตั้งค่า DNS ของ Tailscale

ในคอนโซลผู้ดูแล Tailscale:

- เพิ่ม nameserver ที่ชี้ไปยัง IP tailnet ของGateway (UDP/TCP 53)
- เพิ่ม split DNS เพื่อให้โดเมนการค้นหาของคุณใช้ nameserver นั้น

เมื่อไคลเอนต์ยอมรับ DNS ของ tailnet แล้ว โหนด iOS จะสามารถเรียกดู
`_openclaw-gw._tcp` ภายในโดเมนการค้นหาของคุณได้โดยไม่ต้องใช้มัลติคาสต์

### ความปลอดภัยของตัวรับฟังGateway (แนะนำ)

พอร์ต WS ของGateway (ค่าเริ่มต้น `18789`) จะผูกกับ loopback โดยค่าเริ่มต้น
สำหรับการเข้าถึงแบบ LAN/tailnet ให้ผูกแบบชัดเจนและคงการยืนยันตัวตนไว้ For LAN/tailnet
access, bind explicitly and keep auth enabled.

สำหรับการตั้งค่าเฉพาะ tailnet:

- ตั้งค่า `gateway.bind: "tailnet"` ใน `~/.openclaw/openclaw.json`.
- รีสตาร์ทGateway (หรือรีสตาร์ทแอป menubar บน macOS)

## สิ่งที่โฆษณา

มีเพียงGateway เท่านั้นที่โฆษณา `_openclaw-gw._tcp`.

## ชนิดบริการ

- `_openclaw-gw._tcp` — บีคอนทรานสปอร์ตของGateway (ใช้โดยโหนด macOS/iOS/Android)

## คีย์ TXT (คำใบ้ที่ไม่เป็นความลับ)

Gateway จะโฆษณาคำใบ้ขนาดเล็กที่ไม่เป็นความลับเพื่อให้โฟลว์ UI สะดวก:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (เฉพาะเมื่อเปิดใช้ TLS)
- `gatewayTlsSha256=<sha256>` (เฉพาะเมื่อเปิดใช้ TLS และมีลายนิ้วมือ)
- `canvasPort=<port>` (เฉพาะเมื่อเปิดใช้งานโฮสต์ canvas; ค่าเริ่มต้น `18793`)
- `sshPort=<port>` (ค่าเริ่มต้นคือ 22 เมื่อไม่ถูกแทนที่)
- `transport=gateway`
- `cliPath=<path>` (ไม่บังคับ; พาธแบบสัมบูรณ์ไปยังเอนทรีพอยต์ `openclaw` ที่รันได้)
- `tailnetDns=<magicdns>` (คำใบ้ไม่บังคับเมื่อมี Tailnet ให้ใช้งาน)

## การดีบักบน macOS

เครื่องมือที่มีมาให้และมีประโยชน์:

- เรียกดูอินสแตนซ์:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- แก้ชื่ออินสแตนซ์หนึ่งรายการ (แทนที่ `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

หากการเรียกดูใช้งานได้แต่การแก้ชื่อไม่สำเร็จ โดยทั่วไปมักเป็นนโยบาย LAN หรือปัญหาตัวแก้ชื่อ mDNS

## การดีบักในล็อกของGateway

Gateway จะเขียนไฟล์ล็อกแบบหมุนเวียน (พิมพ์ตำแหน่งเมื่อเริ่มต้นเป็น
`gateway log file: ...`). มองหาบรรทัด `bonjour:` โดยเฉพาะ:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## การดีบักบนโหนด iOS

โหนด iOS ใช้ `NWBrowser` เพื่อค้นหา `_openclaw-gw._tcp`.

To capture logs:

- การตั้งค่า → Gateway → ขั้นสูง → **Discovery Debug Logs**
- การตั้งค่า → Gateway → ขั้นสูง → **Discovery Logs** → ทำซ้ำขั้นตอน → **คัดลอก**

ล็อกจะรวมการเปลี่ยนสถานะของเบราว์เซอร์และการเปลี่ยนแปลงชุดผลลัพธ์

## โหมดความล้มเหลวที่พบบ่อย

- **Bonjour ไม่ข้ามเครือข่าย**: ใช้ Tailnet หรือ SSH
- **มัลติคาสต์ถูกบล็อก**: เครือข่าย Wi‑Fi บางแห่งปิดใช้งาน mDNS
- **สลีป / การเปลี่ยนอินเทอร์เฟซ**: macOS อาจทำให้ผลลัพธ์ mDNS หายไปชั่วคราว; ลองใหม่
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. **เรียกดูได้แต่แก้ชื่อไม่สำเร็จ**: ตั้งชื่อเครื่องให้ง่าย (หลีกเลี่ยงอีโมจิหรือ
  เครื่องหมายวรรคตอน) แล้วรีสตาร์ทGateway ชื่ออินสแตนซ์ของบริการมาจาก
  ชื่อโฮสต์ ดังนั้นชื่อที่ซับซ้อนเกินไปอาจทำให้ตัวแก้ชื่อบางตัวสับสน

## ชื่ออินสแตนซ์ที่ถูก escape (`\032`)

Bonjour/DNS‑SD มักจะ escape ไบต์ในชื่ออินสแตนซ์ของบริการเป็นลำดับทศนิยม `\DDD`
(เช่น ช่องว่างจะกลายเป็น `\032`)

- เป็นเรื่องปกติในระดับโปรโตคอล
- UI ควรถอดรหัสเพื่อแสดงผล (iOS ใช้ `BonjourEscapes.decode`)

## การปิดใช้งาน / การกำหนดค่า

- `OPENCLAW_DISABLE_BONJOUR=1` ปิดการโฆษณา (แบบเดิม: `OPENCLAW_DISABLE_BONJOUR`)
- `gateway.bind` ใน `~/.openclaw/openclaw.json` ควบคุมโหมดการผูกของGateway
- `OPENCLAW_SSH_PORT` แทนที่พอร์ต SSH ที่โฆษณาใน TXT (แบบเดิม: `OPENCLAW_SSH_PORT`)
- `OPENCLAW_TAILNET_DNS` เผยแพร่คำใบ้ MagicDNS ใน TXT (แบบเดิม: `OPENCLAW_TAILNET_DNS`)
- `OPENCLAW_CLI_PATH` แทนที่พาธ CLI ที่โฆษณา (แบบเดิม: `OPENCLAW_CLI_PATH`)

## เอกสารที่เกี่ยวข้อง

- นโยบายการค้นพบและการเลือกทรานสปอร์ต: [Discovery](/gateway/discovery)
- การจับคู่โหนด + การอนุมัติ: [Gateway pairing](/gateway/pairing)
