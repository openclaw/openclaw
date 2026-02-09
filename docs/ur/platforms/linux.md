---
summary: "لینکس سپورٹ + معاون ایپ کی حیثیت"
read_when:
  - لینکس معاون ایپ کی حیثیت تلاش کر رہے ہوں
  - پلیٹ فارم کوریج یا شراکتوں کی منصوبہ بندی کر رہے ہوں
title: "لینکس ایپ"
---

# لینکس ایپ

44. گیٹ وے Linux پر مکمل طور پر سپورٹڈ ہے۔ 45. **Node تجویز کردہ رَن ٹائم ہے**۔
45. گیٹ وے کے لیے Bun تجویز نہیں کیا جاتا (WhatsApp/Telegram بگز)۔

47. مقامی Linux ساتھی ایپس منصوبہ بندی میں ہیں۔ 48. اگر آپ ایک بنانے میں مدد کرنا چاہتے ہیں تو تعاون خوش آئند ہے۔

## مبتدیوں کے لیے فوری راستہ (VPS)

1. Node 22+ انسٹال کریں
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. اپنے لیپ ٹاپ سے: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` کھولیں اور اپنا ٹوکن پیسٹ کریں

مرحلہ وار VPS گائیڈ: [exe.dev](/install/exe-dev)

## انسٹال

- [ابتدائی رہنمائی](/start/getting-started)
- [انسٹال اور اپ ڈیٹس](/install/updating)
- اختیاری فلو: [Bun (تجرباتی)](/install/bun)، [Nix](/install/nix)، [Docker](/install/docker)

## Gateway

- [Gateway رن بُک](/gateway)
- [کنفیگریشن](/gateway/configuration)

## Gateway سروس انسٹال (CLI)

ان میں سے ایک استعمال کریں:

```
openclaw onboard --install-daemon
```

یا:

```
openclaw gateway install
```

یا:

```
openclaw configure
```

جب کہا جائے تو **Gateway سروس** منتخب کریں۔

مرمت/منتقلی:

```
openclaw doctor
```

## سسٹم کنٹرول (systemd user unit)

49. OpenClaw ڈیفالٹ طور پر systemd **user** سروس انسٹال کرتا ہے۔ 50. مشترکہ یا ہمیشہ آن سرورز کے لیے **system** سروس استعمال کریں۔ مکمل یونٹ کی مثال اور رہنمائی
    [Gateway runbook](/gateway) میں موجود ہے۔

کم از کم سیٹ اپ:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` بنائیں:

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

اسے فعال کریں:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
