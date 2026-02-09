---
summary: "Raspberry Pi पर OpenClaw (बजट स्वयं-होस्टेड सेटअप)"
read_when:
  - Raspberry Pi पर OpenClaw सेट अप करना
  - ARM डिवाइसों पर OpenClaw चलाना
  - एक सस्ता हमेशा-चालू व्यक्तिगत AI बनाना
title: "Raspberry Pi"
---

# Raspberry Pi पर OpenClaw

## लक्ष्य

**~$35–80** के एकमुश्त खर्च (कोई मासिक शुल्क नहीं) में Raspberry Pi पर एक स्थायी, हमेशा-चालू OpenClaw Gateway चलाना।

इसके लिए आदर्श:

- 24/7 व्यक्तिगत AI सहायक
- होम ऑटोमेशन हब
- कम-ऊर्जा, हमेशा-उपलब्ध Telegram/WhatsApp बॉट

## हार्डवेयर आवश्यकताएँ

| Pi मॉडल         | RAM     | काम करता है? | नोट्स                             |
| --------------- | ------- | ------------ | --------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ सर्वोत्तम  | सबसे तेज़, अनुशंसित               |
| **Pi 4**        | 4GB     | ✅ अच्छा      | अधिकांश उपयोगकर्ताओं के लिए आदर्श |
| **Pi 4**        | 2GB     | ✅ ठीक        | काम करता है, swap जोड़ें          |
| **Pi 4**        | 1GB     | ⚠️ सीमित     | swap के साथ संभव, न्यूनतम विन्यास |
| **Pi 3B+**      | 1GB     | ⚠️ धीमा      | काम करता है लेकिन सुस्त           |
| **Pi Zero 2 W** | 512MB   | ❌            | अनुशंसित नहीं                     |

**न्यूनतम स्पेक्स:** 1GB RAM, 1 कोर, 500MB डिस्क  
**अनुशंसित:** 2GB+ RAM, 64-बिट OS, 16GB+ SD कार्ड (या USB SSD)

## आपको क्या चाहिए

- Raspberry Pi 4 या 5 (2GB+ अनुशंसित)
- MicroSD कार्ड (16GB+) या USB SSD (बेहतर प्रदर्शन)
- पावर सप्लाई (आधिकारिक Pi PSU अनुशंसित)
- नेटवर्क कनेक्शन (Ethernet या WiFi)
- ~30 मिनट

## 1. OS फ़्लैश करें

हेडलैस सर्वर के लिए **Raspberry Pi OS Lite (64-bit)** उपयोग करें — डेस्कटॉप की आवश्यकता नहीं।

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) डाउनलोड करें
2. OS चुनें: **Raspberry Pi OS Lite (64-bit)**
3. गियर आइकन (⚙️) पर क्लिक कर प्री-कॉन्फ़िगर करें:
   - होस्टनेम सेट करें: `gateway-host`
   - SSH सक्षम करें
   - उपयोगकर्ता नाम/पासवर्ड सेट करें
   - WiFi कॉन्फ़िगर करें (यदि Ethernet उपयोग नहीं कर रहे)
4. अपने SD कार्ड / USB ड्राइव पर फ़्लैश करें
5. Pi डालें और बूट करें

## 2) SSH के माध्यम से कनेक्ट करें

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. सिस्टम सेटअप

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 इंस्टॉल करें (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap जोड़ें (2GB या कम के लिए महत्वपूर्ण)

Swap out-of-memory क्रैश को रोकता है:

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

## 6. OpenClaw इंस्टॉल करें

### विकल्प A: मानक इंस्टॉल (अनुशंसित)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### विकल्प B: Hackable इंस्टॉल (छेड़छाड़ के लिए)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Hackable इंस्टॉल आपको लॉग्स और कोड तक सीधे पहुँच देता है — ARM-विशिष्ट समस्याओं के डिबग के लिए उपयोगी।

## 7. ऑनबोर्डिंग चलाएँ

```bash
openclaw onboard --install-daemon
```

विज़ार्ड का पालन करें:

1. **Gateway मोड:** Local
2. **Auth:** API keys अनुशंसित (हेडलैस Pi पर OAuth अस्थिर हो सकता है)
3. **Channels:** शुरुआत के लिए Telegram सबसे आसान
4. **Daemon:** Yes (systemd)

## 8) इंस्टॉलेशन सत्यापित करें

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. डैशबोर्ड तक पहुँच

चूँकि Pi हेडलैस है, SSH टनल का उपयोग करें:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

या हमेशा-चालू पहुँच के लिए Tailscale का उपयोग करें:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## प्रदर्शन अनुकूलन

### USB SSD का उपयोग करें (बहुत बड़ा सुधार)

SD कार्ड धीमे होते हैं और जल्दी घिस जाते हैं। एक USB SSD प्रदर्शन में काफ़ी सुधार करता है:

```bash
# Check if booting from USB
lsblk
```

सेटअप के लिए [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) देखें।

### मेमोरी उपयोग कम करें

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### संसाधनों की निगरानी करें

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-विशिष्ट नोट्स

### बाइनरी संगतता

अधिकांश OpenClaw विशेषताएँ ARM64 पर काम करती हैं, लेकिन कुछ बाहरी बाइनरी को ARM बिल्ड की आवश्यकता हो सकती है:

| टूल                                    | ARM64 स्थिति | नोट्स                               |
| -------------------------------------- | ------------ | ----------------------------------- |
| Node.js                | ✅            | शानदार ढंग से काम करता है           |
| WhatsApp (Baileys)  | ✅            | शुद्ध JS, कोई समस्या नहीं           |
| Telegram                               | ✅            | शुद्ध JS, कोई समस्या नहीं           |
| gog (Gmail CLI)     | ⚠️           | ARM रिलीज़ जाँचें                   |
| Chromium (ब्राउज़र) | ✅            | `sudo apt install chromium-browser` |

यदि कोई स्किल विफल होती है, तो जाँचें कि उसकी बाइनरी का ARM बिल्ड है या नहीं। कई Go/Rust टूल्स के पास होता है; कुछ के पास नहीं।

### 32-बिट बनाम 64-बिट

**हमेशा 64-बिट OS का उपयोग करें।** Node.js और कई आधुनिक टूल्स को इसकी आवश्यकता होती है। इसके साथ जाँच करें:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## अनुशंसित मॉडल सेटअप

चूँकि Pi केवल Gateway है (मॉडल क्लाउड में चलते हैं), API-आधारित मॉडल उपयोग करें:

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

**Pi पर लोकल LLMs चलाने की कोशिश न करें** — छोटे मॉडल भी बहुत धीमे होते हैं। Claude/GPT को भारी काम करने दें।

---

## बूट पर ऑटो-स्टार्ट

ऑनबोर्डिंग विज़ार्ड यह सेट कर देता है, लेकिन सत्यापित करने के लिए:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## समस्या-निवारण

### Out of Memory (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### धीमा प्रदर्शन

- SD कार्ड के बजाय USB SSD का उपयोग करें
- अप्रयुक्त सेवाएँ अक्षम करें: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU थ्रॉटलिंग जाँचें: `vcgencmd get_throttled` (परिणाम `0x0` होना चाहिए)

### सेवा शुरू नहीं होती

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM बाइनरी समस्याएँ

यदि कोई Skill "exec format error" के साथ विफल हो:

1. जाँचें कि बाइनरी का ARM64 बिल्ड है या नहीं
2. स्रोत से बिल्ड करने का प्रयास करें
3. या ARM समर्थन वाले Docker कंटेनर का उपयोग करें

### WiFi डिस्कनेक्ट होता है

WiFi पर हेडलैस Pi के लिए:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## लागत तुलना

| सेटअप                             | एकमुश्त लागत         | मासिक लागत                | नोट्स                                                 |
| --------------------------------- | -------------------- | ------------------------- | ----------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                        | + बिजली (~$5/वर्ष) |
| **Pi 4 (4GB)** | ~$55 | $0                        | अनुशंसित                                              |
| **Pi 5 (4GB)** | ~$60 | $0                        | सर्वोत्तम प्रदर्शन                                    |
| **Pi 5 (8GB)** | ~$80 | $0                        | ओवरकिल लेकिन भविष्य-सुरक्षित                          |
| DigitalOcean                      | $0                   | $6/माह                    | $72/वर्ष                                              |
| Hetzner                           | $0                   | €3.79/माह | ~$50/वर्ष                             |

**ब्रेक-ईवन:** क्लाउड VPS की तुलना में Pi ~6–12 महीनों में अपनी लागत निकाल लेता है।

---

## यह भी देखें

- [Linux guide](/platforms/linux) — सामान्य Linux सेटअप
- [DigitalOcean guide](/platforms/digitalocean) — क्लाउड विकल्प
- [Hetzner guide](/install/hetzner) — Docker सेटअप
- [Tailscale](/gateway/tailscale) — दूरस्थ पहुँच
- [Nodes](/nodes) — अपने लैपटॉप/फ़ोन को Pi Gateway के साथ जोड़ें
