---
summary: "دعم Linux + حالة التطبيقات المُرافِقة"
read_when:
  - البحث عن حالة التطبيق المُرافِق على Linux
  - التخطيط لتغطية المنصات أو المساهمة
title: "تطبيق Linux"
---

# تطبيق Linux

يتم دعم Gateway (البوابة) بالكامل على Linux. **Node هو وقت التشغيل الموصى به**.
لا يُنصَح باستخدام Bun مع Gateway (البوابة) بسبب أخطاء في WhatsApp/Telegram.

يُخطَّط لتوفير تطبيقات مُرافِقة أصلية على Linux. نرحّب بالمساهمات إذا رغبت في المساعدة على بناء واحد.

## المسار السريع للمبتدئين (VPS)

1. تثبيت Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. من جهازك المحمول: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. افتح `http://127.0.0.1:18789/` والصق الرمز المميّز الخاص بك

دليل VPS خطوة بخطوة: [exe.dev](/install/exe-dev)

## التثبيت

- [بدء الاستخدام](/start/getting-started)
- [التثبيت والتحديثات](/install/updating)
- مسارات اختيارية: [Bun (تجريبي)](/install/bun)، [Nix](/install/nix)، [Docker](/install/docker)

## Gateway

- [دليل تشغيل Gateway](/gateway)
- [التهيئة](/gateway/configuration)

## تثبيت خدمة Gateway (CLI)

استخدم أحد الخيارات التالية:

```
openclaw onboard --install-daemon
```

أو:

```
openclaw gateway install
```

أو:

```
openclaw configure
```

اختر **Gateway service** عند ظهور المطالبة.

إصلاح/ترحيل:

```
openclaw doctor
```

## التحكم بالنظام (وحدة systemd للمستخدم)

يقوم OpenClaw بتثبيت خدمة systemd **للمستخدم** افتراضيًا. استخدم خدمة **نظام**
للخوادم المشتركة أو العاملة دائمًا. يتوفر مثال الوحدة الكامل والإرشادات
في [دليل تشغيل Gateway](/gateway).

إعداد أدنى:

أنشئ `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

فعّلها:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
