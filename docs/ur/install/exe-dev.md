---
summary: "ریموٹ رسائی کے لیے exe.dev (VM + HTTPS پراکسی) پر OpenClaw Gateway چلائیں"
read_when:
  - آپ Gateway کے لیے ایک سستا، ہمیشہ آن Linux ہوسٹ چاہتے ہیں
  - آپ اپنا VPS چلائے بغیر ریموٹ Control UI رسائی چاہتے ہیں
title: "exe.dev"
---

# exe.dev

مقصد: exe.dev VM پر OpenClaw Gateway چلانا، جو آپ کے لیپ ٹاپ سے قابلِ رسائی ہو بذریعہ: `https://<vm-name>.exe.xyz`

یہ صفحہ exe.dev کی ڈیفالٹ **exeuntu** امیج فرض کرتا ہے۔ اگر آپ نے مختلف distro منتخب کی ہے، تو پیکجز کو اسی کے مطابق map کریں۔

## مبتدیوں کے لیے فوری راستہ

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. ضرورت کے مطابق اپنی auth key/token درج کریں
3. اپنی VM کے ساتھ موجود "Agent" پر کلک کریں، اور انتظار کریں...
4. ???
5. منافع

## آپ کو کیا درکار ہے

- exe.dev اکاؤنٹ
- [exe.dev](https://exe.dev) ورچوئل مشینز تک `ssh exe.dev` رسائی (اختیاری)

## Shelley کے ساتھ خودکار انسٹال

Shelley، [exe.dev](https://exe.dev) کا agent، ہمارے prompt کے ساتھ OpenClaw فوراً انسٹال کر سکتا ہے۔ استعمال کیا گیا prompt درج ذیل ہے:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## دستی انسٹالیشن

## 1. VM بنائیں

اپنے ڈیوائس سے:

```bash
ssh exe.dev new
```

پھر کنیکٹ کریں:

```bash
ssh <vm-name>.exe.xyz
```

ٹِپ: اس VM کو **stateful** رکھیں۔ OpenClaw اسٹیٹ کو `~/.openclaw/` اور `~/.openclaw/workspace/` کے تحت محفوظ کرتا ہے۔

## 2. پیشگی تقاضے انسٹال کریں (VM پر)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw انسٹال کریں

OpenClaw انسٹال اسکرپٹ چلائیں:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. OpenClaw کو پورٹ 8000 پر پراکسی کرنے کے لیے nginx سیٹ اپ کریں

`/etc/nginx/sites-enabled/default` کو درج ذیل کے ساتھ ایڈٹ کریں:

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

## 5. OpenClaw تک رسائی حاصل کریں اور مراعات منظور کریں

`https://<vm-name>.exe.xyz/` تک رسائی حاصل کریں (onboarding کے Control UI آؤٹ پٹ میں دیکھیں)۔ اگر یہ auth کے لیے کہے، تو VM پر موجود `gateway.auth.token` سے token پیسٹ کریں (`openclaw config get gateway.auth.token` سے حاصل کریں، یا `openclaw doctor --generate-gateway-token` کے ذریعے نیا بنائیں)۔ `openclaw devices list` اور `openclaw devices approve <requestId>` کے ذریعے devices کو approve کریں۔ جب شک ہو، تو اپنے browser سے Shelley استعمال کریں!

## ریموٹ رسائی

Remote access کو [exe.dev](https://exe.dev) کی authentication کے ذریعے ہینڈل کیا جاتا ہے۔ ڈیفالٹ طور پر، port 8000 سے HTTP ٹریفک کو email auth کے ساتھ `https://<vm-name>.exe.xyz` پر forward کیا جاتا ہے۔

## اپڈیٹنگ

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

گائیڈ: [Updating](/install/updating)
