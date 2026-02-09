---
summary: "تثبيت OpenClaw مؤتمت ومُحصَّن باستخدام Ansible وVPN ‏Tailscale وعزل الجدار الناري"
read_when:
  - تريد نشر خوادم مؤتمتًا مع تعزيز الأمان
  - تحتاج إلى إعداد معزول بجدار ناري مع وصول عبر VPN
  - تقوم بالنشر على خوادم Debian/Ubuntu بعيدة
title: "Ansible"
---

# تثبيت Ansible

الطريقة الموصى بها لنشر OpenClaw على خوادم الإنتاج هي عبر **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — مُثبّت مؤتمت بهندسة تضع الأمان أولًا.

## البدء السريع

تثبيت بأمر واحد:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 الدليل الكامل: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> مستودع openclaw-ansible هو مصدر الحقيقة لنشر Ansible. هذه الصفحة نظرة عامة سريعة.

## ما الذي تحصل عليه

- 🔒 **أمان يبدأ بالجدار الناري**: ‏UFW + عزل Docker (لا يمكن الوصول إلا إلى SSH وTailscale)
- 🔐 **VPN ‏Tailscale**: وصول آمن عن بُعد دون تعريض الخدمات للعامة
- 🐳 **Docker**: حاويات sandbox معزولة، ربط على localhost فقط
- 🛡️ **دفاع متعدد الطبقات**: بنية أمان من 4 طبقات
- 🚀 **إعداد بأمر واحد**: نشر كامل خلال دقائق
- 🔧 **تكامل Systemd**: بدء تلقائي عند الإقلاع مع تعزيز الأمان

## المتطلبات

- **نظام التشغيل**: ‏Debian 11+ أو Ubuntu 20.04+
- **الوصول**: صلاحيات root أو sudo
- **الشبكة**: اتصال بالإنترنت لتثبيت الحزم
- **Ansible**: ‏2.14+ (يُثبَّت تلقائيًا عبر سكربت البدء السريع)

## ما الذي يتم تثبيته

يقوم Playbook الخاص بـ Ansible بتثبيت وتهيئة ما يلي:

1. **Tailscale** (شبكة VPN شبكية للوصول الآمن عن بُعد)
2. **جدار ناري UFW** (منافذ SSH وTailscale فقط)
3. **Docker CE + Compose V2** (لـ sandbox الوكلاء)
4. **Node.js 22.x + pnpm** (اعتماديات وقت التشغيل)
5. **OpenClaw** (مستضاف على المضيف، غير مُحَوْسَب)
6. **خدمة Systemd** (بدء تلقائي مع تعزيز الأمان)

ملاحظة: يعمل الـ Gateway **مباشرة على المضيف** (ليس داخل Docker)، بينما تستخدم sandbox الخاصة بالوكلاء Docker للعزل. راجع [Sandboxing](/gateway/sandboxing) للتفاصيل.

## الإعداد بعد التثبيت

بعد اكتمال التثبيت، بدّل إلى مستخدم openclaw:

```bash
sudo -i -u openclaw
```

سيُرشدك سكربت ما بعد التثبيت خلال:

1. **معالج الإعداد (Onboarding wizard)**: تهيئة إعدادات OpenClaw
2. **تسجيل دخول الموفّر**: ربط WhatsApp/Telegram/Discord/Signal
3. **اختبار Gateway**: التحقق من التثبيت
4. **إعداد Tailscale**: الاتصال بشبكة VPN الخاصة بك

### أوامر سريعة

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

## بنية الأمان

### دفاع من 4 طبقات

1. **الجدار الناري (UFW)**: تعريض SSH (22) وTailscale (41641/udp) فقط للعامة
2. **VPN ‏(Tailscale)**: يمكن الوصول إلى Gateway عبر شبكة VPN فقط
3. **عزل Docker**: سلسلة iptables ‏DOCKER-USER تمنع تعريض المنافذ الخارجية
4. **تعزيز Systemd**: ‏NoNewPrivileges وPrivateTmp ومستخدم غير مميّز

### التحقق

اختبر سطح الهجوم الخارجي:

```bash
nmap -p- YOUR_SERVER_IP
```

ينبغي أن يُظهر **المنفذ 22 فقط** (SSH) مفتوحًا. جميع الخدمات الأخرى (Gateway وDocker) مقفلة.

### توفر Docker

يتم تثبيت Docker من أجل **sandbox الوكلاء** (تنفيذ الأدوات المعزول)، وليس لتشغيل الـ Gateway نفسه. يرتبط الـ Gateway بـ localhost فقط ويمكن الوصول إليه عبر VPN ‏Tailscale.

راجع [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) لتهيئة sandbox.

## التثبيت اليدوي

إذا كنت تفضّل التحكم اليدوي بدل الأتمتة:

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

## تحديث OpenClaw

يقوم مُثبّت Ansible بإعداد OpenClaw للتحديثات اليدوية. راجع [Updating](/install/updating) لتدفق التحديث القياسي.

لإعادة تشغيل Playbook الخاص بـ Ansible (مثلًا لتغييرات التهيئة):

```bash
cd openclaw-ansible
./run-playbook.sh
```

ملاحظة: هذا إجراء متطابق (idempotent) وآمن للتشغيل عدة مرات.

## استكشاف الأخطاء وإصلاحها

### جدار الحماية يمنع اتصالي

إذا تم قفلك خارج النظام:

- تأكّد أولًا من إمكانية الوصول عبر VPN ‏Tailscale
- وصول SSH (المنفذ 22) مسموح دائمًا
- الوصول إلى Gateway **حصريًا** عبر Tailscale بحكم التصميم

### الخدمة لا تبدأ

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

### مشكلات sandbox في Docker

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### فشل تسجيل دخول الموفّر

تأكّد من أنك تعمل كمستخدم `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## تهيئة متقدمة

للتفاصيل المعمّقة حول بنية الأمان واستكشاف الأخطاء:

- [بنية الأمان](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [التفاصيل التقنية](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [دليل استكشاف الأخطاء وإصلاحها](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## ذو صلة

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — دليل النشر الكامل
- [Docker](/install/docker) — إعداد Gateway مُحَوْسَب
- [Sandboxing](/gateway/sandboxing) — تهيئة sandbox للوكلاء
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — عزل لكل وكيل
