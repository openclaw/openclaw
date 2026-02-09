---
summary: "คู่มือการตั้งค่าสำหรับนักพัฒนาที่ทำงานกับแอป OpenClaw บน macOS"
read_when:
  - การตั้งค่าสภาพแวดล้อมการพัฒนาบน macOS
title: "การตั้งค่าสำหรับนักพัฒนา macOS"
---

# การตั้งค่าสำหรับนักพัฒนา macOS

คู่มือนี้ครอบคลุมขั้นตอนที่จำเป็นในการสร้างและรันแอป OpenClaw บน macOS จากซอร์สโค้ด

## ข้อกำหนดก่อนเริ่มต้น

ก่อนสร้างแอป โปรดตรวจสอบว่าคุณได้ติดตั้งสิ่งต่อไปนี้แล้ว:

1. **Xcode 26.2+**: จำเป็นสำหรับการพัฒนาด้วย Swift
2. **Node.js 22+ และ pnpm**: จำเป็นสำหรับ Gateway, CLI และสคริปต์การแพ็กเกจ

## 1) ติดตั้ง Dependencies

ติดตั้ง dependencies ที่ใช้ร่วมกันทั้งโปรเจกต์:

```bash
pnpm install
```

## 2. สร้างและแพ็กเกจแอป

เพื่อสร้างแอป macOS และแพ็กเกจเป็น `dist/OpenClaw.app` ให้รัน:

```bash
./scripts/package-mac-app.sh
```

หากคุณไม่มีใบรับรอง Apple Developer ID สคริปต์จะใช้ **ad-hoc signing** (`-`) โดยอัตโนมัติ

สำหรับโหมดการรันสำหรับการพัฒนา ตัวเลือกการเซ็น และการแก้ไขปัญหา Team ID โปรดดู README ของแอป macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **หมายเหตุ**: แอปที่เซ็นแบบ ad-hoc อาจทำให้เกิดพรอมต์ด้านความปลอดภัย หากแอปแครชทันทีพร้อมข้อความ "Abort trap 6" โปรดดูส่วน [การแก้ไขปัญหา](#troubleshooting) 9. หากแอปแครชทันทีพร้อมข้อความ "Abort trap 6" ให้ดูส่วน [Troubleshooting](#troubleshooting)

## 3. ติดตั้ง CLI

แอป macOS คาดหวังให้มีการติดตั้ง `openclaw` CLI แบบ global เพื่อจัดการงานเบื้องหลัง

**วิธีติดตั้ง (แนะนำ):**

1. เปิดแอป OpenClaw
2. ไปที่แท็บการตั้งค่า **General**
3. คลิก **"Install CLI"**

หรือสามารถติดตั้งด้วยตนเองได้ดังนี้:

```bash
npm install -g openclaw@<version>
```

## การแก้ไขปัญหา

### การสร้างล้มเหลว: Toolchain หรือ SDK ไม่ตรงกัน

การสร้างแอป macOS ต้องการ macOS SDK ล่าสุดและ Swift 6.2 toolchain

**Dependencies ของระบบ (จำเป็น):**

- **macOS เวอร์ชันล่าสุดที่มีใน Software Update** (จำเป็นสำหรับ Xcode 26.2 SDKs)
- **Xcode 26.2** (Swift 6.2 toolchain)

**การตรวจสอบ:**

```bash
xcodebuild -version
xcrun swift --version
```

หากเวอร์ชันไม่ตรงกัน ให้อัปเดต macOS/Xcode แล้วรันการสร้างใหม่อีกครั้ง

### แอปแครชเมื่ออนุญาตสิทธิ์

หากแอปแครชเมื่อคุณพยายามอนุญาตการเข้าถึง **Speech Recognition** หรือ **Microphone** อาจเกิดจาก TCC cache เสียหายหรือการเซ็นไม่ตรงกัน

**วิธีแก้ไข:**

1. รีเซ็ตสิทธิ์ TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. หากยังไม่สำเร็จ ให้เปลี่ยนค่า `BUNDLE_ID` ชั่วคราวใน [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) เพื่อบังคับให้ macOS เริ่มต้นใหม่แบบ "clean slate"

### Gateway แสดงสถานะ "Starting..." ไม่สิ้นสุด

หากสถานะ Gateway ค้างอยู่ที่ "Starting..." ให้ตรวจสอบว่ามีโปรเซสค้าง (zombie process) ที่ยึดพอร์ตไว้หรือไม่:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

หากมีการรันแบบแมนนวลที่ยึดพอร์ตอยู่ ให้หยุดโปรเซสนั้น (Ctrl+C) และหากจำเป็นจริงๆ ให้ kill PID ที่คุณพบจากขั้นตอนข้างต้น 10. เป็นทางเลือกสุดท้าย ให้ฆ่า PID ที่คุณพบด้านบน
