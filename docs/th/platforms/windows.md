---
summary: "การรองรับ Windows (WSL2) + สถานะแอปคู่หู"
read_when:
  - การติดตั้ง OpenClaw บน Windows
  - การตรวจสอบสถานะแอปคู่หูบน Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

แนะนำให้ใช้งาน OpenClaw บน Windows **ผ่าน WSL2** (แนะนำ Ubuntu) โดย
CLI + Gateway จะทำงานภายใน Linux ซึ่งช่วยให้สภาพแวดล้อมรันไทม์มีความสม่ำเสมอและทำให้เครื่องมือทำงานร่วมกันได้ดีกว่ามาก (Node/Bun/pnpm, ไบนารี Linux, Skills) การใช้งานบน Windows แบบเนทีฟอาจยุ่งยากกว่า WSL2 มอบประสบการณ์ Linux แบบเต็มรูปแบบ — ติดตั้งได้ด้วยคำสั่งเดียว: `wsl --install`. CLI + Gateway รันอยู่ภายใน Linux ซึ่งช่วยให้สภาพแวดล้อมรันไทม์สอดคล้องกันและทำให้เครื่องมือเข้ากันได้มากขึ้น (Node/Bun/pnpm, ไบนารี Linux, สกิล) 1. เนทีฟ
Windows อาจจะยุ่งยากกว่านิดหน่อย 2. WSL2 มอบประสบการณ์ Linux แบบเต็มรูปแบบ — เพียงคำสั่งเดียว
สำหรับการติดตั้ง: `wsl --install`.

มีแผนจะพัฒนาแอปคู่หูบน Windows แบบเนทีฟในอนาคต

## Install (WSL2)

- [Getting Started](/start/getting-started) (ใช้งานภายใน WSL)
- [Install & updates](/install/updating)
- คู่มือ WSL2 อย่างเป็นทางการ (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

ภายใน WSL2:

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

การซ่อมแซม/ย้ายระบบ:

```
openclaw doctor
```

## ขั้นสูง: เปิดเผยบริการ WSL ผ่าน LAN (portproxy)

3. WSL มีเครือข่ายเสมือนของตัวเอง WSL มีเครือข่ายเสมือนของตัวเอง หากเครื่องอื่นจำเป็นต้องเข้าถึงบริการที่รันอยู่ **ภายใน WSL** (เช่น SSH, เซิร์ฟเวอร์ TTS ภายในเครื่อง หรือ Gateway) คุณต้องทำการส่งต่อพอร์ตของ Windows ไปยัง IP ปัจจุบันของ WSL IP ของ WSL จะเปลี่ยนหลังจากรีสตาร์ต ดังนั้นคุณอาจต้องรีเฟรชกฎการส่งต่อเป็นระยะ 4. IP ของ WSL จะเปลี่ยนหลังจากรีสตาร์ต
   ดังนั้นคุณอาจต้องรีเฟรชกฎการฟอร์เวิร์ด

ตัวอย่าง (PowerShell **ในฐานะ Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

อนุญาตพอร์ตผ่าน Windows Firewall (ครั้งเดียว):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

รีเฟรช portproxy หลังจาก WSL รีสตาร์ต:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

หมายเหตุ:

- การเชื่อมต่อ SSH จากเครื่องอื่นให้ชี้ไปที่ **IP ของโฮสต์ Windows** (ตัวอย่าง: `ssh user@windows-host -p 2222`).
- โหนดระยะไกลต้องชี้ไปที่ URL ของ Gateway ที่ **เข้าถึงได้** (ไม่ใช่ `127.0.0.1`); ใช้
  `openclaw status --all` เพื่อยืนยัน.
- ใช้ `listenaddress=0.0.0.0` สำหรับการเข้าถึงผ่าน LAN; ส่วน `127.0.0.1` จะจำกัดให้ใช้งานเฉพาะภายในเครื่อง.
- หากต้องการให้ทำงานอัตโนมัติ ให้ลงทะเบียน Scheduled Task เพื่อรันขั้นตอนการรีเฟรชเมื่อเข้าสู่ระบบ

## การติดตั้ง WSL2 แบบทีละขั้นตอน

### 1. ติดตั้ง WSL2 + Ubuntu

เปิด PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

รีบูตหาก Windows แจ้งให้ทำ

### 2. เปิดใช้งาน systemd (จำเป็นสำหรับการติดตั้ง Gateway)

ในเทอร์มินัล WSL ของคุณ:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

จากนั้นใน PowerShell:

```powershell
wsl --shutdown
```

เปิด Ubuntu ใหม่ แล้วตรวจสอบ:

```bash
systemctl --user status
```

### 3. ติดตั้ง OpenClaw (ภายใน WSL)

ทำตามขั้นตอน Getting Started สำหรับ Linux ภายใน WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

คู่มือฉบับเต็ม: [Getting Started](/start/getting-started)

## แอปคู่หูบน Windows

5. เรายังไม่มีแอปคู่หูบน Windows ในตอนนี้ 6. ยินดีรับการมีส่วนร่วม หากคุณต้องการ
   ช่วยกันทำให้สิ่งนี้เกิดขึ้น
