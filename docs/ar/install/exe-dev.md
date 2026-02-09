---
summary: "تشغيل OpenClaw Gateway على exe.dev ‏(آلة افتراضية + وكيل HTTPS) للوصول عن بُعد"
read_when:
  - تريد مضيف لينكس منخفض التكلفة يعمل دائمًا لـ Gateway
  - تريد وصولًا عن بُعد إلى واجهة التحكم دون تشغيل VPS خاص بك
title: "exe.dev"
---

# exe.dev

الهدف: تشغيل OpenClaw Gateway على آلة افتراضية من exe.dev، ويمكن الوصول إليه من حاسوبك المحمول عبر: `https://<vm-name>.exe.xyz`

تفترض هذه الصفحة صورة **exeuntu** الافتراضية من exe.dev. إذا اخترت توزيعة مختلفة، فقم بمواءمة الحزم وفقًا لذلك.

## المسار السريع للمبتدئين

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. أدخل مفتاح/رمز المصادقة حسب الحاجة
3. انقر على «Agent» بجوار الآلة الافتراضية الخاصة بك، وانتظر...
4. ؟؟؟
5. ربح

## ما الذي تحتاجه

- حساب exe.dev
- وصول `ssh exe.dev` إلى الآلات الافتراضية على [exe.dev](https://exe.dev) (اختياري)

## التثبيت الآلي باستخدام Shelley

يمكن لـ Shelley، وكيل [exe.dev](https://exe.dev)، تثبيت OpenClaw فورًا باستخدام
المُطالبة الخاصة بنا. المُطالبة المستخدمة كما يلي:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## التثبيت اليدوي

## 1. إنشاء الآلة الافتراضية

من جهازك:

```bash
ssh exe.dev new
```

ثم اتصل:

```bash
ssh <vm-name>.exe.xyz
```

نصيحة: اجعل هذه الآلة الافتراضية **ذات حالة**. يخزّن OpenClaw الحالة تحت `~/.openclaw/` و `~/.openclaw/workspace/`.

## 2. تثبيت المتطلبات المسبقة (على الآلة الافتراضية)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. تثبيت OpenClaw

شغّل نص تثبيت OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. إعداد nginx لعمل وكيل لـ OpenClaw إلى المنفذ 8000

حرّر `/etc/nginx/sites-enabled/default` باستخدام

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. الوصول إلى OpenClaw ومنح الصلاحيات

ادخل إلى `https://<vm-name>.exe.xyz/` (راجع مخرجات واجهة التحكم من التهيئة الأولية). إذا طُلبت المصادقة، الصق
الرمز من `gateway.auth.token` على الآلة الافتراضية (يمكن استرجاعه عبر `openclaw config get gateway.auth.token`، أو إنشاؤه
باستخدام `openclaw doctor --generate-gateway-token`). وافق على الأجهزة باستخدام `openclaw devices list` و
`openclaw devices approve <requestId>`. عند الشك، استخدم Shelley من متصفحك!

## الوصول عن بُعد

يُدار الوصول عن بُعد بواسطة مصادقة [exe.dev](https://exe.dev). افتراضيًا،
يُعاد توجيه حركة HTTP من المنفذ 8000 إلى `https://<vm-name>.exe.xyz`
مع مصادقة البريد الإلكتروني.

## التحديث

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

الدليل: [التحديث](/install/updating)
