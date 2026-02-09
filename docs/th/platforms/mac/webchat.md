---
summary: "แอปmacฝังGateway WebChatอย่างไรและวิธีดีบัก"
read_when:
  - การดีบักมุมมองWebChatบนmacหรือพอร์ตloopback
title: "WebChat"
---

# WebChat (แอปmacOS)

แอปแถบเมนูของmacOSฝังUIของWebChatเป็นมุมมองSwiftUIแบบเนทีฟ โดยเชื่อมต่อกับGatewayและใช้ค่าเริ่มต้นเป็น**เซสชันหลัก**สำหรับเอเจนต์ที่เลือก(มีตัวสลับเซสชันสำหรับเซสชันอื่น) มัน
เชื่อมต่อกับ Gateway และตั้งค่าเริ่มต้นเป็น **เซสชันหลัก** สำหรับเอเจนต์ที่เลือก (มีตัวสลับเซสชันสำหรับเซสชันอื่น)

- **โหมดLocal**: เชื่อมต่อโดยตรงกับGateway WebSocketในเครื่อง
- **โหมดRemote**: ส่งต่อพอร์ตควบคุมของGatewayผ่านอุโมงค์SSHและใช้อุโมงค์นั้นเป็นdata plane

## การเปิดใช้งานและการดีบัก

- ด้วยตนเอง: เมนูLobster → “Open Chat”

- เปิดอัตโนมัติเพื่อการทดสอบ:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- บันทึกล็อก: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`)

## วิธีการเชื่อมต่อ

- Data plane: เมธอดGateway WS `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` และอีเวนต์ `chat`, `agent`, `presence`, `tick`, `health`
- เซสชัน: ค่าเริ่มต้นเป็นเซสชันหลัก (`main` หรือ `global` เมื่อขอบเขตเป็น
  global) UIสามารถสลับระหว่างเซสชันได้ UI สามารถสลับระหว่างเซสชันได้
- การเริ่มต้นใช้งานครั้งแรกใช้งานเซสชันเฉพาะเพื่อแยกการตั้งค่าในครั้งแรกออกจากกัน

## พื้นผิวด้านความปลอดภัย

- โหมดRemoteส่งต่อเฉพาะพอร์ตควบคุมGateway WebSocketผ่านSSH

## ข้อจำกัดที่ทราบ

- UIได้รับการปรับให้เหมาะกับเซสชันแชต(ไม่ใช่sandboxของเบราว์เซอร์เต็มรูปแบบ)
