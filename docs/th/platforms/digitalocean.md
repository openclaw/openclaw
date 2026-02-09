---
summary: "OpenClaw บน DigitalOcean (ตัวเลือก VPS แบบเสียเงินที่เรียบง่าย)"
read_when:
  - การตั้งค่า OpenClaw บน DigitalOcean
  - มองหาโฮสต์ VPS ราคาประหยัดสำหรับ OpenClaw
title: "DigitalOcean"
---

# OpenClaw บน DigitalOcean

## เป้าหมาย

รัน OpenClaw Gateway（เกตเวย์）แบบทำงานต่อเนื่องบน DigitalOcean ด้วยค่าใช้จ่าย **$6/เดือน** (หรือ $4/เดือนหากใช้ราคาสำรอง)

หากคุณต้องการตัวเลือก $0/เดือน และไม่กังวลกับ ARM + การตั้งค่าเฉพาะผู้ให้บริการ ดูที่ [คู่มือ Oracle Cloud](/platforms/oracle)

## เปรียบเทียบค่าใช้จ่าย (2026)

| ผู้ให้บริการ | แผน             | Specs                   | ราคา/เดือน                                                     | หมายเหตุ                             |
| ------------ | --------------- | ----------------------- | -------------------------------------------------------------- | ------------------------------------ |
| Oracle Cloud | Always Free ARM | สูงสุด 4 OCPU, 24GB RAM | $0                                                             | ARM, ความจุจำกัด/ขั้นตอนสมัครยุ่งยาก |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | €3.79 (~$4) | ตัวเลือกแบบเสียเงินที่ถูกที่สุด      |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                                                             | UI ใช้งานง่าย เอกสารดี               |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                                                             | มีหลายโลเคชัน                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                                                             | ปัจจุบันเป็นส่วนหนึ่งของ Akamai      |

**การเลือกผู้ให้บริการ:**

- DigitalOcean: UX เรียบง่ายที่สุด + การตั้งค่าคาดเดาได้ (คู่มือนี้)
- Hetzner: ราคา/ประสิทธิภาพดี (ดู [คู่มือ Hetzner](/install/hetzner))
- Oracle Cloud: อาจเป็น $0/เดือน แต่จุกจิกกว่าและเป็น ARM เท่านั้น (ดู [คู่มือ Oracle](/platforms/oracle))

---

## ข้อกำหนดก่อนเริ่มต้น

- บัญชี DigitalOcean ([สมัครพร้อมเครดิตฟรี $200](https://m.do.co/c/signup))
- คู่กุญแจ SSH (หรือยอมรับการใช้รหัสผ่าน)
- เวลาประมาณ ~20 นาที

## 1. สร้าง Droplet

1. เข้าสู่ระบบที่ [DigitalOcean](https://cloud.digitalocean.com/)
2. คลิก **Create → Droplets**
3. เลือก:
   - **Region:** ใกล้คุณที่สุด (หรือใกล้ผู้ใช้)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/เดือน** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (แนะนำ) หรือรหัสผ่าน
4. คลิก **Create Droplet**
5. จดบันทึกที่อยู่ IP

## 2) เชื่อมต่อผ่าน SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. ติดตั้ง OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. รันขั้นตอน Onboarding

```bash
openclaw onboard --install-daemon
```

ตัวช่วยจะพาคุณไปทีละขั้นตอน:

- การยืนยันตัวตนของโมเดล (คีย์API หรือ OAuth)
- การตั้งค่าช่องทาง (Telegram, WhatsApp, Discord ฯลฯ)
- Gateway token (สร้างอัตโนมัติ)
- การติดตั้ง Daemon (systemd)

## 5. ตรวจสอบ Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. เข้าถึงแดชบอร์ด

Gateway จะ bind กับ loopback เป็นค่าเริ่มต้น หากต้องการเข้าถึง Control UI: เพื่อเข้าถึง Control UI:

**ตัวเลือก A: อุโมงค์SSH (แนะนำ)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**ตัวเลือก B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

เปิด: `https://<magicdns>/`

หมายเหตุ:

- Serve จะทำให้ Gateway เป็น loopback-only และยืนยันตัวตนผ่าน Tailscale identity headers
- หากต้องการบังคับใช้โทเคน/รหัสผ่านแทน ให้ตั้งค่า `gateway.auth.allowTailscale: false` หรือใช้ `gateway.auth.mode: "password"`.

**ตัวเลือก C: Tailnet bind (ไม่ใช้ Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

เปิด: `http://<tailscale-ip>:18789` (ต้องใช้โทเคน)

## 7. เชื่อมต่อช่องทางของคุณ

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

ดูผู้ให้บริการอื่นๆ ที่ [Channels](/channels)

---

## การปรับแต่งสำหรับ RAM 1GB

Droplet ราคา $6 มี RAM เพียง 1GB เพื่อให้ทำงานได้ราบรื่น: เพื่อให้ทุกอย่างทำงานได้อย่างราบรื่น:

### เพิ่ม swap (แนะนำ)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### ใช้โมเดลที่เบากว่า

หากพบปัญหา OOM ให้พิจารณา:

- ใช้โมเดลแบบ API (Claude, GPT) แทนโมเดลภายในเครื่อง
- ตั้งค่า `agents.defaults.model.primary` เป็นโมเดลที่เล็กลง

### ตรวจสอบหน่วยความจำ

```bash
free -h
htop
```

---

## การคงอยู่ของข้อมูล

สถานะทั้งหมดอยู่ที่:

- `~/.openclaw/` — คอนฟิก ข้อมูลรับรอง ข้อมูลเซสชัน
- `~/.openclaw/workspace/` — เวิร์กสเปซ (SOUL.md, หน่วยความจำ ฯลฯ)

สิ่งเหล่านี้จะคงอยู่หลังการรีบูต สำรองข้อมูลเป็นระยะ:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## ทางเลือก Oracle Cloud ฟรี

Oracle Cloud มีอินสแตนซ์ ARM แบบ **Always Free** ที่ทรงพลังกว่าตัวเลือกแบบเสียเงินทั้งหมดในหน้านี้ — ในราคา $0/เดือน

| สิ่งที่ได้รับ     | Specs                 |
| ----------------- | --------------------- |
| **4 OCPUs**       | ARM Ampere A1         |
| **24GB RAM**      | มากเกินพอ             |
| **200GB storage** | Block volume          |
| **ฟรีตลอดไป**     | ไม่มีการเรียกเก็บบัตร |

**ข้อควรระวัง:**

- การสมัครอาจจุกจิก (ลองใหม่หากล้มเหลว)
- สถาปัตยกรรม ARM — ส่วนใหญ่ใช้งานได้ แต่บางไบนารีต้องใช้เวอร์ชัน ARM

ดูคู่มือการตั้งค่าแบบเต็มได้ที่ [Oracle Cloud](/platforms/oracle) และสำหรับเคล็ดลับการสมัครและการแก้ไขปัญหาขั้นตอน enrollment ดูที่ [คู่มือชุมชน](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) สำหรับเคล็ดลับการสมัครและการแก้ไขปัญหาในกระบวนการลงทะเบียน ดูที่ [คู่มือชุมชน](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) นี้

---

## การแก้ไขปัญหา

### Gateway ไม่เริ่มทำงาน

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### พอร์ตถูกใช้งานอยู่แล้ว

```bash
lsof -i :18789
kill <PID>
```

### หน่วยความจำไม่พอ

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## ดูเพิ่มเติม

- [คู่มือ Hetzner](/install/hetzner) — ถูกกว่าและทรงพลังกว่า
- [การติดตั้ง Docker](/install/docker) — การตั้งค่าแบบคอนเทนเนอร์
- [Tailscale](/gateway/tailscale) — การเข้าถึงระยะไกลอย่างปลอดภัย
- [Configuration](/gateway/configuration) — เอกสารอ้างอิงคอนฟิกทั้งหมด
