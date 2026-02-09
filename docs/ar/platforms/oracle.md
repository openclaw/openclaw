---
summary: "OpenClaw على Oracle Cloud (Always Free ARM)"
read_when:
  - إعداد OpenClaw على Oracle Cloud
  - البحث عن استضافة VPS منخفضة التكلفة لـ OpenClaw
  - الرغبة في تشغيل OpenClaw على مدار 24/7 على خادم صغير
title: "Oracle Cloud"
---

# OpenClaw على Oracle Cloud (OCI)

## الهدف

تشغيل Gateway دائم لـ OpenClaw على طبقة **Always Free** من Oracle Cloud بمعمارية ARM.

يمكن أن تكون الطبقة المجانية من Oracle خيارًا مناسبًا لـ OpenClaw (خصوصًا إذا كان لديك حساب OCI بالفعل)، لكنها تأتي مع بعض التنازلات:

- معمارية ARM (معظم الأشياء تعمل، لكن بعض الثنائيات قد تكون x86 فقط)
- السعة والاشتراك يمكن أن يكونا جيدين

## مقارنة التكاليف (2026)

| Provider     | الخطة           | المواصفات            | السعر/شهر            | الملاحظات             |
| ------------ | --------------- | -------------------- | -------------------- | --------------------- |
| Oracle Cloud | Always Free ARM | حتى 4 OCPU، 24GB RAM | $0                   | ARM، سعة محدودة       |
| Hetzner      | CX22            | 2 vCPU، 4GB RAM      | ~ $4 | أرخص خيار مدفوع       |
| DigitalOcean | Basic           | 1 vCPU، 1GB RAM      | $6                   | واجهة سهلة، توثيق جيد |
| Vultr        | Cloud Compute   | 1 vCPU، 1GB RAM      | $6                   | مواقع عديدة           |
| Linode       | Nanode          | 1 vCPU، 1GB RAM      | $5                   | أصبح جزءًا من Akamai  |

---

## المتطلبات المسبقة

- حساب Oracle Cloud ([التسجيل](https://www.oracle.com/cloud/free/)) — راجع [دليل التسجيل المجتمعي](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) إذا واجهت مشكلات
- حساب Tailscale (مجاني على [tailscale.com](https://tailscale.com))
- حوالي 30 دقيقة

## 1. إنشاء مثيل OCI

1. سجّل الدخول إلى [Oracle Cloud Console](https://cloud.oracle.com/)
2. انتقل إلى **Compute → Instances → Create Instance**
3. قم بالتهيئة:
   - **الاسم:** `openclaw`
   - **الصورة:** Ubuntu 24.04 (aarch64)
   - **النوع:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** ‏2 (أو حتى 4)
   - **الذاكرة:** ‏12 GB (أو حتى 24 GB)
   - **قرص الإقلاع:** ‏50 GB (حتى 200 GB مجانًا)
   - **مفتاح SSH:** أضف مفتاحك العام
4. انقر **Create**
5. دوّن عنوان IP العام

**نصيحة:** إذا فشل إنشاء المثيل برسالة «Out of capacity»، جرّب نطاق توفر مختلف أو أعد المحاولة لاحقًا. سعة الطبقة المجانية محدودة.

## 2. الاتصال والتحديث

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**ملاحظة:** `build-essential` مطلوب لتجميع بعض الاعتمادات على ARM.

## 3. تهيئة المستخدم واسم المضيف

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. تثبيت Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

يُمكّن ذلك SSH عبر Tailscale، بحيث يمكنك الاتصال عبر `ssh openclaw` من أي جهاز على tailnet — دون الحاجة إلى IP عام.

تحقق:

```bash
tailscale status
```

**من الآن فصاعدًا، اتصل عبر Tailscale:** `ssh ubuntu@openclaw` (أو استخدم عنوان IP الخاص بـ Tailscale).

## 5. تثبيت OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

عند ظهور السؤال «How do you want to hatch your bot?»، اختر **"Do this later"**.

> ملاحظة: إذا واجهت مشكلات بناء أصلية على ARM، ابدأ بحزم النظام (مثل `sudo apt install -y build-essential`) قبل اللجوء إلى Homebrew.

## 6. تهيئة Gateway (loopback + مصادقة الرمز) وتمكين Tailscale Serve

استخدم مصادقة الرمز كخيار افتراضي. فهي متوقعة وتجنّب الحاجة إلى أي أعلام «insecure auth» في واجهة Control.

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

## 7. التحقق

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

## 8. تأمين VCN

بعد التأكد من أن كل شيء يعمل، قم بتأمين VCN لحظر جميع الحركة باستثناء Tailscale. تعمل Virtual Cloud Network في OCI كجدار حماية على حافة الشبكة — حيث يتم حظر الحركة قبل وصولها إلى المثيل.

1. انتقل إلى **Networking → Virtual Cloud Networks** في وحدة تحكم OCI
2. انقر على VCN الخاص بك → **Security Lists** → Default Security List
3. **أزل** جميع قواعد الدخول باستثناء:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. احتفظ بقواعد الخروج الافتراضية (السماح بجميع الاتصالات الصادرة)

يؤدي ذلك إلى حظر SSH على المنفذ 22 وHTTP وHTTPS وكل شيء آخر عند حافة الشبكة. من الآن فصاعدًا، سيكون الاتصال ممكنًا فقط عبر Tailscale.

---

## الوصول إلى واجهة Control

من أي جهاز على شبكة Tailscale الخاصة بك:

```
https://openclaw.<tailnet-name>.ts.net/
```

استبدل `<tailnet-name>` باسم tailnet الخاص بك (مرئي في `tailscale status`).

لا حاجة إلى نفق SSH. يوفر Tailscale:

- تشفير HTTPS (شهادات تلقائية)
- مصادقة عبر هوية Tailscale
- وصولًا من أي جهاز على tailnet (حاسوب محمول، هاتف، إلخ)

---

## الأمان: VCN + Tailscale (الخط الأساسي الموصى به)

مع تأمين VCN (فتح UDP 41641 فقط) وربط Gateway على local loopback، تحصل على دفاع متعدد الطبقات: يتم حظر الحركة العامة عند حافة الشبكة، ويحدث الوصول الإداري عبر tailnet الخاص بك.

غالبًا ما يلغي هذا الإعداد الحاجة إلى قواعد جدار حماية إضافية على المضيف فقط لإيقاف هجمات SSH واسعة النطاق — ولكن لا يزال ينبغي إبقاء نظام التشغيل محدثًا، وتشغيل `openclaw security audit`، والتحقق من أنك لا تستمع عن طريق الخطأ على واجهات عامة.

### ما هو محمي بالفعل

| الخطوة التقليدية        | هل هي مطلوبة؟ | السبب                                                                   |
| ----------------------- | ------------- | ----------------------------------------------------------------------- |
| جدار حماية UFW          | لا            | يقوم VCN بالحظر قبل وصول الحركة إلى المثيل                              |
| fail2ban                | لا            | لا توجد هجمات brute force إذا كان المنفذ 22 محظورًا في VCN              |
| تقوية sshd              | لا            | SSH عبر Tailscale لا يستخدم sshd                                        |
| تعطيل تسجيل دخول root   | لا            | يستخدم Tailscale هوية Tailscale وليس مستخدمي النظام                     |
| مصادقة SSH بالمفتاح فقط | لا            | يقوم Tailscale بالمصادقة عبر tailnet                                    |
| تقوية IPv6              | غالبًا لا     | يعتمد على إعدادات VCN/الشبكة الفرعية؛ تحقّق مما هو مُعيَّن/مكشوف فعليًا |

### ما لا يزال موصى به

- **أذونات بيانات الاعتماد:** `chmod 700 ~/.openclaw`
- **تدقيق أمني:** `openclaw security audit`
- **تحديثات النظام:** تشغيل `sudo apt update && sudo apt upgrade` بانتظام
- **مراقبة Tailscale:** راجع الأجهزة في [لوحة تحكم Tailscale](https://login.tailscale.com/admin)

### التحقق من الوضع الأمني

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## بديل احتياطي: نفق SSH

إذا لم يعمل Tailscale Serve، استخدم نفق SSH:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

ثم افتح `http://localhost:18789`.

---

## استكشاف الأخطاء وإصلاحها

### فشل إنشاء المثيل («Out of capacity»)

مثيلات ARM المجانية شائعة. جرّب:

- نطاق توفر مختلف
- إعادة المحاولة خارج أوقات الذروة (الصباح الباكر)
- استخدام مرشح «Always Free» عند اختيار النوع

### Tailscale لا يتصل

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway لا يبدأ

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### لا يمكن الوصول إلى واجهة Control

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### مشكلات ثنائيات ARM

قد لا تتوفر إصدارات ARM لبعض الأدوات. تحقّق من:

```bash
uname -m  # Should show aarch64
```

تعمل معظم حزم npm دون مشاكل. بالنسبة للثنائيات، ابحث عن إصدارات `linux-arm64` أو `aarch64`.

---

## الاستمرارية

توجد جميع الحالة في:

- `~/.openclaw/` — التهيئة، بيانات الاعتماد، بيانات الجلسة
- `~/.openclaw/workspace/` — مساحة العمل (SOUL.md، الذاكرة، المخرجات)

قم بالنسخ الاحتياطي دوريًا:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## انظر أيضًا

- [الوصول البعيد إلى Gateway](/gateway/remote) — أنماط وصول بعيدة أخرى
- [تكامل Tailscale](/gateway/tailscale) — توثيق Tailscale الكامل
- [تهيئة Gateway](/gateway/configuration) — جميع خيارات التهيئة
- [دليل DigitalOcean](/platforms/digitalocean) — إذا كنت تريد خيارًا مدفوعًا مع تسجيل أسهل
- [دليل Hetzner](/install/hetzner) — بديل قائم على Docker
