---
summary: "ภาพรวมการรองรับแพลตฟอร์ม(Gateway+แอปคู่หู)"
read_when:
  - กำลังมองหาการรองรับระบบปฏิบัติการหรือเส้นทางการติดตั้ง
  - กำลังตัดสินใจว่าจะรันGatewayที่ใด
title: "แพลตฟอร์ม"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:22Z
---

# แพลตฟอร์ม

แกนหลักของOpenClawเขียนด้วยTypeScript **แนะนำให้ใช้Nodeเป็นรันไทม์**  
ไม่แนะนำให้ใช้BunสำหรับGateway(มีบั๊กกับWhatsApp/Telegram)

มีแอปคู่หูสำหรับmacOS(แอปแถบเมนู)และโหนดบนมือถือ(iOS/Android) แอปคู่หูสำหรับWindowsและ
Linuxอยู่ในแผนพัฒนา แต่Gatewayรองรับอย่างเต็มรูปแบบแล้วในปัจจุบัน
แอปคู่หูแบบเนทีฟสำหรับWindowsก็อยู่ในแผนเช่นกัน โดยแนะนำให้ใช้Gatewayผ่านWSL2

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
