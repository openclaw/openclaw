---
summary: "OpenClaw کے لیے VPS ہوسٹنگ ہب (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - آپ Gateway کو کلاؤڈ میں چلانا چاہتے ہیں
  - آپ کو VPS/ہوسٹنگ گائیڈز کا ایک فوری نقشہ درکار ہے
title: "VPS ہوسٹنگ"
---

# VPS ہوسٹنگ

یہ ہب معاون VPS/ہوسٹنگ گائیڈز کے روابط فراہم کرتا ہے اور یہ بتاتا ہے کہ کلاؤڈ
ڈپلائمنٹس اعلیٰ سطح پر کیسے کام کرتی ہیں۔

## فراہم کنندہ منتخب کریں

- **Railway** (ایک کلک + براؤزر سیٹ اپ): [Railway](/install/railway)
- **Northflank** (ایک کلک + براؤزر سیٹ اپ): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/ماہ (Always Free، ARM؛ گنجائش/سائن اپ کبھی کبھار مشکل ہو سکتا ہے)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS پراکسی): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: یہ بھی بخوبی کام کرتا ہے۔ ویڈیو گائیڈ:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## کلاؤڈ سیٹ اپ کیسے کام کرتے ہیں

- **Gateway VPS پر چلتا ہے** اور اسٹیٹ + ورک اسپیس کا مالک ہوتا ہے۔
- آپ اپنے لیپ ٹاپ/فون سے **Control UI** یا **Tailscale/SSH** کے ذریعے کنیکٹ کرتے ہیں۔
- VPS کو منبعِ حقیقت سمجھیں اور اسٹیٹ + ورک اسپیس کا **بیک اپ** رکھیں۔
- محفوظ ڈیفالٹ: Gateway کو لوپ بیک پر رکھیں اور SSH ٹنل یا Tailscale Serve کے ذریعے اس تک رسائی حاصل کریں۔
  اگر آپ `lan`/`tailnet` پر بائنڈ کریں تو `gateway.auth.token` یا `gateway.auth.password` لازمی رکھیں۔

ریموٹ رسائی: [Gateway remote](/gateway/remote)  
Platforms ہب: [Platforms](/platforms)

## VPS کے ساتھ nodes کا استعمال

آپ Gateway کو کلاؤڈ میں رکھ سکتے ہیں اور اپنے مقامی آلات
(Mac/iOS/Android/headless) پر **nodes** جوڑ سکتے ہیں۔ Nodes مقامی اسکرین/کیمرہ/کینوس اور `system.run`
صلاحیتیں فراہم کرتے ہیں جبکہ Gateway کلاؤڈ میں ہی رہتا ہے۔

دستاویزات: [Nodes](/nodes)، [Nodes CLI](/cli/nodes)
