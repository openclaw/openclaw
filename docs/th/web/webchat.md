---
summary: "โฮสต์สแตติกของLoopback WebChatและการใช้งานGateway WebSocketสำหรับUIแชต"
read_when:
  - การดีบักหรือการกำหนดค่าการเข้าถึงWebChat
title: "WebChat"
---

# WebChat (Gateway（เกตเวย์） WebSocket UI)

สถานะ: UIแชต SwiftUI บน macOS/iOS สื่อสารโดยตรงกับ Gateway WebSocket

## คืออะไร

- UIแชตแบบเนทีฟสำหรับGateway（ไม่มีเบราว์เซอร์ฝังตัวและไม่มีเซิร์ฟเวอร์สแตติกภายในเครื่อง）
- ใช้เซสชันและกฎการกำหนดเส้นทางเดียวกับช่องทางอื่น
- การกำหนดเส้นทางแบบกำหนดแน่นอน: คำตอบจะถูกส่งกลับไปยังWebChatเสมอ

## เริ่มต้นอย่างรวดเร็ว

1. เริ่มต้น Gateway
2. เปิดUI WebChat（แอปmacOS/iOS）หรือแท็บแชตของUIควบคุม
3. ตรวจสอบให้แน่ใจว่าได้กำหนดค่าการยืนยันตัวตนของGatewayแล้ว（จำเป็นโดยค่าเริ่มต้น แม้บน local loopback）

## ทำงานอย่างไร(พฤติกรรม)

- UIเชื่อมต่อกับGateway WebSocketและใช้ `chat.history`, `chat.send` และ `chat.inject`
- `chat.inject` จะผนวกบันทึกของผู้ช่วยลงในทรานสคริปต์โดยตรงและกระจายไปยังUI（ไม่รันเอเจนต์）
- ประวัติจะถูกดึงจากGatewayเสมอ（ไม่มีการเฝ้าดูไฟล์ภายในเครื่อง）
- หากGatewayไม่สามารถเข้าถึงได้ WebChatจะเป็นแบบอ่านอย่างเดียว

## การใช้งานระยะไกล

- โหมดระยะไกลจะทำอุโมงค์Gateway WebSocketผ่านSSH/Tailscale
- ไม่จำเป็นต้องรันเซิร์ฟเวอร์WebChatแยกต่างหาก

## เอกสารอ้างอิงการกำหนดค่า(WebChat)

การกำหนดค่าแบบเต็ม: [Configuration](/gateway/configuration)

ตัวเลือกของช่องทาง:

- ไม่มีบล็อก `webchat.*` เฉพาะ WebChat ใช้เอ็นด์พอยต์ของเกตเวย์ + การตั้งค่าการยืนยันตัวตนด้านล่าง

ตัวเลือกส่วนกลางที่เกี่ยวข้อง:

- `gateway.port`, `gateway.bind`: โฮสต์/พอร์ตของWebSocket
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: การยืนยันตัวตนของWebSocket
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: เป้าหมายGatewayระยะไกล
- `session.*`: ที่เก็บเซสชันและค่าเริ่มต้นของคีย์หลัก
