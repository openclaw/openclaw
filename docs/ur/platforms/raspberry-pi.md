---
summary: "Raspberry Pi پر OpenClaw (کم بجٹ خود میزبانی سیٹ اپ)"
read_when:
  - Raspberry Pi پر OpenClaw سیٹ اپ کرنا
  - ARM ڈیوائسز پر OpenClaw چلانا
  - کم لاگت، ہمہ وقت دستیاب ذاتی AI بنانا
title: "Raspberry Pi"
---

# Raspberry Pi پر OpenClaw

## مقصد

Raspberry Pi پر ایک مستقل، ہمہ وقت آن OpenClaw Gateway چلائیں، **تقریباً $35–80** کی ایک وقتی لاگت کے ساتھ (کوئی ماہانہ فیس نہیں)۔

کے لیے موزوں:

- 24/7 ذاتی AI اسسٹنٹ
- گھر کی آٹومیشن ہب
- کم توانائی والا، ہمیشہ دستیاب Telegram/WhatsApp بوٹ

## ہارڈویئر ضروریات

| Pi ماڈل         | RAM     | کام کرتا ہے؟ | نوٹس                              |
| --------------- | ------- | ------------ | --------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ بہترین     | سب سے تیز، سفارش کردہ             |
| **Pi 4**        | 4GB     | ✅ اچھا       | زیادہ تر صارفین کے لیے موزوں      |
| **Pi 4**        | 2GB     | ✅ قابلِ قبول | کام کرتا ہے، swap شامل کریں       |
| **Pi 4**        | 1GB     | ⚠️ تنگ       | swap کے ساتھ ممکن، کم از کم کنفیگ |
| **Pi 3B+**      | 1GB     | ⚠️ سست       | کام کرتا ہے مگر سست               |
| **Pi Zero 2 W** | 512MB   | ❌            | سفارش نہیں کی جاتی                |

**کم از کم خصوصیات:** 1GB RAM، 1 کور، 500MB ڈسک  
**سفارش کردہ:** 2GB+ RAM، 64-بٹ OS، 16GB+ SD کارڈ (یا USB SSD)

## آپ کو کیا درکار ہوگا

- Raspberry Pi 4 یا 5 (2GB+ سفارش کردہ)
- MicroSD کارڈ (16GB+) یا USB SSD (بہتر کارکردگی)
- پاور سپلائی (آفیشل Pi PSU سفارش کردہ)
- نیٹ ورک کنکشن (Ethernet یا WiFi)
- تقریباً 30 منٹ

## 1. OS فلیش کریں

ہیڈ لیس سرور کے لیے **Raspberry Pi OS Lite (64-bit)** استعمال کریں — ڈیسک ٹاپ کی ضرورت نہیں۔

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) ڈاؤن لوڈ کریں
2. OS منتخب کریں: **Raspberry Pi OS Lite (64-bit)**
3. گیئر آئیکن (⚙️) پر کلک کر کے پیشگی کنفیگریشن کریں:
   - ہوسٹ نیم سیٹ کریں: `gateway-host`
   - SSH فعال کریں
   - یوزرنیم/پاس ورڈ سیٹ کریں
   - WiFi کنفیگر کریں (اگر Ethernet استعمال نہیں کر رہے)
4. SD کارڈ / USB ڈرائیو پر فلیش کریں
5. Pi لگائیں اور بوٹ کریں

## 2) SSH کے ذریعے کنیکٹ کریں

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. سسٹم سیٹ اپ

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 (ARM64) انسٹال کریں

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap شامل کریں (2GB یا کم کے لیے اہم)

Swap آؤٹ آف میموری کریشز سے بچاتا ہے:

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

## 6. OpenClaw انسٹال کریں

### آپشن A: معیاری انسٹال (سفارش کردہ)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### آپشن B: Hackable انسٹال (چھیڑ چھاڑ کے لیے)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Hackable انسٹال آپ کو لاگز اور کوڈ تک براہِ راست رسائی دیتا ہے — ARM مخصوص مسائل کی ڈیبگنگ کے لیے مفید۔

## 7. آن بورڈنگ چلائیں

```bash
openclaw onboard --install-daemon
```

وزارڈ کی پیروی کریں:

1. **Gateway موڈ:** Local
2. **تصدیق:** API keys سفارش کردہ (ہیڈ لیس Pi پر OAuth کبھی کبھار مشکل ہو سکتا ہے)
3. **چینلز:** آغاز کے لیے Telegram سب سے آسان
4. **Daemon:** ہاں (systemd)

## 8) انسٹالیشن کی تصدیق کریں

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. ڈیش بورڈ تک رسائی

چونکہ Pi ہیڈ لیس ہے، SSH سرنگ استعمال کریں:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

یا ہمہ وقت رسائی کے لیے Tailscale استعمال کریں:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## کارکردگی کی بہتریاں

### USB SSD استعمال کریں (بڑی بہتری)

SD cards are slow and wear out. A USB SSD dramatically improves performance:

```bash
# Check if booting from USB
lsblk
```

سیٹ اپ کے لیے [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) دیکھیں۔

### میموری کے استعمال میں کمی

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### وسائل کی نگرانی

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM مخصوص نوٹس

### بائنری مطابقت

OpenClaw کی زیادہ تر خصوصیات ARM64 پر کام کرتی ہیں، مگر کچھ بیرونی بائنریز کو ARM بلڈ درکار ہو سکتی ہے:

| اوزار                                 | ARM64 اسٹیٹس | نوٹس                                |
| ------------------------------------- | ------------ | ----------------------------------- |
| Node.js               | ✅            | بہترین طور پر کام کرتا ہے           |
| WhatsApp (Baileys) | ✅            | خالص JS، کوئی مسئلہ نہیں            |
| Telegram                              | ✅            | خالص JS، کوئی مسئلہ نہیں            |
| gog (Gmail CLI)    | ⚠️           | ARM ریلیز چیک کریں                  |
| Chromium (browser) | ✅            | `sudo apt install chromium-browser` |

If a skill fails, check if its binary has an ARM build. Many Go/Rust tools do; some don't.

### 32-بٹ بمقابلہ 64-بٹ

**Always use 64-bit OS.** Node.js and many modern tools require it. Check with:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## سفارش کردہ ماڈل سیٹ اپ

چونکہ Pi صرف Gateway ہے (ماڈلز کلاؤڈ میں چلتے ہیں)، اس لیے API پر مبنی ماڈلز استعمال کریں:

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

**Don't try to run local LLMs on a Pi** — even small models are too slow. Let Claude/GPT do the heavy lifting.

---

## بوٹ پر خودکار آغاز

آن بورڈنگ وزارڈ یہ سیٹ اپ کر دیتا ہے، مگر تصدیق کے لیے:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## خرابیوں کا ازالہ

### آؤٹ آف میموری (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### سست کارکردگی

- SD کارڈ کے بجائے USB SSD استعمال کریں
- غیر استعمال شدہ سروسز بند کریں: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU تھروٹلنگ چیک کریں: `vcgencmd get_throttled` (واپس آنا چاہیے `0x0`)

### سروس شروع نہیں ہو رہی

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM بائنری مسائل

اگر کوئی skill "exec format error" کے ساتھ ناکام ہو:

1. دیکھیں کہ بائنری کا ARM64 بلڈ موجود ہے یا نہیں
2. سورس سے بلڈ کرنے کی کوشش کریں
3. یا ARM سپورٹ کے ساتھ Docker کنٹینر استعمال کریں

### WiFi منقطع ہو جاتا ہے

WiFi پر ہیڈ لیس Pi کے لیے:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## لاگت کا موازنہ

| سیٹ اپ                            | ایک وقتی لاگت        | ماہانہ لاگت               | نوٹس                                                |
| --------------------------------- | -------------------- | ------------------------- | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                        | + بجلی (~$5/سال) |
| **Pi 4 (4GB)** | ~$55 | $0                        | سفارش کردہ                                          |
| **Pi 5 (4GB)** | ~$60 | $0                        | بہترین کارکردگی                                     |
| **Pi 5 (8GB)** | ~$80 | $0                        | ضرورت سے زیادہ مگر مستقبل محفوظ                     |
| DigitalOcean                      | $0                   | $6/ماہ                    | $72/سال                                             |
| Hetzner                           | $0                   | €3.79/ماہ | ~$50/سال                            |

**بریک ایون:** کلاؤڈ VPS کے مقابلے میں Pi تقریباً 6–12 ماہ میں اپنی لاگت پوری کر لیتا ہے۔

---

## یہ بھی دیکھیں

- [Linux guide](/platforms/linux) — عمومی Linux سیٹ اپ
- [DigitalOcean guide](/platforms/digitalocean) — کلاؤڈ متبادل
- [Hetzner guide](/install/hetzner) — Docker سیٹ اپ
- [Tailscale](/gateway/tailscale) — ریموٹ رسائی
- [Nodes](/nodes) — اپنے لیپ ٹاپ/فون کو Pi گیٹ وے کے ساتھ جوڑیں
