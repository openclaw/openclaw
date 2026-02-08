---
summary: "รัน OpenClaw Gateway บน exe.dev (VM + พร็อกซีHTTPS) เพื่อการเข้าถึงจากระยะไกล"
read_when:
  - คุณต้องการโฮสต์Linuxที่เปิดตลอดและมีค่าใช้จ่ายต่ำสำหรับ Gateway
  - คุณต้องการเข้าถึง Control UI จากระยะไกลโดยไม่ต้องรัน VPS ของคุณเอง
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:21Z
---

# exe.dev

เป้าหมาย: ให้ OpenClaw Gateway ทำงานบน VM ของ exe.dev และเข้าถึงได้จากแล็ปท็อปของคุณผ่าน: `https://<vm-name>.exe.xyz`

หน้านี้สมมติว่าใช้อิมเมจเริ่มต้น **exeuntu** ของ exe.dev หากคุณเลือกดิสโทรอื่น ให้ปรับแพ็กเกจให้สอดคล้องกัน

## เส้นทางด่วนสำหรับผู้เริ่มต้น

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. กรอกคีย์/โทเคนยืนยันตัวตนตามที่ต้องการ
3. คลิก "Agent" ข้าง VM ของคุณ แล้วรอสักครู่...
4. ???
5. ได้ผลลัพธ์

## สิ่งที่ต้องมี

- บัญชี exe.dev
- การเข้าถึง `ssh exe.dev` ไปยังเครื่องเสมือนของ [exe.dev](https://exe.dev) (ไม่บังคับ)

## การติดตั้งอัตโนมัติด้วย Shelley

Shelley ซึ่งเป็นเอเจนต์ของ [exe.dev](https://exe.dev) สามารถติดตั้ง OpenClaw ได้ทันทีด้วยพรอมป์ของเรา
พรอมป์ที่ใช้มีดังนี้:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## การติดตั้งด้วยตนเอง

## 1) สร้าง VM

จากอุปกรณ์ของคุณ:

```bash
ssh exe.dev new
```

จากนั้นเชื่อมต่อ:

```bash
ssh <vm-name>.exe.xyz
```

เคล็ดลับ: ควรทำให้ VM นี้เป็นแบบ **stateful** OpenClaw จะเก็บสถานะไว้ภายใต้ `~/.openclaw/` และ `~/.openclaw/workspace/`.

## 2) ติดตั้งข้อกำหนดเบื้องต้น (บน VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) ติดตั้ง OpenClaw

รันสคริปต์ติดตั้ง OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) ตั้งค่า nginx เพื่อพร็อกซี OpenClaw ไปยังพอร์ต 8000

แก้ไข `/etc/nginx/sites-enabled/default` ด้วย

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) เข้าถึง OpenClaw และให้สิทธิ์

เข้าถึง `https://<vm-name>.exe.xyz/` (ดูเอาต์พุต Control UI จากขั้นตอน onboarding) หากมีการขอการยืนยันตัวตน ให้คัดลอก
โทเคนจาก `gateway.auth.token` บน VM (ดึงด้วย `openclaw config get gateway.auth.token` หรือสร้างใหม่
ด้วย `openclaw doctor --generate-gateway-token`) อนุมัติอุปกรณ์ด้วย `openclaw devices list` และ
`openclaw devices approve <requestId>` หากไม่แน่ใจ ให้ใช้ Shelley จากเบราว์เซอร์ของคุณ!

## การเข้าถึงจากระยะไกล

การเข้าถึงจากระยะไกลจัดการโดยการยืนยันตัวตนของ [exe.dev](https://exe.dev) โดยค่าเริ่มต้น ทราฟฟิกHTTPจากพอร์ต 8000 จะถูกส่งต่อไปยัง `https://<vm-name>.exe.xyz`
พร้อมการยืนยันตัวตนด้วยอีเมล

## การอัปเดต

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

คู่มือ: [การอัปเดต](/install/updating)
