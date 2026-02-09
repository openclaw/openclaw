---
summary: "แอปโหนด iOS: เชื่อมต่อกับ Gateway, การจับคู่, แคนวาส และการแก้ไขปัญหา"
read_when:
  - การจับคู่หรือเชื่อมต่อโหนด iOS ใหม่อีกครั้ง
  - การรันแอป iOS จากซอร์สโค้ด
  - การดีบักการค้นหาGatewayหรือคำสั่งแคนวาส
title: "แอป iOS"
---

# แอป iOS (โหนด)

สถานะความพร้อมใช้งาน: พรีวิวภายใน สถานะการใช้งาน: ตัวอย่างภายใน แอป iOS ยังไม่เปิดแจกจ่ายสาธารณะ

## ทำอะไรได้บ้าง

- เชื่อมต่อกับ Gateway ผ่าน WebSocket (LAN หรือ tailnet)
- เปิดเผยความสามารถของโหนด: Canvas, ภาพหน้าจอ, การจับภาพจากกล้อง, ตำแหน่งที่ตั้ง, โหมดสนทนา, การปลุกด้วยเสียง
- รับคำสั่ง `node.invoke` และรายงานอีเวนต์สถานะของโหนด

## ข้อกำหนด

- Gateway ต้องรันอยู่บนอุปกรณ์อื่น (macOS, Linux หรือ Windows ผ่าน WSL2)
- เส้นทางเครือข่าย:
  - LAN เดียวกันผ่าน Bonjour **หรือ**
  - tailnet ผ่าน unicast DNS-SD (ตัวอย่างโดเมน: `openclaw.internal.`) **หรือ**
  - ระบุโฮสต์/พอร์ตด้วยตนเอง (ทางเลือกสำรอง)

## เริ่มต้นอย่างรวดเร็ว (จับคู่ + เชื่อมต่อ)

1. เริ่มต้น Gateway:

```bash
openclaw gateway --port 18789
```

2. ในแอป iOS เปิด Settings และเลือกGatewayที่ค้นพบ (หรือเปิดใช้ Manual Host และกรอกโฮสต์/พอร์ต)

3. อนุมัติคำขอการจับคู่บนโฮสต์Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. ตรวจสอบการเชื่อมต่อ:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## เส้นทางการค้นหา

### Bonjour (LAN)

Gateway จะประกาศ `_openclaw-gw._tcp` บน `local.` แอป iOS จะแสดงรายการเหล่านี้โดยอัตโนมัติ

### Tailnet (ข้ามเครือข่าย)

หาก mDNS ถูกบล็อก ให้ใช้โซน unicast DNS-SD (เลือกโดเมน; ตัวอย่าง: `openclaw.internal.`) และ Tailscale split DNS
ดู [Bonjour](/gateway/bonjour) สำหรับตัวอย่าง CoreDNS
ดู [Bonjour](/gateway/bonjour) สำหรับตัวอย่าง CoreDNS

### ระบุโฮสต์/พอร์ตด้วยตนเอง

ใน Settings ให้เปิด **Manual Host** และกรอกโฮสต์Gatewayพร้อมพอร์ต (ค่าเริ่มต้น `18789`)

## Canvas + A2UI

โหนด iOS เรนเดอร์แคนวาสด้วย WKWebView ใช้ `node.invoke` เพื่อควบคุม: ใช้ `node.invoke` เพื่อควบคุมการทำงาน:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

หมายเหตุ:

- โฮสต์แคนวาสของGatewayให้บริการ `/__openclaw__/canvas/` และ `/__openclaw__/a2ui/`
- โหนด iOS จะนำทางไปยัง A2UI โดยอัตโนมัติเมื่อเชื่อมต่อ หากมีการประกาศ URL ของโฮสต์แคนวาส
- กลับไปยัง scaffold ที่มีมาให้ด้วย `canvas.navigate` และ `{"url":""}`

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + โหมดสนทนา

- Voice wake และโหมดสนทนาสามารถเปิดใช้ได้ใน Settings
- iOS อาจระงับเสียงพื้นหลัง ให้ถือว่าฟีเจอร์เสียงเป็นแบบ best-effort เมื่อแอปไม่ได้ทำงานอยู่เบื้องหน้า

## ข้อผิดพลาดที่พบบ่อย

- `NODE_BACKGROUND_UNAVAILABLE`: นำแอป iOS ขึ้นมาที่เบื้องหน้า (คำสั่งแคนวาส/กล้อง/หน้าจอต้องการสิ่งนี้)
- `A2UI_HOST_NOT_CONFIGURED`: Gateway ไม่ได้ประกาศ URL ของโฮสต์แคนวาส ให้ตรวจสอบ `canvasHost` ใน [การกำหนดค่าGateway](/gateway/configuration)
- ไม่ปรากฏหน้าต่างจับคู่: รัน `openclaw nodes pending` และอนุมัติด้วยตนเอง
- เชื่อมต่อใหม่ไม่สำเร็จหลังติดตั้งใหม่: โทเคนการจับคู่ใน Keychain ถูกลบแล้ว ให้จับคู่โหนดใหม่

## เอกสารที่เกี่ยวข้อง

- [การจับคู่](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
