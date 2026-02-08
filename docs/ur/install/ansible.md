---
summary: "Ansible، Tailscale VPN، اور فائر وال آئسولیشن کے ساتھ خودکار، مضبوط OpenClaw انسٹالیشن"
read_when:
  - آپ سکیورٹی مضبوطی کے ساتھ خودکار سرور ڈپلائمنٹ چاہتے ہیں
  - آپ کو VPN رسائی کے ساتھ فائر وال سے الگ سیٹ اپ درکار ہے
  - آپ ریموٹ Debian/Ubuntu سرورز پر ڈپلائے کر رہے ہیں
title: "Ansible"
x-i18n:
  source_path: install/ansible.md
  source_hash: b1e1e1ea13bff37b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:30Z
---

# Ansible انسٹالیشن

پروڈکشن سرورز پر OpenClaw ڈپلائے کرنے کا تجویز کردہ طریقہ **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** کے ذریعے ہے — ایک خودکار انسٹالر جس کی معماری سکیورٹی کو اولین ترجیح دیتی ہے۔

## فوری آغاز

ایک کمانڈ میں انسٹال:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 مکمل رہنما: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible ریپو Ansible ڈپلائمنٹ کے لیے مستند ماخذ ہے۔ یہ صفحہ ایک مختصر جائزہ فراہم کرتا ہے۔

## آپ کو کیا ملتا ہے

- 🔒 **فائر وال اولین سکیورٹی**: UFW + Docker آئسولیشن (صرف SSH + Tailscale قابلِ رسائی)
- 🔐 **Tailscale VPN**: سروسز کو عوامی طور پر ظاہر کیے بغیر محفوظ ریموٹ رسائی
- 🐳 **Docker**: الگ تھلگ sandbox کنٹینرز، صرف localhost بائنڈنگز
- 🛡️ **گہرائی میں دفاع**: 4-سطحی سکیورٹی معماری
- 🚀 **ایک کمانڈ سیٹ اپ**: منٹوں میں مکمل ڈپلائمنٹ
- 🔧 **Systemd انضمام**: بوٹ پر خودکار آغاز مع سختی

## ضروریات

- **OS**: Debian 11+ یا Ubuntu 20.04+
- **رسائی**: روٹ یا sudo مراعات
- **نیٹ ورک**: پیکجز کی انسٹالیشن کے لیے انٹرنیٹ کنکشن
- **Ansible**: 2.14+ (فوری آغاز اسکرپٹ کے ذریعے خودکار طور پر انسٹال ہوتا ہے)

## کیا انسٹال ہوتا ہے

Ansible پلے بک درج ذیل کو انسٹال اور کنفیگر کرتی ہے:

1. **Tailscale** (محفوظ ریموٹ رسائی کے لیے میش VPN)
2. **UFW فائر وال** (صرف SSH + Tailscale پورٹس)
3. **Docker CE + Compose V2** (ایجنٹ sandbox کے لیے)
4. **Node.js 22.x + pnpm** (رن ٹائم انحصارات)
5. **OpenClaw** (ہوسٹ پر مبنی، کنٹینرائزڈ نہیں)
6. **Systemd سروس** (سکیورٹی سختی کے ساتھ خودکار آغاز)

نوٹ: Gateway **براہِ راست ہوسٹ پر** چلتا ہے (Docker میں نہیں)، لیکن ایجنٹ sandbox آئسولیشن کے لیے Docker استعمال کرتے ہیں۔ تفصیلات کے لیے [Sandboxing](/gateway/sandboxing) دیکھیں۔

## انسٹالیشن کے بعد سیٹ اپ

انسٹالیشن مکمل ہونے کے بعد openclaw صارف پر سوئچ کریں:

```bash
sudo -i -u openclaw
```

بعد از انسٹال اسکرپٹ آپ کو درج ذیل میں رہنمائی کرے گا:

1. **آن بورڈنگ وزرڈ**: OpenClaw سیٹنگز کنفیگر کریں
2. **فراہم کنندہ لاگ اِن**: WhatsApp/Telegram/Discord/Signal سے کنیکٹ کریں
3. **Gateway جانچ**: انسٹالیشن کی تصدیق کریں
4. **Tailscale سیٹ اپ**: اپنے VPN میش سے کنیکٹ کریں

### فوری کمانڈز

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## سکیورٹی معماری

### 4-سطحی دفاع

1. **فائر وال (UFW)**: عوامی طور پر صرف SSH (22) + Tailscale (41641/udp) ایکسپوز
2. **VPN (Tailscale)**: Gateway صرف VPN میش کے ذریعے قابلِ رسائی
3. **Docker آئسولیشن**: DOCKER-USER iptables چین بیرونی پورٹ ایکسپوژر کو روکتی ہے
4. **Systemd سختی**: NoNewPrivileges، PrivateTmp، غیر مراعات یافتہ صارف

### تصدیق

بیرونی اٹیک سرفیس کی جانچ کریں:

```bash
nmap -p- YOUR_SERVER_IP
```

اس میں **صرف پورٹ 22** (SSH) کھلا دکھنا چاہیے۔ دیگر تمام سروسز (Gateway، Docker) لاک ڈاؤن ہیں۔

### Docker دستیابی

Docker **ایجنٹ sandbox** (الگ تھلگ اوزار اجرا) کے لیے انسٹال ہوتا ہے، خود Gateway چلانے کے لیے نہیں۔ Gateway صرف localhost پر بائنڈ ہوتا ہے اور Tailscale VPN کے ذریعے قابلِ رسائی ہے۔

sandbox کنفیگریشن کے لیے [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) دیکھیں۔

## دستی انسٹالیشن

اگر آپ خودکار عمل پر دستی کنٹرول کو ترجیح دیتے ہیں:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw کی اپڈیٹنگ

Ansible انسٹالر OpenClaw کو دستی اپڈیٹس کے لیے سیٹ اپ کرتا ہے۔ معیاری اپڈیٹ فلو کے لیے [Updating](/install/updating) دیکھیں۔

Ansible پلے بک دوبارہ چلانے کے لیے (مثلاً کنفیگریشن تبدیلیوں کے لیے):

```bash
cd openclaw-ansible
./run-playbook.sh
```

نوٹ: یہ idempotent ہے اور متعدد بار چلانا محفوظ ہے۔

## خرابیوں کا ازالہ

### فائر وال میری کنکشن بلاک کر رہا ہے

اگر آپ لاک آؤٹ ہو جائیں:

- پہلے Tailscale VPN کے ذریعے رسائی یقینی بنائیں
- SSH رسائی (پورٹ 22) ہمیشہ اجازت یافتہ ہے
- Gateway بطورِ ڈیزائن **صرف** Tailscale کے ذریعے قابلِ رسائی ہے

### سروس شروع نہیں ہوتی

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker sandbox مسائل

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### فراہم کنندہ لاگ اِن ناکام

یقینی بنائیں کہ آپ `openclaw` صارف کے طور پر چل رہے ہیں:

```bash
sudo -i -u openclaw
openclaw channels login
```

## اعلیٰ درجے کی کنفیگریشن

تفصیلی سکیورٹی معماری اور خرابیوں کے ازالے کے لیے:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## متعلقہ

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — مکمل ڈپلائمنٹ رہنما
- [Docker](/install/docker) — کنٹینرائزڈ Gateway سیٹ اپ
- [Sandboxing](/gateway/sandboxing) — ایجنٹ sandbox کنفیگریشن
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — ہر ایجنٹ کے لیے آئسولیشن
