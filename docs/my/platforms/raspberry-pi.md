---
summary: "Raspberry Pi ပေါ်တွင် OpenClaw (ဘတ်ဂျက်သက်သာသော ကိုယ်တိုင်ဟို့စ်တင် setup)"
read_when:
  - Raspberry Pi ပေါ်တွင် OpenClaw ကို တပ်ဆင်ခြင်း
  - ARM စက်များပေါ်တွင် OpenClaw ကို လည်ပတ်ခြင်း
  - စျေးသက်သာပြီး အမြဲဖွင့်ထားသော ကိုယ်ပိုင် AI တစ်ခု တည်ဆောက်ခြင်း
title: "Raspberry Pi"
---

# Raspberry Pi ပေါ်ရှိ OpenClaw

## ရည်မှန်းချက်

တစ်ကြိမ်တည်းကုန်ကျစရိတ် **~$35-80** (လစဉ်ကြေးမရှိ) ဖြင့် Raspberry Pi ပေါ်တွင် အမြဲလည်ပတ်နေသော OpenClaw Gateway တစ်ခုကို တည်ဆောက်ပါ။

အောက်ပါအသုံးများအတွက် သင့်တော်ပါသည်–

- 24/7 ကိုယ်ပိုင် AI အကူအညီပေးသူ
- အိမ်သုံး အလိုအလျောက်ထိန်းချုပ်မှု hub
- စွမ်းအင်သုံးစွဲမှုနည်းပြီး အမြဲအသုံးပြုနိုင်သော Telegram/WhatsApp bot

## ဟာဒ်ဝဲ လိုအပ်ချက်များ

| Pi မော်ဒယ်      | RAM     | အလုပ်ဖြစ်?    | မှတ်ချက်များ                                  |
| --------------- | ------- | ------------- | --------------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ အကောင်းဆုံး | အမြန်ဆုံး၊ အကြံပြုထားသည်                      |
| **Pi 4**        | 4GB     | ✅ ကောင်း      | အသုံးပြုသူအများစုအတွက် အကောင်းဆုံးရွေးချယ်မှု |
| **Pi 4**        | 2GB     | ✅ OK          | အလုပ်ဖြစ်သည်၊ swap ထည့်ရန်လို                 |
| **Pi 4**        | 1GB     | ⚠️ ကျစ်လစ်    | swap ဖြင့်ဖြစ်နိုင်၊ အနည်းဆုံး config         |
| **Pi 3B+**      | 1GB     | ⚠️ နှေး       | အလုပ်ဖြစ်သော်လည်း နှေးကွေး                    |
| **Pi Zero 2 W** | 512MB   | ❌             | မအကြံပြုပါ                                    |

**အနည်းဆုံး spec:** RAM 1GB, core 1 ခု, disk 500MB  
**အကြံပြုချက်:** RAM 2GB+, 64-bit OS, SD ကဒ် 16GB+ (သို့မဟုတ် USB SSD)

## သင်လိုအပ်မည့်အရာများ

- Raspberry Pi 4 သို့မဟုတ် 5 (2GB+ အကြံပြု)
- MicroSD ကဒ် (16GB+) သို့မဟုတ် USB SSD (စွမ်းဆောင်ရည်ကောင်း)
- ပါဝါပေးစနစ် (Pi အထူး PSU ကို အကြံပြု)
- ကွန်ယက်ချိတ်ဆက်မှု (Ethernet သို့မဟုတ် WiFi)
- ~ မိနစ် 30

## 1. OS ကို Flash လုပ်ခြင်း

Headless server အတွက် desktop မလိုအပ်သော **Raspberry Pi OS Lite (64-bit)** ကို အသုံးပြုပါ။

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) ကို ဒေါင်းလုဒ်လုပ်ပါ
2. OS ကို ရွေးပါ: **Raspberry Pi OS Lite (64-bit)**
3. gear အိုင်ကွန် (⚙️) ကို နှိပ်ပြီး ကြိုတင်ပြင်ဆင်ပါ–
   - hostname သတ်မှတ်ပါ: `gateway-host`
   - SSH ကို ဖွင့်ပါ
   - username/password သတ်မှတ်ပါ
   - Ethernet မသုံးပါက WiFi ကို ပြင်ဆင်ပါ
4. SD ကဒ် / USB drive သို့ flash လုပ်ပါ
5. ထည့်သွင်းပြီး Pi ကို boot လုပ်ပါ

## 2) SSH ဖြင့် ချိတ်ဆက်ခြင်း

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. စနစ် ပြင်ဆင်ခြင်း

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 (ARM64) ကို ထည့်သွင်းခြင်း

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap ထည့်ခြင်း (2GB သို့မဟုတ် အောက်တွင် အရေးကြီး)

Swap သည် memory မလုံလောက်မှုကြောင့် crash ဖြစ်ခြင်းကို ကာကွယ်ပေးသည်–

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

## 6. OpenClaw ကို ထည့်သွင်းခြင်း

### ရွေးချယ်မှု A: စံ Install (အကြံပြု)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### ရွေးချယ်မှု B: Hackable Install (စမ်းသပ်ပြင်ဆင်လိုသူများအတွက်)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Hackable install သည် logs နှင့် code ကို တိုက်ရိုက်ဝင်ရောက်နိုင်စေပြီး ARM အထူးပြဿနာများကို debugging ပြုလုပ်ရာတွင် အသုံးဝင်ပါသည်။

## 7. Onboarding ကို လည်ပတ်ခြင်း

```bash
openclaw onboard --install-daemon
```

wizard ကို လိုက်နာပါ–

1. **Gateway mode:** Local
2. **Auth:** API keys ကို အကြံပြု (headless Pi တွင် OAuth သည် ခက်ခဲနိုင်သည်)
3. **Channels:** စတင်ရန် Telegram သည် အလွယ်ကူဆုံး
4. **Daemon:** Yes (systemd)

## 8) Installation ကို စစ်ဆေးခြင်း

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Dashboard သို့ ဝင်ရောက်ခြင်း

Pi သည် headless ဖြစ်သောကြောင့် SSH tunnel ကို အသုံးပြုပါ–

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

သို့မဟုတ် အမြဲတမ်း ဝင်ရောက်နိုင်ရန် Tailscale ကို အသုံးပြုပါ–

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## စွမ်းဆောင်ရည် မြှင့်တင်ခြင်း

### USB SSD ကို အသုံးပြုပါ (အလွန်တိုးတက်)

SD cards များသည် နှေးကွေးပြီး ပျက်စီးလွယ်ပါသည်။ USB SSD တစ်ခုကို အသုံးပြုပါက performance ကို သိသိသာသာ တိုးတက်စေပါသည်:

```bash
# Check if booting from USB
lsblk
```

တပ်ဆင်ရန် [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) ကို ကြည့်ပါ။

### Memory အသုံးပြုမှု လျှော့ချခြင်း

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### အရင်းအမြစ်များကို စောင့်ကြည့်ခြင်း

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM အထူး မှတ်ချက်များ

### Binary ကိုက်ညီမှု

OpenClaw ၏ အင်္ဂါရပ်အများစုသည် ARM64 တွင် အလုပ်ဖြစ်သော်လည်း ပြင်ပ binaries အချို့တွင် ARM build လိုအပ်နိုင်ပါသည်–

| Tool                                  | ARM64 အခြေအနေ | မှတ်ချက်များ                        |
| ------------------------------------- | ------------- | ----------------------------------- |
| Node.js               | ✅             | အလွန်ကောင်းစွာ အလုပ်ဖြစ်သည်         |
| WhatsApp (Baileys) | ✅             | JS သာဖြစ်ပြီး ပြဿနာမရှိ             |
| Telegram                              | ✅             | JS သာဖြစ်ပြီး ပြဿနာမရှိ             |
| gog (Gmail CLI)    | ⚠️            | ARM release ရှိ/မရှိ စစ်ဆေးပါ       |
| Chromium (browser) | ✅             | `sudo apt install chromium-browser` |

skill တစ်ခု မအောင်မြင်ပါက ၎င်း၏ binary တွင် ARM build ရှိမရှိ စစ်ဆေးပါ။ Go/Rust tools အများစုတွင် ရှိသော်လည်း အချို့တွင် မရှိပါ။

### 32-bit နှင့် 64-bit

**အမြဲတမ်း 64-bit OS ကို အသုံးပြုပါ။** Node.js နှင့် ခေတ်မီ tools အများစုမှာ ၎င်းကို လိုအပ်ပါသည်။ အောက်ပါအတိုင်း စစ်ဆေးပါ:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## အကြံပြု မော်ဒယ် Setup

Pi သည် Gateway သာဖြစ်ပြီး (မော်ဒယ်များကို cloud တွင် လည်ပတ်သည်) ထို့ကြောင့် API အခြေခံ မော်ဒယ်များကို အသုံးပြုပါ–

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

**Pi ပေါ်တွင် local LLM များကို မ chạy ပါနှင့်** — အသေးစား models များတောင် အလွန်နှေးကွေးပါသည်။ ခက်ခဲသော အလုပ်များကို Claude/GPT ကို လုပ်ဆောင်စေပါ။

---

## Boot လုပ်ချိန်တွင် အလိုအလျောက် စတင်ခြင်း

Onboarding wizard က တပ်ဆင်ပေးထားသော်လည်း စစ်ဆေးရန်–

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## ပြဿနာဖြေရှင်းခြင်း

### Memory မလုံလောက်မှု (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### စွမ်းဆောင်ရည် နှေးကွေးခြင်း

- SD ကဒ်အစား USB SSD ကို အသုံးပြုပါ
- မအသုံးပြုသော service များကို ပိတ်ပါ: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU throttling ကို စစ်ဆေးပါ: `vcgencmd get_throttled` ( `0x0` ကို ပြန်ရသင့်သည်)

### Service မစတင်နိုင်ခြင်း

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM Binary ပြဿနာများ

Skill တစ်ခုတွင် "exec format error" ဖြစ်ပါက–

1. Binary တွင် ARM64 build ရှိ/မရှိ စစ်ဆေးပါ
2. Source မှ build လုပ်ကြည့်ပါ
3. သို့မဟုတ် ARM ထောက်ပံ့သည့် Docker container ကို အသုံးပြုပါ

### WiFi ပြတ်တောက်ခြင်း

WiFi သုံး headless Pi များအတွက်–

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## ကုန်ကျစရိတ် နှိုင်းယှဉ်ခြင်း

| Setup                             | တစ်ကြိမ်ကုန်ကျစရိတ်  | လစဉ်ကုန်ကျစရိတ်          | မှတ်ချက်များ                                           |
| --------------------------------- | -------------------- | ------------------------ | ------------------------------------------------------ |
| **Pi 4 (2GB)** | ~$45 | $0                       | + မီးအား (~$5/နှစ်) |
| **Pi 4 (4GB)** | ~$55 | $0                       | အကြံပြု                                                |
| **Pi 5 (4GB)** | ~$60 | $0                       | အကောင်းဆုံး စွမ်းဆောင်ရည်                              |
| **Pi 5 (8GB)** | ~$80 | $0                       | မလိုအပ်လောက်သော်လည်း အနာဂတ်အတွက်                       |
| DigitalOcean                      | $0                   | $6/mo                    | $72/နှစ်                                               |
| Hetzner                           | $0                   | €3.79/mo | ~$50/နှစ်                              |

**Break-even:** Cloud VPS နှိုင်းယှဉ်လျှင် Pi သည် ~6–12 လအတွင်း ကိုယ်တိုင်ကုန်ကျစရိတ် ပြန်လည်ဖြည့်ဆည်းနိုင်ပါသည်။

---

## ဆက်လက်ဖတ်ရှုရန်

- [Linux guide](/platforms/linux) — ယေဘုယျ Linux တပ်ဆင်ခြင်း
- [DigitalOcean guide](/platforms/digitalocean) — cloud အခြားရွေးချယ်မှု
- [Hetzner guide](/install/hetzner) — Docker setup
- [Tailscale](/gateway/tailscale) — အဝေးမှ ဝင်ရောက်ခြင်း
- [Nodes](/nodes) — Pi Gateway နှင့် သင့် laptop/ဖုန်းကို ချိတ်ဆက်ခြင်း
