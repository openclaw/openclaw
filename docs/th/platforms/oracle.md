---
summary: "OpenClaw บน Oracle Cloud (ARM Always Free)"
read_when:
  - การตั้งค่า OpenClaw บน Oracle Cloud
  - มองหา VPS ต้นทุนต่ำสำหรับ OpenClaw
  - ต้องการ OpenClaw ทำงานตลอด 24/7 บนเซิร์ฟเวอร์ขนาดเล็ก
title: "Oracle Cloud"
---

# OpenClaw บน Oracle Cloud (OCI)

## เป้าหมาย

รัน OpenClaw Gateway（เกตเวย์）แบบถาวรบน Oracle Cloud ระดับ **Always Free** แบบ ARM

Free tier ของ Oracle เหมาะกับ OpenClaw ได้ดี (โดยเฉพาะถ้าคุณมีบัญชี OCI อยู่แล้ว) แต่ก็มีข้อแลกเปลี่ยน:

- สถาปัตยกรรม ARM (ส่วนใหญ่ใช้งานได้ แต่บางไบนารีอาจรองรับเฉพาะ x86)
- ความจุและการสมัครอาจจุกจิก

## เปรียบเทียบค่าใช้จ่าย (2026)

| ผู้ให้บริการ | แผน             | Specs                   | ราคา/เดือน           | หมายเหตุ                        |
| ------------ | --------------- | ----------------------- | -------------------- | ------------------------------- |
| Oracle Cloud | Always Free ARM | สูงสุด 4 OCPU, RAM 24GB | $0                   | ARM, ความจุจำกัด                |
| Hetzner      | CX22            | 2 vCPU, RAM 4GB         | ~ $4 | ตัวเลือกแบบเสียเงินที่ถูกที่สุด |
| DigitalOcean | Basic           | 1 vCPU, RAM 1GB         | $6                   | UI ใช้งานง่าย เอกสารดี          |
| Vultr        | Cloud Compute   | 1 vCPU, RAM 1GB         | $6                   | หลายโลเคชัน                     |
| Linode       | Nanode          | 1 vCPU, RAM 1GB         | $5                   | ปัจจุบันเป็นส่วนหนึ่งของ Akamai |

---

## ข้อกำหนดก่อนเริ่มต้น

- บัญชี Oracle Cloud ([สมัคร](https://www.oracle.com/cloud/free/)) — ดู [คู่มือสมัครจากชุมชน](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) หากพบปัญหา
- บัญชี Tailscale (ฟรีที่ [tailscale.com](https://tailscale.com))
- เวลาประมาณ 30 นาที

## 1. สร้าง OCI Instance

1. ล็อกอินที่ [Oracle Cloud Console](https://cloud.oracle.com/)
2. ไปที่ **Compute → Instances → Create Instance**
3. ตั้งค่า:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (หรือสูงสุด 4)
   - **Memory:** 12 GB (หรือสูงสุด 24 GB)
   - **Boot volume:** 50 GB (ฟรีได้สูงสุด 200 GB)
   - **SSH key:** เพิ่ม public key ของคุณ
4. คลิก **Create**
5. จด public IP address ไว้

**เคล็ดลับ:** หากการสร้าง instance ล้มเหลวพร้อมข้อความ "Out of capacity" ให้ลอง availability domain อื่นหรือรอแล้วลองใหม่ภายหลัง ความจุ Free tier มีจำกัด ความจุของฟรีเทียร์มีจำกัด

## 2. เชื่อมต่อและอัปเดต

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**หมายเหตุ:** ต้องใช้ `build-essential` สำหรับการคอมไพล์ dependency บางตัวบน ARM

## 3. ตั้งค่าผู้ใช้และชื่อโฮสต์

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. ติดตั้ง Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

ขั้นตอนนี้จะเปิดใช้งาน Tailscale SSH ทำให้คุณเชื่อมต่อผ่าน `ssh openclaw` จากอุปกรณ์ใดก็ได้ใน tailnet โดยไม่ต้องใช้ public IP

ตรวจสอบ:

```bash
tailscale status
```

**ตั้งแต่นี้เป็นต้นไป ให้เชื่อมต่อผ่าน Tailscale:** `ssh ubuntu@openclaw` (หรือใช้ Tailscale IP)

## 5. ติดตั้ง OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

เมื่อมีคำถามว่า "How do you want to hatch your bot?" ให้เลือก **"Do this later"**

> หมายเหตุ: หากพบปัญหาการ build แบบ native บน ARM ให้เริ่มจากแพ็กเกจระบบ (เช่น `sudo apt install -y build-essential`) ก่อนที่จะใช้ Homebrew

## 6. ตั้งค่า Gateway (loopback + token auth) และเปิดใช้งาน Tailscale Serve

ใช้ token auth เป็นค่าเริ่มต้น ใช้ token auth เป็นค่าเริ่มต้น เนื่องจากคาดเดาได้ง่ายและไม่ต้องเปิดแฟล็ก “insecure auth” ใน Control UI

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. ตรวจสอบการทำงาน

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. ล็อกดาวน์ความปลอดภัย VCN

เมื่อทุกอย่างทำงานแล้ว ให้ล็อกดาวน์ VCN เพื่อบล็อกทราฟฟิกทั้งหมด ยกเว้น Tailscale เมื่อทุกอย่างทำงานเรียบร้อยแล้ว ให้ล็อกดาวน์ VCN เพื่อบล็อกทราฟฟิกทั้งหมด ยกเว้น Tailscale โดย Virtual Cloud Network ของ OCI ทำหน้าที่เป็นไฟร์วอลล์ที่ขอบเครือข่าย ทราฟฟิกจะถูกบล็อกก่อนถึง instance

1. ไปที่ **Networking → Virtual Cloud Networks** ใน OCI Console
2. คลิก VCN ของคุณ → **Security Lists** → Default Security List
3. **ลบ** ingress rules ทั้งหมด ยกเว้น:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. คงค่า egress rules เริ่มต้นไว้ (อนุญาต outbound ทั้งหมด)

การตั้งค่านี้จะบล็อก SSH พอร์ต 22, HTTP, HTTPS และทุกอย่างอื่นที่ขอบเครือข่าย จากนี้ไปจะเชื่อมต่อได้เฉพาะผ่าน Tailscale เท่านั้น นับจากนี้ คุณจะเชื่อมต่อได้ผ่าน Tailscale เท่านั้น

---

## เข้าถึง Control UI

จากอุปกรณ์ใดก็ได้ในเครือข่าย Tailscale ของคุณ:

```
https://openclaw.<tailnet-name>.ts.net/
```

แทนที่ `<tailnet-name>` ด้วยชื่อ tailnet ของคุณ (ดูได้ใน `tailscale status`)

ไม่ต้องใช้อุโมงค์SSH โดย Tailscale มีให้: Tailscale มีให้:

- การเข้ารหัส HTTPS (ใบรับรองอัตโนมัติ)
- การยืนยันตัวตนผ่านตัวตน Tailscale
- การเข้าถึงจากอุปกรณ์ใดก็ได้ใน tailnet (แล็ปท็อป โทรศัพท์ ฯลฯ)

---

## ความปลอดภัย: VCN + Tailscale (แนวทางที่แนะนำ)

เมื่อ VCN ถูกล็อกดาวน์ (เปิดเฉพาะ UDP 41641) และ Gateway ผูกกับ local loopback จะได้การป้องกันแบบหลายชั้น: ทราฟฟิกสาธารณะถูกบล็อกที่ขอบเครือข่าย และการเข้าถึงผู้ดูแลทำผ่าน tailnet

การตั้งค่านี้มักทำให้ไม่จำเป็นต้องเพิ่มกฎไฟร์วอลล์บนโฮสต์เพื่อป้องกัน SSH brute force จากอินเทอร์เน็ต — แต่คุณยังควรอัปเดต OS รัน `openclaw security audit` และตรวจสอบว่าไม่ได้เผลอเปิดพอร์ตบนอินเทอร์เฟซสาธารณะ

### สิ่งที่ได้รับการป้องกันแล้ว

| ขั้นตอนแบบดั้งเดิม | จำเป็นหรือไม่ | เหตุผล                                                                  |
| ------------------ | ------------- | ----------------------------------------------------------------------- |
| ไฟร์วอลล์ UFW      | ไม่           | VCN บล็อกก่อนทราฟฟิกจะถึง instance                                      |
| fail2ban           | ไม่           | ไม่มี brute force หากพอร์ต 22 ถูกบล็อกที่ VCN                           |
| การ harden sshd    | ไม่           | Tailscale SSH ไม่ใช้ sshd                                               |
| ปิด root login     | ไม่           | Tailscale ใช้ตัวตน Tailscale ไม่ใช่ผู้ใช้ระบบ                           |
| SSH key-only auth  | ไม่           | Tailscale ยืนยันตัวตนผ่าน tailnet                                       |
| การ harden IPv6    | โดยทั่วไปไม่  | ขึ้นอยู่กับการตั้งค่า VCN/subnet; ตรวจสอบสิ่งที่ถูกกำหนด/เปิดใช้งานจริง |

### สิ่งที่ยังแนะนำ

- **สิทธิ์ของ credential:** `chmod 700 ~/.openclaw`
- **การตรวจสอบความปลอดภัย:** `openclaw security audit`
- **อัปเดตระบบ:** `sudo apt update && sudo apt upgrade` เป็นประจำ
- **ตรวจสอบ Tailscale:** ทบทวนอุปกรณ์ใน [Tailscale admin console](https://login.tailscale.com/admin)

### ตรวจสอบสถานะความปลอดภัย

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## ทางเลือกสำรอง: อุโมงค์SSH

หาก Tailscale Serve ใช้งานไม่ได้ ให้ใช้อุโมงค์SSH:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

จากนั้นเปิด `http://localhost:18789`.

---

## การแก้ไขปัญหา

### การสร้าง instance ล้มเหลว ("Out of capacity")

instance ARM แบบ Free tier ได้รับความนิยม ลอง: ลอง:

- เปลี่ยน availability domain
- ลองใหม่ในช่วงนอกเวลาพีค (เช้าตรู่)
- ใช้ตัวกรอง "Always Free" ตอนเลือก shape

### Tailscale เชื่อมต่อไม่ได้

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway ไม่เริ่มทำงาน

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### เข้าถึง Control UI ไม่ได้

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ปัญหาไบนารี ARM

เครื่องมือบางตัวอาจไม่มี build สำหรับ ARM ตรวจสอบ: ตรวจสอบ:

```bash
uname -m  # Should show aarch64
```

แพ็กเกจ npm ส่วนใหญ่ทำงานได้ดี แพ็กเกจ npm ส่วนใหญ่ทำงานได้ดี สำหรับไบนารี ให้มองหา release แบบ `linux-arm64` หรือ `aarch64`.

---

## การคงอยู่

สถานะทั้งหมดอยู่ใน:

- `~/.openclaw/` — คอนฟิก credential ข้อมูลเซสชัน
- `~/.openclaw/workspace/` — เวิร์กสเปซ (SOUL.md, หน่วยความจำ, อาร์ติแฟกต์)

สำรองข้อมูลเป็นระยะ:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## ดูเพิ่มเติม

- [Gateway remote access](/gateway/remote) — รูปแบบการเข้าถึงระยะไกลอื่นๆ
- [Tailscale integration](/gateway/tailscale) — เอกสาร Tailscale แบบเต็ม
- [Gateway configuration](/gateway/configuration) — ตัวเลือกการกำหนดค่าทั้งหมด
- [คู่มือ DigitalOcean](/platforms/digitalocean) — หากต้องการแบบเสียเงินและสมัครง่ายกว่า
- [คู่มือ Hetzner](/install/hetzner) — ทางเลือกแบบ Docker
