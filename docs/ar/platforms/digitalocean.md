---
summary: "OpenClaw على DigitalOcean (خيار VPS مدفوع بسيط)"
read_when:
  - إعداد OpenClaw على DigitalOcean
  - البحث عن استضافة VPS منخفضة التكلفة لـ OpenClaw
title: "DigitalOcean"
---

# OpenClaw على DigitalOcean

## الهدف

تشغيل Gateway لـ OpenClaw بشكل دائم على DigitalOcean مقابل **6 دولارات شهريًا** (أو 4 دولارات شهريًا مع التسعير المحجوز).

إذا كنت تريد خيارًا بقيمة 0 دولار شهريًا ولا تمانع ARM وإعدادًا خاصًا بالموفّر، فاطّلع على [دليل Oracle Cloud](/platforms/oracle).

## مقارنة التكاليف (2026)

| Provider     | الخطة           | المواصفات            | السعر/شهر                                                      | الملاحظات                         |
| ------------ | --------------- | -------------------- | -------------------------------------------------------------- | --------------------------------- |
| Oracle Cloud | Always Free ARM | حتى 4 OCPU، 24GB RAM | $0                                                             | ARM، سعة محدودة / تعقيدات التسجيل |
| Hetzner      | CX22            | 2 vCPU، 4GB RAM      | €3.79 (~$4) | أرخص خيار مدفوع                   |
| DigitalOcean | Basic           | 1 vCPU، 1GB RAM      | $6                                                             | واجهة سهلة، توثيق جيد             |
| Vultr        | Cloud Compute   | 1 vCPU، 1GB RAM      | $6                                                             | مواقع عديدة                       |
| Linode       | Nanode          | 1 vCPU، 1GB RAM      | $5                                                             | أصبح الآن جزءًا من Akamai         |

**اختيار المزوّد:**

- DigitalOcean: أبسط تجربة استخدام + إعداد متوقّع (هذا الدليل)
- Hetzner: سعر/أداء جيد (انظر [دليل Hetzner](/install/hetzner))
- Oracle Cloud: قد يكون 0 دولار/شهر، لكنه أكثر حساسية وARM فقط (انظر [دليل Oracle](/platforms/oracle))

---

## المتطلبات المسبقة

- حساب DigitalOcean ([التسجيل مع رصيد مجاني بقيمة 200 دولار](https://m.do.co/c/signup))
- زوج مفاتيح SSH (أو الاستعداد لاستخدام المصادقة بكلمة مرور)
- ~20 دقيقة

## 1. إنشاء Droplet

1. سجّل الدخول إلى [DigitalOcean](https://cloud.digitalocean.com/)
2. انقر **Create → Droplets**
3. اختر:
   - **المنطقة:** الأقرب إليك (أو إلى مستخدميك)
   - **الصورة:** Ubuntu 24.04 LTS
   - **الحجم:** Basic → Regular → **$6/mo** (1 vCPU، 1GB RAM، 25GB SSD)
   - **المصادقة:** مفتاح SSH (موصى به) أو كلمة مرور
4. انقر **Create Droplet**
5. دوّن عنوان IP

## 2) الاتصال عبر SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. تثبيت OpenClaw

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

## 4. تشغيل التهيئة الأولية

```bash
openclaw onboard --install-daemon
```

سيمشي المعالج من خلال:

- مصادقة النموذج (مفاتيح API أو OAuth)
- إعداد القنوات (Telegram، WhatsApp، Discord، إلخ)
- رمز Gateway (يُنشأ تلقائيًا)
- تثبيت الخدمة (systemd)

## 5. التحقق من Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. الوصول إلى لوحة التحكم

يرتبط Gateway بالـ loopback افتراضيًا. للوصول إلى واجهة التحكم:

**الخيار A: نفق SSH (موصى به)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**الخيار B: Tailscale Serve (HTTPS، loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

افتح: `https://<magicdns>/`

ملاحظات:

- يحافظ Serve على Gateway ضمن loopback-only ويصادق عبر رؤوس هوية Tailscale.
- لفرض رمز/كلمة مرور بدلًا من ذلك، عيّن `gateway.auth.allowTailscale: false` أو استخدم `gateway.auth.mode: "password"`.

**الخيار C: ربط Tailnet (بدون Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

افتح: `http://<tailscale-ip>:18789` (يتطلب رمزًا).

## 7. ربط قنواتك

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

اطّلع على [القنوات](/channels) لمزوّدين آخرين.

---

## تحسينات لذاكرة 1GB RAM

Droplet بقيمة 6 دولارات يحتوي على 1GB RAM فقط. للحفاظ على سلاسة التشغيل:

### إضافة swap (موصى به)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### استخدام نموذج أخف

إذا كنت تضرب OOM، فكر:

- استخدام نماذج قائمة على API (Claude، GPT) بدل النماذج المحلية
- تعيين `agents.defaults.model.primary` إلى نموذج أصغر

### مراقبة الذاكرة

```bash
free -h
htop
```

---

## الاستمرارية

توجد جميع الحالة في:

- `~/.openclaw/` — التهيئة، بيانات الاعتماد، بيانات الجلسة
- `~/.openclaw/workspace/` — مساحة العمل (SOUL.md، الذاكرة، إلخ)

تبقى هذه بعد إعادة التشغيل. قم بعمل نسخ احتياطية دوريًا:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## بديل Oracle Cloud المجاني

تقدّم Oracle Cloud مثيلات ARM **Always Free** أقوى بكثير من أي خيار مدفوع هنا — مقابل 0 دولار شهريًا.

| ما ستحصل عليه   | المواصفات              |
| --------------- | ---------------------- |
| **4 OCPUs**     | ARM Ampere A1          |
| **24GB RAM**    | أكثر من كافٍ           |
| **200GB تخزين** | Block volume           |
| **مجاني للأبد** | بدون رسوم بطاقة ائتمان |

**محاذير:**

- قد تكون عملية التسجيل حسّاسة (أعد المحاولة إذا فشلت)
- معمارية ARM — يعمل معظم الأشياء، لكن بعض الثنائيات تحتاج إصدارات ARM

للاطلاع على دليل الإعداد الكامل، انظر [Oracle Cloud](/platforms/oracle). ولنصائح التسجيل واستكشاف أخطاء عملية الانضمام، راجع هذا [دليل المجتمع](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## استكشاف الأخطاء وإصلاحها

### Gateway لا يبدأ

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### المنفذ مستخدم بالفعل

```bash
lsof -i :18789
kill <PID>
```

### نفاد الذاكرة

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## انظر أيضًا

- [دليل Hetzner](/install/hetzner) — أرخص وأكثر قوة
- [تثبيت Docker](/install/docker) — إعداد بالحاويات
- [Tailscale](/gateway/tailscale) — وصول آمن عن بُعد
- [التهيئة](/gateway/configuration) — مرجع التهيئة الكامل
