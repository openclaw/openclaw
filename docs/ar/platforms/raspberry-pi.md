---
summary: "تشغيل OpenClaw على Raspberry Pi (إعداد ذاتي منخفض التكلفة)"
read_when:
  - إعداد OpenClaw على Raspberry Pi
  - تشغيل OpenClaw على أجهزة ARM
  - بناء ذكاء اصطناعي شخصي دائم التشغيل وبتكلفة منخفضة
title: "Raspberry Pi"
---

# OpenClaw على Raspberry Pi

## الهدف

تشغيل Gateway لـ OpenClaw بشكل دائم وعلى مدار الساعة على Raspberry Pi بتكلفة لمرة واحدة **~35–80 دولارًا** (من دون رسوم شهرية).

مثالي لـ:

- مساعد ذكاء اصطناعي شخصي يعمل 24/7
- مركز التشغيل الآلي للمنزل
- بوت Telegram/WhatsApp منخفض الاستهلاك ومتاح دائمًا

## متطلبات العتاد

| طراز Pi         | RAM     | يعمل؟    | ملاحظات                        |
| --------------- | ------- | -------- | ------------------------------ |
| **Pi 5**        | 4GB/8GB | ✅ الأفضل | الأسرع، مُوصى به               |
| **Pi 4**        | 4GB     | ✅ جيد    | الخيار الأمثل لمعظم المستخدمين |
| **Pi 4**        | 2GB     | ✅ مقبول  | يعمل، أضِف swap                |
| **Pi 4**        | 1GB     | ⚠️ ضيق   | ممكن مع swap وإعدادات حدّية    |
| **Pi 3B+**      | 1GB     | ⚠️ بطيء  | يعمل لكن بأداء متواضع          |
| **Pi Zero 2 W** | 512MB   | ❌        | غير مُوصى به                   |

**الحد الأدنى:** 1GB RAM، نواة واحدة، 500MB مساحة قرص  
**المُوصى به:** 2GB+ RAM، نظام 64-بت، بطاقة SD بسعة 16GB+ (أو USB SSD)

## ما الذي ستحتاجه

- Raspberry Pi 4 أو 5 (يُوصى بـ 2GB+)
- بطاقة MicroSD (16GB+) أو USB SSD (أداء أفضل)
- مزوّد طاقة (يُفضّل المزوّد الرسمي لـ Pi)
- اتصال شبكي (Ethernet أو WiFi)
- ~30 دقيقة

## 1. تفليش نظام التشغيل

استخدم **Raspberry Pi OS Lite (64-bit)** — لا حاجة لواجهة سطح مكتب لخادم headless.

1. نزّل [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. اختر النظام: **Raspberry Pi OS Lite (64-bit)**
3. انقر على أيقونة الترس (⚙️) للإعداد المسبق:
   - تعيين اسم المضيف: `gateway-host`
   - تفعيل SSH
   - تعيين اسم المستخدم/كلمة المرور
   - إعداد WiFi (إذا لم تستخدم Ethernet)
4. نفّذ التفليش على بطاقة SD / قرص USB
5. أدخل الوسيط وشغّل Pi

## 2) الاتصال عبر SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. إعداد النظام

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. تثبيت Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. إضافة Swap (مهم لـ 2GB أو أقل)

تمنع مساحة swap انهيارات نفاد الذاكرة:

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

## 6. تثبيت OpenClaw

### الخيار A: التثبيت القياسي (مُوصى به)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### الخيار B: تثبيت قابل للتعديل (للتجربة)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

يوفّر التثبيت القابل للتعديل وصولًا مباشرًا إلى السجلات والكود — مفيد لتصحيح المشكلات الخاصة بـ ARM.

## 7. تشغيل التهيئة الأولية

```bash
openclaw onboard --install-daemon
```

اتبع معالج الإعداد:

1. **وضع Gateway:** محلي
2. **المصادقة:** يُوصى بمفاتيح API (قد يكون OAuth غير مستقر على Pi بدون واجهة)
3. **القنوات:** Telegram هو الأسهل للبدء
4. **الخدمة الدائمة:** نعم (systemd)

## 8) التحقق من التثبيت

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. الوصول إلى لوحة التحكم

بما أن Pi يعمل بدون واجهة، استخدم نفق SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

أو استخدم Tailscale للوصول الدائم:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## تحسينات الأداء

### استخدام USB SSD (تحسّن كبير)

بطاقات SD بطيئة وتتعرض للاهتراء. يقدّم USB SSD تحسّنًا كبيرًا في الأداء:

```bash
# Check if booting from USB
lsblk
```

راجع [دليل الإقلاع من USB على Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) للإعداد.

### تقليل استخدام الذاكرة

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### مراقبة الموارد

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ملاحظات خاصة بـ ARM

### توافق الثنائيات

تعمل معظم ميزات OpenClaw على ARM64، لكن قد تحتاج بعض الثنائيات الخارجية إلى إصدارات ARM:

| الأداة                                | حالة ARM64 | ملاحظات                             |
| ------------------------------------- | ---------- | ----------------------------------- |
| Node.js               | ✅          | يعمل بشكل ممتاز                     |
| WhatsApp (Baileys) | ✅          | JavaScript خالص، بلا مشاكل          |
| Telegram                              | ✅          | JavaScript خالص، بلا مشاكل          |
| gog (Gmail CLI)    | ⚠️         | تحقّق من توفر إصدار ARM             |
| Chromium (browser) | ✅          | `sudo apt install chromium-browser` |

إذا فشلت إحدى Skills، تحقّق مما إذا كانت الثنائيات لها إصدار ARM. كثير من أدوات Go/Rust تدعم ذلك؛ وبعضها لا.

### 32-بت مقابل 64-بت

**استخدم دائمًا نظام 64-بت.** يتطلبه Node.js والعديد من الأدوات الحديثة. تحقّق باستخدام:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## إعداد النموذج المُوصى به

بما أن Pi يعمل فقط كـ Gateway (والنماذج تعمل في السحابة)، استخدم نماذج تعتمد على API:

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

**لا تحاول تشغيل نماذج LLM محلية على Pi** — حتى النماذج الصغيرة بطيئة جدًا. دع Claude/GPT يتكفّلان بالعمل الثقيل.

---

## التشغيل التلقائي عند الإقلاع

يُعدّه معالج التهيئة الأولية تلقائيًا، لكن للتحقق:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## استكشاف الأخطاء وإصلاحها

### نفاد الذاكرة (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### بطء الأداء

- استخدم USB SSD بدل بطاقة SD
- عطّل الخدمات غير المستخدمة: `sudo systemctl disable cups bluetooth avahi-daemon`
- تحقّق من خنق المعالج: `vcgencmd get_throttled` (يجب أن يُرجع `0x0`)

### الخدمة لا تبدأ

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### مشكلات ثنائيات ARM

إذا فشلت إحدى Skills مع رسالة "exec format error":

1. تحقّق من توفر إصدار ARM64 للثنائي
2. جرّب البناء من المصدر
3. أو استخدم حاوية Docker بدعم ARM

### انقطاع WiFi

لأجهزة Pi بدون واجهة تعمل عبر WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## مقارنة التكاليف

| الإعداد                           | تكلفة لمرة واحدة     | تكلفة شهرية               | ملاحظات                                               |
| --------------------------------- | -------------------- | ------------------------- | ----------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                        | + كهرباء (~$5/سنة) |
| **Pi 4 (4GB)** | ~$55 | $0                        | مُوصى به                                              |
| **Pi 5 (4GB)** | ~$60 | $0                        | أفضل أداء                                             |
| **Pi 5 (8GB)** | ~$80 | $0                        | مبالغ فيه لكنه مستقبلي                                |
| DigitalOcean                      | $0                   | $6/شهر                    | $72/سنة                                               |
| Hetzner                           | $0                   | €3.79/شهر | ~$50/سنة                              |

**نقطة التعادل:** يعوّض Pi تكلفته خلال ~6–12 شهرًا مقارنةً بخادم VPS سحابي.

---

## انظر أيضًا

- [دليل Linux](/platforms/linux) — إعداد Linux العام
- [دليل DigitalOcean](/platforms/digitalocean) — بديل سحابي
- [دليل Hetzner](/install/hetzner) — إعداد Docker
- [Tailscale](/gateway/tailscale) — وصول عن بُعد
- [Nodes](/nodes) — إقران الحاسوب المحمول/الهاتف مع Gateway الخاص بـ Pi
