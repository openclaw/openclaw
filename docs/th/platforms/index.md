---
summary: "ภาพรวมการรองรับแพลตฟอร์ม(Gateway+แอปคู่หู)"
read_when:
  - กำลังมองหาการรองรับระบบปฏิบัติการหรือเส้นทางการติดตั้ง
  - กำลังตัดสินใจว่าจะรันGatewayที่ใด
title: "แพลตฟอร์ม"
---

# แพลตฟอร์ม

แกนหลักของ OpenClaw เขียนด้วย TypeScript **Node เป็นรันไทม์ที่แนะนำ**
ไม่แนะนำให้ใช้ Bun สำหรับ Gateway (มีบั๊กกับ WhatsApp/Telegram)

มีแอปคู่หูสำหรับ macOS (แอปบนแถบเมนู) และโหนดมือถือ (iOS/Android) แอปคู่หูสำหรับ Windows และ
Linux อยู่ในแผนพัฒนา แต่ Gateway รองรับเต็มรูปแบบแล้วในปัจจุบัน
แอปคู่หูแบบเนทีฟสำหรับ Windows ก็อยู่ในแผนเช่นกัน; แนะนำให้ใช้ Gateway ผ่าน WSL2

## เลือกระบบปฏิบัติการของคุณ

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & โฮสติ้ง

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## ลิงก์ที่ใช้บ่อย

- คู่มือการติดตั้ง: [Getting Started](/start/getting-started)
- คู่มือการใช้งานGateway: [Gateway](/gateway)
- การกำหนดค่าGateway: [Configuration](/gateway/configuration)
- สถานะบริการ: `openclaw gateway status`

## การติดตั้งบริการGateway(CLI)

ใช้หนึ่งในวิธีต่อไปนี้(รองรับทั้งหมด):

- Wizard(แนะนำ): `openclaw onboard --install-daemon`
- Direct: `openclaw gateway install`
- Configure flow: `openclaw configure` → เลือก **Gateway service**
- Repair/migrate: `openclaw doctor` (มีตัวเลือกติดตั้งหรือแก้ไขบริการ)

เป้าหมายของบริการขึ้นอยู่กับระบบปฏิบัติการ:

- macOS: LaunchAgent (`bot.molt.gateway` หรือ `bot.molt.<profile>`; รุ่นเดิม `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
