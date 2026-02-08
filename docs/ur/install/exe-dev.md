---
summary: "ریموٹ رسائی کے لیے exe.dev (VM + HTTPS پراکسی) پر OpenClaw Gateway چلائیں"
read_when:
  - آپ Gateway کے لیے ایک سستا، ہمیشہ آن Linux ہوسٹ چاہتے ہیں
  - آپ اپنا VPS چلائے بغیر ریموٹ Control UI رسائی چاہتے ہیں
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:20Z
---

# exe.dev

مقصد: exe.dev VM پر OpenClaw Gateway چلانا، جو آپ کے لیپ ٹاپ سے قابلِ رسائی ہو بذریعہ: `https://<vm-name>.exe.xyz`

یہ صفحہ exe.dev کی ڈیفالٹ **exeuntu** امیج کو فرض کرتا ہے۔ اگر آپ نے کوئی مختلف ڈسٹریبیوشن منتخب کی ہے تو پیکجز کو اس کے مطابق میپ کریں۔

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

Shelley، [exe.dev](https://exe.dev) کا ایجنٹ، ہمارے
prompt کے ذریعے OpenClaw کو فوراً انسٹال کر سکتا ہے۔ استعمال ہونے والا prompt درج ذیل ہے:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## دستی انسٹالیشن

## 1) VM بنائیں

اپنے ڈیوائس سے:

```bash
ssh exe.dev new
```

پھر کنیکٹ کریں:

```bash
ssh <vm-name>.exe.xyz
```

مشورہ: اس VM کو **stateful** رکھیں۔ OpenClaw اپنی حالت `~/.openclaw/` اور `~/.openclaw/workspace/` کے تحت محفوظ کرتا ہے۔

## 2) پیشگی تقاضے انسٹال کریں (VM پر)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClaw انسٹال کریں

OpenClaw انسٹال اسکرپٹ چلائیں:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) OpenClaw کو پورٹ 8000 پر پراکسی کرنے کے لیے nginx سیٹ اپ کریں

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

## 5) OpenClaw تک رسائی حاصل کریں اور مراعات منظور کریں

`https://<vm-name>.exe.xyz/` تک رسائی حاصل کریں (آن بورڈنگ سے Control UI آؤٹ پٹ دیکھیں)۔ اگر یہ auth کا مطالبہ کرے تو
VM پر موجود `gateway.auth.token` سے ٹوکن پیسٹ کریں (حاصل کریں بذریعہ `openclaw config get gateway.auth.token`، یا نیا بنائیں
`openclaw doctor --generate-gateway-token` کے ذریعے)۔ ڈیوائسز کو `openclaw devices list` اور
`openclaw devices approve <requestId>` کے ساتھ منظور کریں۔ اگر شک ہو تو اپنے براؤزر سے Shelley استعمال کریں!

## ریموٹ رسائی

ریموٹ رسائی [exe.dev](https://exe.dev) کی تصدیق کے ذریعے سنبھالی جاتی ہے۔ بطورِ طے شدہ،
پورٹ 8000 سے HTTP ٹریفک `https://<vm-name>.exe.xyz` کی طرف ای میل auth کے ساتھ فارورڈ کی جاتی ہے۔

## اپڈیٹنگ

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

گائیڈ: [Updating](/install/updating)
