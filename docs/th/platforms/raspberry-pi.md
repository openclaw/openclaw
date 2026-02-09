---
summary: "OpenClaw บน Raspberry Pi (การตั้งค่าโฮสต์เองแบบประหยัด)"
read_when:
  - การตั้งค่า OpenClaw บน Raspberry Pi
  - การรัน OpenClaw บนอุปกรณ์ ARM
  - การสร้าง AI ส่วนตัวที่เปิดตลอดแบบต้นทุนต่ำ
title: "Raspberry Pi"
---

# OpenClaw บน Raspberry Pi

## เป้าหมาย

รัน OpenClaw Gateway ที่ทำงานต่อเนื่องตลอดเวลา บน Raspberry Pi ด้วยต้นทุนครั้งเดียวประมาณ **~$35-80** (ไม่มีค่าบริการรายเดือน)

เหมาะอย่างยิ่งสำหรับ:

- ผู้ช่วย AI ส่วนตัว 24/7
- ฮับระบบบ้านอัตโนมัติ
- บอต Telegram/WhatsApp ที่ใช้พลังงานต่ำและพร้อมใช้งานเสมอ

## ข้อกำหนดด้านฮาร์ดแวร์

| รุ่น Pi         | RAM     | ทำงานหรือไม่? | หมายเหตุ                          |
| --------------- | ------- | ------------- | --------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ ดีที่สุด    | เร็วที่สุด แนะนำ                  |
| **Pi 4**        | 4GB     | ✅ ดี          | จุดสมดุลสำหรับผู้ใช้ส่วนใหญ่      |
| **Pi 4**        | 2GB     | ✅ พอใช้       | ใช้งานได้ เพิ่ม swap              |
| **Pi 4**        | 1GB     | ⚠️ เข้มงวด    | เป็นไปได้ด้วย swap ตั้งค่าขั้นต่ำ |
| **Pi 3B+**      | 1GB     | ⚠️ ช้า        | ใช้งานได้แต่ค่อนข้างอืด           |
| **Pi Zero 2 W** | 512MB   | ❌             | ไม่แนะนำ                          |

**สเปกขั้นต่ำ:** RAM 1GB, 1 คอร์, ดิสก์ 500MB  
**แนะนำ:** RAM 2GB+, ระบบปฏิบัติการ 64-bit, SD card 16GB+ (หรือ USB SSD)

## สิ่งที่คุณต้องเตรียม

- Raspberry Pi 4 หรือ 5 (แนะนำ 2GB+)
- MicroSD card (16GB+) หรือ USB SSD (ประสิทธิภาพดีกว่า)
- แหล่งจ่ายไฟ (แนะนำ PSU ของ Pi อย่างเป็นทางการ)
- การเชื่อมต่อเครือข่าย (Ethernet หรือ WiFi)
- เวลาประมาณ ~30 นาที

## 1. แฟลชระบบปฏิบัติการ

ใช้ **Raspberry Pi OS Lite (64-bit)** — ไม่ต้องใช้เดสก์ท็อปสำหรับเซิร์ฟเวอร์แบบ headless

1. ดาวน์โหลด [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. เลือก OS: **Raspberry Pi OS Lite (64-bit)**
3. คลิกไอคอนรูปเฟือง (⚙️) เพื่อตั้งค่าล่วงหน้า:
   - ตั้งค่า hostname: `gateway-host`
   - เปิดใช้งาน SSH
   - ตั้งค่า username/password
   - ตั้งค่า WiFi (หากไม่ใช้ Ethernet)
4. แฟลชลง SD card / USB drive
5. ใส่การ์ดและบูต Pi

## 2) เชื่อมต่อผ่าน SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. ตั้งค่าระบบ

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. ติดตั้ง Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. เพิ่ม Swap (สำคัญสำหรับ 2GB หรือน้อยกว่า)

Swap ช่วยป้องกันการแครชจากหน่วยความจำไม่พอ:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. ติดตั้ง OpenClaw

### ตัวเลือก A: การติดตั้งมาตรฐาน (แนะนำ)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### ตัวเลือก B: การติดตั้งแบบแก้ไขได้ (สำหรับการทดลอง)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

การติดตั้งแบบแก้ไขได้จะให้คุณเข้าถึง log และโค้ดโดยตรง — มีประโยชน์สำหรับดีบักปัญหาเฉพาะของ ARM

## 7. รันการตั้งค่าเริ่มต้น (Onboarding)

```bash
openclaw onboard --install-daemon
```

ทำตามวิซาร์ด:

1. **โหมด Gateway:** Local
2. **การยืนยันตัวตน:** แนะนำ API keys (OAuth อาจมีปัญหาบน Pi แบบ headless)
3. **ช่องทาง:** Telegram เริ่มต้นได้ง่ายที่สุด
4. **Daemon:** ใช่ (systemd)

## 8) ตรวจสอบการติดตั้ง

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. เข้าถึงแดชบอร์ด

เนื่องจาก Pi เป็นแบบ headless ให้ใช้อุโมงค์ SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

หรือใช้ Tailscale เพื่อการเข้าถึงแบบ always-on:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## การปรับแต่งประสิทธิภาพ

### ใช้ USB SSD (ดีขึ้นอย่างมาก)

การ์ด SD ช้าและสึกหรอง่าย SD card ช้าและเสื่อมสภาพได้ง่าย USB SSD จะช่วยเพิ่มประสิทธิภาพอย่างชัดเจน:

```bash
# Check if booting from USB
lsblk
```

ดู [คู่มือบูตจาก USB ของ Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) สำหรับการตั้งค่า

### ลดการใช้หน่วยความจำ

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### ตรวจสอบทรัพยากร

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## หมายเหตุเฉพาะ ARM

### ความเข้ากันได้ของไบนารี

ฟีเจอร์ส่วนใหญ่ของ OpenClaw ทำงานได้บน ARM64 แต่ไบนารีภายนอกบางตัวอาจต้องใช้เวอร์ชันที่คอมไพล์สำหรับ ARM:

| เครื่องมือ                            | สถานะ ARM64 | หมายเหตุ                            |
| ------------------------------------- | ----------- | ----------------------------------- |
| Node.js               | ✅           | ทำงานได้ดีมาก                       |
| WhatsApp (Baileys) | ✅           | เป็น JS ล้วน ไม่มีปัญหา             |
| Telegram                              | ✅           | เป็น JS ล้วน ไม่มีปัญหา             |
| gog (Gmail CLI)    | ⚠️          | ตรวจสอบว่ามีรีลีสสำหรับ ARM         |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |

หาก Skill ใดล้มเหลว ให้ตรวจสอบว่าไบนารีนั้นมีเวอร์ชัน ARM หรือไม่ เครื่องมือ Go/Rust หลายตัวมีให้ แต่บางตัวไม่มี เครื่องมือ Go/Rust หลายตัวทำงานได้; บางตัวไม่

### 32-bit vs 64-bit

**ควรใช้ระบบปฏิบัติการ 64-bit เสมอ** Node.js และเครื่องมือสมัยใหม่จำนวนมากต้องการแบบนี้ ตรวจสอบได้ด้วย: ตรวจสอบกับ:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## การตั้งค่าโมเดลที่แนะนำ

เนื่องจาก Pi ทำหน้าที่เป็น Gateway เท่านั้น (โมเดลรันบนคลาวด์) ให้ใช้โมเดลแบบ API:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**อย่าพยายามรัน LLM แบบ local บน Pi** — แม้แต่โมเดลขนาดเล็กก็ช้าเกินไป ให้ Claude/GPT จัดการงานหนักแทน ให้ Claude/GPT ทำงานหนักแทน

---

## การเริ่มอัตโนมัติเมื่อบูต

ตัวช่วยตั้งค่าได้ตั้งค่าให้แล้ว แต่สามารถตรวจสอบได้ด้วย:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## การแก้ไขปัญหา

### หน่วยความจำไม่พอ (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### ประสิทธิภาพช้า

- ใช้ USB SSD แทน SD card
- ปิดบริการที่ไม่ใช้: `sudo systemctl disable cups bluetooth avahi-daemon`
- ตรวจสอบการลดความเร็วของ CPU: `vcgencmd get_throttled` (ควรได้ค่า `0x0`)

### บริการไม่เริ่มทำงาน

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ปัญหาไบนารีบน ARM

หาก Skill ล้มเหลวพร้อมข้อความ "exec format error":

1. ตรวจสอบว่าไบนารีมีเวอร์ชัน ARM64 หรือไม่
2. ลอง build จากซอร์สโค้ด
3. หรือใช้ Docker container ที่รองรับ ARM

### WiFi หลุดการเชื่อมต่อ

สำหรับ Pi แบบ headless ที่ใช้ WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## เปรียบเทียบต้นทุน

| การตั้งค่า                        | ต้นทุนครั้งเดียว     | รายเดือน                 | หมายเหตุ                                            |
| --------------------------------- | -------------------- | ------------------------ | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                       | + ค่าไฟ (~$5/ปี) |
| **Pi 4 (4GB)** | ~$55 | $0                       | แนะนำ                                               |
| **Pi 5 (4GB)** | ~$60 | $0                       | ประสิทธิภาพดีที่สุด                                 |
| **Pi 5 (8GB)** | ~$80 | $0                       | อาจเกินความจำเป็น แต่รองรับอนาคต                    |
| DigitalOcean                      | $0                   | $6/mo                    | $72/ปี                                              |
| Hetzner                           | $0                   | €3.79/mo | ~$50/ปี                             |

**จุดคุ้มทุน:** Pi จะคืนทุนในประมาณ ~6-12 เดือน เมื่อเทียบกับ VPS บนคลาวด์

---

## ดูเพิ่มเติม

- [คู่มือ Linux](/platforms/linux) — การตั้งค่า Linux ทั่วไป
- [คู่มือ DigitalOcean](/platforms/digitalocean) — ทางเลือกบนคลาวด์
- [คู่มือ Hetzner](/install/hetzner) — การตั้งค่า Docker
- [Tailscale](/gateway/tailscale) — การเข้าถึงระยะไกล
- [Nodes](/nodes) — จับคู่แล็ปท็อป/โทรศัพท์กับ Gateway บน Pi
