---
summary: "การรองรับ Linux และสถานะของแอปคู่หู"
read_when:
  - กำลังมองหาสถานะของแอปคู่หูบน Linux
  - วางแผนความครอบคลุมแพลตฟอร์มหรือการมีส่วนร่วม
title: "แอป Linux"
---

# แอป Linux

Gateway รองรับบน Linux อย่างเต็มรูปแบบ **Node เป็นรันไทม์ที่แนะนำ**
ไม่แนะนำให้ใช้ Bun สำหรับ Gateway (มีบั๊กกับ WhatsApp/Telegram)

มีแผนพัฒนาแอปคู่หูแบบเนทีฟสำหรับ Linux หากต้องการช่วยสร้าง ยินดีรับการมีส่วนร่วม ยินดีรับการมีส่วนร่วม หากคุณต้องการช่วยสร้าง

## เส้นทางเริ่มต้นแบบเร็วสำหรับผู้เริ่มต้น (VPS)

1. ติดตั้ง Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. จากแล็ปท็อปของคุณ: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. เปิด `http://127.0.0.1:18789/` แล้ววางโทเคนของคุณ

คู่มือ VPS แบบทีละขั้นตอน: [exe.dev](/install/exe-dev)

## ติดตั้ง

- [เริ่มต้นใช้งาน](/start/getting-started)
- [การติดตั้งและอัปเดต](/install/updating)
- โฟลว์ทางเลือก: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [คู่มือการรัน Gateway](/gateway)
- [การกำหนดค่า](/gateway/configuration)

## การติดตั้งบริการ Gateway（เกตเวย์）(CLI)

ใช้หนึ่งในตัวเลือกต่อไปนี้:

```
openclaw onboard --install-daemon
```

หรือ:

```
openclaw gateway install
```

หรือ:

```
openclaw configure
```

เมื่อมีการถาม ให้เลือก **Gateway service**

ซ่อมแซม/ย้ายข้อมูล:

```
openclaw doctor
```

## การควบคุมระบบ (systemd user unit)

โดยค่าเริ่มต้น OpenClaw จะติดตั้งบริการ systemd แบบ **user** ใช้บริการแบบ **system**
สำหรับเซิร์ฟเวอร์ที่ใช้ร่วมกันหรือเปิดทำงานตลอดเวลา ตัวอย่าง unit แบบเต็มและคำแนะนำ
อยู่ใน [คู่มือการรัน Gateway](/gateway) ใช้บริการ **system** สำหรับเซิร์ฟเวอร์ที่ใช้ร่วมกันหรือเปิดตลอดเวลา ตัวอย่างยูนิตแบบเต็มและคำแนะนำ
อยู่ใน [Gateway runbook](/gateway)

การตั้งค่าขั้นต่ำ:

สร้าง `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

เปิดใช้งาน:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
