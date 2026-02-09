---
summary: "แอปAndroid(โหนด):คู่มือการเชื่อมต่อ+Canvas/แชต/กล้อง"
read_when:
  - การจับคู่หรือเชื่อมต่อโหนดAndroidใหม่
  - การดีบักการค้นหาGatewayหรือการยืนยันตัวตนบนAndroid
  - การตรวจสอบความสอดคล้องของประวัติแชตข้ามไคลเอนต์
title: "แอปAndroid"
---

# Android App (Node)

## ภาพรวมการรองรับ

- บทบาท: แอปโหนดคู่หู(Androidไม่โฮสต์Gateway)
- ต้องมีGateway: ใช่(รันบนmacOS, Linux หรือ Windowsผ่านWSL2)
- ติดตั้ง: [เริ่มต้นใช้งาน](/start/getting-started)+[การจับคู่](/gateway/pairing)
- Gateway: [Runbook](/gateway)+[การกำหนดค่า](/gateway/configuration)
  - โปรโตคอล: [Gateway protocol](/gateway/protocol)(โหนด+control plane)

## การควบคุมระบบ

การควบคุมระบบ(launchd/systemd)อยู่บนโฮสต์Gateway ดูที่[Gateway](/gateway) ดูที่ [Gateway](/gateway)

## คู่มือการเชื่อมต่อ

แอปโหนดAndroid⇄(mDNS/NSD+WebSocket)⇄**Gateway**

Androidเชื่อมต่อโดยตรงกับGateway WebSocket(ค่าเริ่มต้น`ws://<host>:18789`)และใช้การจับคู่ที่เป็นของGateway

### ข้อกำหนดก่อนเริ่มต้น

- สามารถรันGatewayบนเครื่อง“master”
- อุปกรณ์/อีมูเลเตอร์Androidเข้าถึงGateway WebSocketได้:
  - อยู่LANเดียวกันด้วยmDNS/NSD **หรือ**
  - อยู่ในTailscale tailnetเดียวกันโดยใช้Wide-Area Bonjour/unicast DNS-SD(ดูด้านล่าง) **หรือ**
  - ระบุโฮสต์/พอร์ตGatewayด้วยตนเอง(ทางเลือกสำรอง)
- สามารถรันCLI(`openclaw`)บนเครื่องGateway(หรือผ่านSSH)

### 1. เริ่มGateway

```bash
openclaw gateway --port 18789 --verbose
```

ยืนยันในล็อกว่ามีข้อความลักษณะดังนี้:

- `listening on ws://0.0.0.0:18789`

สำหรับการตั้งค่าแบบใช้tailnetเท่านั้น(แนะนำสำหรับVienna⇄London)ให้ผูกGatewayกับIPของtailnet:

- ตั้งค่า`gateway.bind: "tailnet"`ใน`~/.openclaw/openclaw.json`บนโฮสต์Gateway
- รีสตาร์ตGateway/แอปเมนูบาร์บนmacOS

### 2. ตรวจสอบการค้นหา(Optional)

จากเครื่องGateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

บันทึกการดีบักเพิ่มเติม: [Bonjour](/gateway/bonjour)

#### การค้นหาแบบTailnet(Vienna⇄London)ผ่านunicast DNS-SD

การค้นหา Android NSD/mDNS จะไม่ข้ามเครือข่าย การค้นหาAndroid NSD/mDNSไม่ข้ามเครือข่าย หากโหนดAndroidและGatewayอยู่คนละเครือข่ายแต่เชื่อมต่อผ่านTailscale ให้ใช้Wide-Area Bonjour/unicast DNS-SDแทน:

1. ตั้งค่าDNS-SD zone(ตัวอย่าง`openclaw.internal.`)บนโฮสต์Gatewayและเผยแพร่เรคอร์ด`_openclaw-gw._tcp`
2. กำหนดค่าTailscale split DNSสำหรับโดเมนที่เลือกให้ชี้ไปยังDNSเซิร์ฟเวอร์นั้น

รายละเอียดและตัวอย่างคอนฟิกCoreDNS: [Bonjour](/gateway/bonjour)

### 3. เชื่อมต่อจากAndroid

ในแอปAndroid:

- แอปรักษาการเชื่อมต่อGatewayด้วย**foreground service**(มีการแจ้งเตือนถาวร)
- เปิด**Settings**
- ใต้**Discovered Gateways**เลือกGatewayของคุณแล้วกด**Connect**
- หากmDNSถูกบล็อก ให้ใช้**Advanced→Manual Gateway**(โฮสต์+พอร์ต)และ**Connect(Manual)**

หลังการจับคู่สำเร็จครั้งแรก Androidจะเชื่อมต่ออัตโนมัติเมื่อเปิดแอป:

- ปลายทางแบบกำหนดเอง (ถ้าเปิดใช้งาน) มิฉะนั้น
- Gatewayที่ค้นพบล่าสุด(พยายามอย่างดีที่สุด)

### 4. อนุมัติการจับคู่(CLI)

บนเครื่องGateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

รายละเอียดการจับคู่: [Gateway pairing](/gateway/pairing)

### 5. ตรวจสอบว่าโหนดเชื่อมต่อแล้ว

- ผ่านสถานะโหนด:

  ```bash
  openclaw nodes status
  ```

- ผ่านGateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. แชต+ประวัติ

แผ่นแชตของโหนดAndroidใช้**primary session key**ของGateway(`main`)ดังนั้นประวัติและการตอบกลับจะถูกแชร์กับWebChatและไคลเอนต์อื่นๆ:

- ประวัติ: `chat.history`
- ส่ง: `chat.send`
- อัปเดตแบบพุช(พยายามอย่างดีที่สุด): `chat.subscribe`→`event:"chat"`

### 7. Canvas+กล้อง

#### Gateway Canvas Host(แนะนำสำหรับเนื้อหาเว็บ)

หากต้องการให้โหนดแสดงHTML/CSS/JSจริงที่เอเจนต์สามารถแก้ไขบนดิสก์ได้ ให้ชี้โหนดไปที่Gateway canvas host

หมายเหตุ: โหนดใช้standalone canvas hostบน`canvasHost.port`(ค่าเริ่มต้น`18793`)

1. สร้าง`~/.openclaw/workspace/canvas/index.html`บนโฮสต์Gateway

2. นำทางโหนดไปยังที่อยู่นั้น(LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet(ไม่บังคับ): หากอุปกรณ์ทั้งสองอยู่บนTailscale ให้ใช้ชื่อMagicDNSหรือIPของtailnetแทน`.local`เช่น`http://<gateway-magicdns>:18793/__openclaw__/canvas/`

เซิร์ฟเวอร์นี้จะแทรกไคลเอนต์live-reloadลงในHTMLและรีโหลดเมื่อไฟล์เปลี่ยนแปลง
A2UI hostอยู่ที่`http://<gateway-host>:18793/__openclaw__/a2ui/`
โฮสต์ A2UI อยู่ที่ `http://<gateway-host>:18793/__openclaw__/a2ui/`

คำสั่งCanvas(เฉพาะforeground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate`(ใช้`{"url":""}`หรือ`{"url":"/"}`เพื่อกลับสู่scaffoldเริ่มต้น)`canvas.snapshot`คืนค่า`{ format, base64 }`(ค่าเริ่มต้น`format="jpeg"`) `canvas.snapshot` จะคืนค่า `{ format, base64 }` (ค่าเริ่มต้น `format="jpeg"`)
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset`(`canvas.a2ui.pushJSONL`เป็นชื่อแทนแบบlegacy)

คำสั่งกล้อง(เฉพาะforeground;ต้องมีสิทธิ์):

- `camera.snap`(jpg)
- `camera.clip`(mp4)

ดู[Camera node](/nodes/camera)สำหรับพารามิเตอร์และตัวช่วยCLI
