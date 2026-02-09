---
summary: "DigitalOcean پر OpenClaw (سادا بامعاوضہ VPS آپشن)"
read_when:
  - DigitalOcean پر OpenClaw سیٹ اپ کرنا
  - OpenClaw کے لیے سستی VPS ہوسٹنگ تلاش کرنا
title: "DigitalOcean"
---

# DigitalOcean پر OpenClaw

## ہدف

DigitalOcean پر ایک مستقل OpenClaw Gateway چلانا **$6/ماہ** میں (یا ریزروڈ پرائسنگ کے ساتھ $4/ماہ)۔

اگر آپ $0/ماہ کا آپشن چاہتے ہیں اور ARM + فراہم کنندہ مخصوص سیٹ اپ سے پرہیز نہیں کرتے، تو [Oracle Cloud گائیڈ](/platforms/oracle) دیکھیں۔

## لاگت کا موازنہ (2026)

| فراہم کنندہ  | پلان            | خصوصیات             | قیمت/ماہ                                                       | نوٹس                                    |
| ------------ | --------------- | ------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Oracle Cloud | Always Free ARM | 4 OCPU تک، 24GB RAM | $0                                                             | ARM، محدود گنجائش / سائن اپ کی باریکیاں |
| Hetzner      | CX22            | 2 vCPU، 4GB RAM     | €3.79 (~$4) | سب سے سستا بامعاوضہ آپشن                |
| DigitalOcean | Basic           | 1 vCPU، 1GB RAM     | $6                                                             | آسان UI، اچھی دستاویزات                 |
| Vultr        | Cloud Compute   | 1 vCPU، 1GB RAM     | $6                                                             | کئی مقامات                              |
| Linode       | Nanode          | 1 vCPU، 1GB RAM     | $5                                                             | اب Akamai کا حصہ                        |

**فراہم کنندہ کا انتخاب:**

- DigitalOcean: سب سے سادہ UX + پیش گوئی کے قابل سیٹ اپ (یہ گائیڈ)
- Hetzner: اچھی قیمت/کارکردگی (دیکھیں [Hetzner گائیڈ](/install/hetzner))
- Oracle Cloud: $0/ماہ ممکن، مگر زیادہ نازک اور صرف ARM (دیکھیں [Oracle گائیڈ](/platforms/oracle))

---

## پیشگی تقاضے

- DigitalOcean اکاؤنٹ ([$200 مفت کریڈٹ کے ساتھ سائن اپ](https://m.do.co/c/signup))
- SSH کلید جوڑا (یا پاس ورڈ تصدیق استعمال کرنے کی آمادگی)
- تقریباً 20 منٹ

## 1. Droplet بنائیں

1. [DigitalOcean](https://cloud.digitalocean.com/) میں لاگ اِن کریں
2. **Create → Droplets** پر کلک کریں
3. منتخب کریں:
   - **Region:** آپ کے قریب ترین (یا آپ کے صارفین کے قریب)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU، 1GB RAM، 25GB SSD)
   - **Authentication:** SSH key (سفارش کردہ) یا پاس ورڈ
4. **Create Droplet** پر کلک کریں
5. IP ایڈریس نوٹ کریں

## 2) SSH کے ذریعے کنیکٹ کریں

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw انسٹال کریں

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

## 4. آن بورڈنگ چلائیں

```bash
openclaw onboard --install-daemon
```

وزارڈ آپ کی رہنمائی کرے گا:

- ماڈل تصدیق (API کلیدیں یا OAuth)
- چینل سیٹ اپ (Telegram، WhatsApp، Discord وغیرہ)
- Gateway ٹوکن (خودکار طور پر تیار)
- ڈیمَن انسٹالیشن (systemd)

## 5. Gateway کی تصدیق کریں

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. ڈیش بورڈ تک رسائی

20. گیٹ وے ڈیفالٹ طور پر لوپ بیک پر بائنڈ ہوتا ہے۔ 21. کنٹرول UI تک رسائی کے لیے:

**آپشن A: SSH Tunnel (سفارش کردہ)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**آپشن B: Tailscale Serve (HTTPS، صرف loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

کھولیں: `https://<magicdns>/`

نوٹس:

- Serve، Gateway کو loopback تک محدود رکھتا ہے اور Tailscale شناختی ہیڈرز کے ذریعے تصدیق کرتا ہے۔
- اس کے بجائے ٹوکن/پاس ورڈ درکار کرنے کے لیے، `gateway.auth.allowTailscale: false` سیٹ کریں یا `gateway.auth.mode: "password"` استعمال کریں۔

**آپشن C: Tailnet bind (Serve کے بغیر)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

کھولیں: `http://<tailscale-ip>:18789` (ٹوکن درکار)۔

## 7. اپنے چینلز کنیکٹ کریں

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

دیگر فراہم کنندگان کے لیے [Channels](/channels) دیکھیں۔

---

## 1GB RAM کے لیے بہتر بنانا

The $6 droplet only has 1GB RAM. 23. چیزوں کو ہموار طریقے سے چلانے کے لیے:

### Swap شامل کریں (سفارش کردہ)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### ہلکا ماڈل استعمال کریں

اگر OOM مسائل آ رہے ہوں تو غور کریں:

- لوکل ماڈلز کے بجائے API پر مبنی ماڈلز (Claude، GPT) استعمال کریں
- `agents.defaults.model.primary` کو چھوٹے ماڈل پر سیٹ کریں

### میموری مانیٹر کریں

```bash
free -h
htop
```

---

## تسلسل (Persistence)

تمام اسٹیٹ یہاں محفوظ ہوتی ہے:

- `~/.openclaw/` — کنفیگ، اسناد، سیشن ڈیٹا
- `~/.openclaw/workspace/` — ورک اسپیس (SOUL.md، میموری وغیرہ)

24. یہ ریبوٹس کے بعد بھی برقرار رہتے ہیں۔ 25. انہیں باقاعدگی سے بیک اپ کریں:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud کا مفت متبادل

Oracle Cloud **Always Free** ARM انسٹینسز فراہم کرتا ہے جو یہاں موجود کسی بھی بامعاوضہ آپشن سے کہیں زیادہ طاقتور ہیں — $0/ماہ میں۔

| آپ کو کیا ملتا ہے | خصوصیات                   |
| ----------------- | ------------------------- |
| **4 OCPUs**       | ARM Ampere A1             |
| **24GB RAM**      | ضرورت سے زیادہ            |
| **200GB اسٹوریج** | بلاک والیوم               |
| **ہمیشہ مفت**     | کوئی کریڈٹ کارڈ چارج نہیں |

**احتیاطی نکات:**

- سائن اپ نازک ہو سکتا ہے (ناکام ہو تو دوبارہ کوشش کریں)
- ARM آرکیٹیکچر — زیادہ تر چیزیں کام کرتی ہیں، مگر کچھ بائنریز کے لیے ARM بلڈ درکار ہوتے ہیں

For the full setup guide, see [Oracle Cloud](/platforms/oracle). 27. سائن اپ کی تجاویز اور اندراج کے عمل میں مسائل کے حل کے لیے یہ [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) دیکھیں۔

---

## خرابیوں کا ازالہ

### Gateway شروع نہیں ہو رہا

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### پورٹ پہلے سے استعمال میں ہے

```bash
lsof -i :18789
kill <PID>
```

### میموری ختم ہو جانا

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## یہ بھی دیکھیں

- [Hetzner گائیڈ](/install/hetzner) — سستا، زیادہ طاقتور
- [Docker انسٹال](/install/docker) — کنٹینرائزڈ سیٹ اپ
- [Tailscale](/gateway/tailscale) — محفوظ ریموٹ رسائی
- [Configuration](/gateway/configuration) — مکمل کنفیگ حوالہ
