---
summary: "Oracle Cloud (Always Free ARM) پر OpenClaw"
read_when:
  - Oracle Cloud پر OpenClaw سیٹ اپ کر رہے ہوں
  - OpenClaw کے لیے کم لاگت VPS ہوسٹنگ تلاش کر رہے ہوں
  - چھوٹے سرور پر 24/7 OpenClaw چلانا چاہتے ہوں
title: "Oracle Cloud"
---

# Oracle Cloud (OCI) پر OpenClaw

## مقصد

Oracle Cloud کے **Always Free** ARM ٹیر پر ایک مستقل OpenClaw Gateway چلانا۔

Oracle کا فری ٹیر OpenClaw کے لیے ایک اچھا انتخاب ہو سکتا ہے (خاص طور پر اگر آپ کے پاس پہلے سے OCI اکاؤنٹ ہو)، لیکن اس کے ساتھ کچھ سمجھوتے بھی ہیں:

- ARM آرکیٹیکچر (زیادہ تر چیزیں کام کرتی ہیں، لیکن کچھ بائنریز صرف x86 کے لیے ہو سکتی ہیں)
- صلاحیت اور سائن اپ بعض اوقات مشکل ہو سکتے ہیں

## لاگت کا موازنہ (2026)

| فراہم کنندہ  | پلان            | خصوصیات                         | ماہانہ قیمت          | نوٹس                     |
| ------------ | --------------- | ------------------------------- | -------------------- | ------------------------ |
| Oracle Cloud | Always Free ARM | زیادہ سے زیادہ 4 OCPU، 24GB RAM | $0                   | ARM، محدود صلاحیت        |
| Hetzner      | CX22            | 2 vCPU، 4GB RAM                 | ~ $4 | سب سے سستا بامعاوضہ آپشن |
| DigitalOcean | Basic           | 1 vCPU، 1GB RAM                 | $6                   | آسان UI، اچھی دستاویزات  |
| Vultr        | Cloud Compute   | 1 vCPU، 1GB RAM                 | $6                   | کئی مقامات               |
| Linode       | Nanode          | 1 vCPU، 1GB RAM                 | $5                   | اب Akamai کا حصہ         |

---

## پیشگی تقاضے

- Oracle Cloud اکاؤنٹ ([signup](https://www.oracle.com/cloud/free/)) — اگر مسائل آئیں تو [کمیونٹی سائن اپ گائیڈ](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) دیکھیں
- Tailscale اکاؤنٹ (مفت: [tailscale.com](https://tailscale.com))
- تقریباً 30 منٹ

## 1. OCI انسٹینس بنائیں

1. [Oracle Cloud Console](https://cloud.oracle.com/) میں لاگ اِن کریں
2. **Compute → Instances → Create Instance** پر جائیں
3. کنفیگر کریں:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (یا زیادہ سے زیادہ 4)
   - **Memory:** 12 GB (یا زیادہ سے زیادہ 24 GB)
   - **Boot volume:** 50 GB (200 GB تک مفت)
   - **SSH key:** اپنی پبلک کی شامل کریں
4. **Create** پر کلک کریں
5. پبلک IP ایڈریس نوٹ کریں

39) فری ٹئیر کی گنجائش محدود ہے۔ 40. جب پوچھا جائے "How do you want to hatch your bot?" تو **"Do this later"** منتخب کریں۔

## 2. کنیکٹ کریں اور اپ ڈیٹ کریں

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**نوٹ:** `build-essential` بعض dependencies کی ARM کمپائلیشن کے لیے ضروری ہے۔

## 3. یوزر اور ہوسٹ نیم کنفیگر کریں

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale انسٹال کریں

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

اس سے Tailscale SSH فعال ہو جاتا ہے، تاکہ آپ اپنے tailnet کے کسی بھی ڈیوائس سے `ssh openclaw` کے ذریعے کنیکٹ کر سکیں — پبلک IP کی ضرورت نہیں۔

تصدیق کریں:

```bash
tailscale status
```

**اب سے، Tailscale کے ذریعے کنیکٹ کریں:** `ssh ubuntu@openclaw` (یا Tailscale IP استعمال کریں)۔

## 5. OpenClaw انسٹال کریں

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

41. ڈیفالٹ کے طور پر ٹوکن آتھنٹیکیشن استعمال کریں۔

> نوٹ: اگر ARM-native build کے مسائل آئیں تو Homebrew کی طرف جانے سے پہلے سسٹم پیکیجز سے آغاز کریں (مثلاً `sudo apt install -y build-essential`)۔

## 6. Gateway کنفیگر کریں (loopback + token auth) اور Tailscale Serve فعال کریں

42. یہ پیش گوئی کے قابل ہے اور کسی بھی “insecure auth” کنٹرول UI فلیگز کی ضرورت سے بچاتا ہے۔ 43. اب جب سب کچھ کام کر رہا ہے، VCN کو لاک ڈاؤن کریں تاکہ Tailscale کے علاوہ تمام ٹریفک بلاک ہو جائے۔

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

## 7. تصدیق

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

## 8. VCN سکیورٹی لاک ڈاؤن کریں

44. OCI کی Virtual Cloud Network نیٹ ورک ایج پر فائر وال کے طور پر کام کرتی ہے — ٹریفک انسٹینس تک پہنچنے سے پہلے ہی بلاک ہو جاتی ہے۔ 45. یہ نیٹ ورک ایج پر پورٹ 22 پر SSH، HTTP، HTTPS، اور باقی سب کچھ بلاک کر دیتا ہے۔

1. OCI Console میں **Networking → Virtual Cloud Networks** پر جائیں
2. اپنا VCN منتخب کریں → **Security Lists** → Default Security List
3. تمام ingress قواعد **ہٹا دیں** سوائے:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. ڈیفالٹ egress قواعد برقرار رکھیں (تمام آؤٹ باؤنڈ کی اجازت)

46) اب سے، آپ صرف Tailscale کے ذریعے کنیکٹ کر سکتے ہیں۔ 47. کسی SSH ٹنل کی ضرورت نہیں۔

---

## Control UI تک رسائی

اپنے Tailscale نیٹ ورک کے کسی بھی ڈیوائس سے:

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` کو اپنے tailnet کے نام سے بدلیں (جو `tailscale status` میں نظر آتا ہے)۔

48. Tailscale فراہم کرتا ہے: 49. فری ٹئیر ARM انسٹینسز مقبول ہیں۔

- HTTPS انکرپشن (خودکار سرٹیفکیٹس)
- Tailscale شناخت کے ذریعے تصدیق
- اپنے tailnet کے کسی بھی ڈیوائس سے رسائی (لیپ ٹاپ، فون وغیرہ)

---

## سکیورٹی: VCN + Tailscale (سفارش کردہ بنیاد)

VCN کے لاک ڈاؤن (صرف UDP 41641 کھلا) اور Gateway کے loopback سے بائنڈ ہونے کے ساتھ، آپ کو مضبوط defense-in-depth ملتا ہے: عوامی ٹریفک نیٹ ورک ایج پر بلاک ہو جاتی ہے، اور ایڈمن رسائی آپ کے tailnet کے ذریعے ہوتی ہے۔

یہ سیٹ اپ اکثر انٹرنیٹ بھر میں SSH brute force روکنے کے لیے اضافی ہوسٹ بیسڈ فائر وال قواعد کی _ضرورت_ ختم کر دیتا ہے — لیکن پھر بھی آپ کو OS اپ ڈیٹ رکھنا چاہیے، `openclaw security audit` چلانا چاہیے، اور تصدیق کرنی چاہیے کہ آپ غلطی سے پبلک انٹرفیسز پر سن نہیں رہے۔

### پہلے سے محفوظ چیزیں

| روایتی قدم            | ضروری؟      | وجہ                                                                     |
| --------------------- | ----------- | ----------------------------------------------------------------------- |
| UFW فائر وال          | نہیں        | VCN ٹریفک انسٹینس تک پہنچنے سے پہلے بلاک کر دیتا ہے                     |
| fail2ban              | نہیں        | اگر پورٹ 22 VCN پر بلاک ہو تو brute force نہیں ہوتا                     |
| sshd سختی             | نہیں        | Tailscale SSH، sshd استعمال نہیں کرتا                                   |
| روٹ لاگ اِن غیر فعال  | نہیں        | Tailscale سسٹم یوزرز نہیں بلکہ Tailscale شناخت استعمال کرتا ہے          |
| صرف SSH کی آتھنٹیکیشن | نہیں        | Tailscale آپ کے tailnet کے ذریعے تصدیق کرتا ہے                          |
| IPv6 سختی             | عموماً نہیں | آپ کے VCN/subnet سیٹنگز پر منحصر؛ تصدیق کریں کیا واقعی اسائن/ایکسپوز ہے |

### پھر بھی سفارش کردہ

- **Credential اجازتیں:** `chmod 700 ~/.openclaw`
- **سکیورٹی آڈٹ:** `openclaw security audit`
- **سسٹم اپ ڈیٹس:** باقاعدگی سے `sudo apt update && sudo apt upgrade`
- **Tailscale مانیٹر کریں:** [Tailscale admin console](https://login.tailscale.com/admin) میں ڈیوائسز کا جائزہ لیں

### سکیورٹی اسٹیٹس کی تصدیق

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## متبادل: SSH سرنگ

اگر Tailscale Serve کام نہیں کر رہا، تو SSH سرنگ استعمال کریں:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

پھر `http://localhost:18789` کھولیں۔

---

## خرابیوں کا ازالہ

### انسٹینس بنانا ناکام ("Out of capacity")

Free tier ARM instances are popular. Try:

- مختلف availability domain
- آف پیک اوقات میں دوبارہ کوشش (صبح سویرے)
- shape منتخب کرتے وقت "Always Free" فلٹر استعمال کریں

### Tailscale کنیکٹ نہیں ہو رہا

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway شروع نہیں ہو رہا

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI تک رسائی نہیں ہو رہی

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM بائنری مسائل

Some tools may not have ARM builds. Check:

```bash
uname -m  # Should show aarch64
```

Most npm packages work fine. For binaries, look for `linux-arm64` or `aarch64` releases.

---

## استحکام (Persistence)

تمام اسٹیٹ یہاں محفوظ ہوتی ہے:

- `~/.openclaw/` — کنفیگ، اسناد، سیشن ڈیٹا
- `~/.openclaw/workspace/` — ورک اسپیس (SOUL.md، میموری، آرٹی فیکٹس)

باقاعدگی سے بیک اپ لیں:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## یہ بھی دیکھیں

- [Gateway remote access](/gateway/remote) — دیگر ریموٹ رسائی پیٹرنز
- [Tailscale integration](/gateway/tailscale) — مکمل Tailscale دستاویزات
- [Gateway configuration](/gateway/configuration) — تمام کنفیگ اختیارات
- [DigitalOcean guide](/platforms/digitalocean) — اگر بامعاوضہ + آسان سائن اپ چاہتے ہوں
- [Hetzner guide](/install/hetzner) — Docker پر مبنی متبادل
