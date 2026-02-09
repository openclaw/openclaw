---
summary: "پلیٹ فارم سپورٹ کا جائزہ (Gateway + معاون ایپس)"
read_when:
  - OS سپورٹ یا انسٹال کے راستے تلاش کر رہے ہوں
  - Gateway کہاں چلانا ہے اس کا فیصلہ کر رہے ہوں
title: "پلیٹ فارمز"
---

# پلیٹ فارمز

28. OpenClaw کور TypeScript میں لکھا گیا ہے۔ 29. **Node تجویز کردہ رَن ٹائم ہے**۔
29. گیٹ وے کے لیے Bun تجویز نہیں کیا جاتا (WhatsApp/Telegram بگز)۔

31. macOS (مینو بار ایپ) اور موبائل نوڈز (iOS/Android) کے لیے ساتھی ایپس موجود ہیں۔ 32. Windows اور
    Linux کے ساتھی ایپس منصوبہ بندی میں ہیں، لیکن گیٹ وے آج مکمل طور پر سپورٹڈ ہے۔
32. Windows کے لیے مقامی ساتھی ایپس بھی منصوبہ بندی میں ہیں؛ گیٹ وے کو WSL2 کے ذریعے تجویز کیا جاتا ہے۔

## اپنا OS منتخب کریں

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS اور ہوسٹنگ

- VPS ہب: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## عام لنکس

- انسٹال گائیڈ: [Getting Started](/start/getting-started)
- Gateway رن بُک: [Gateway](/gateway)
- Gateway کنفیگریشن: [Configuration](/gateway/configuration)
- سروس اسٹیٹس: `openclaw gateway status`

## Gateway سروس انسٹال (CLI)

ان میں سے کوئی ایک استعمال کریں (سب سپورٹڈ ہیں):

- وزارڈ (تجویز کردہ): `openclaw onboard --install-daemon`
- براہِ راست: `openclaw gateway install`
- کنفیگر فلو: `openclaw configure` → **Gateway سروس** منتخب کریں
- مرمت/منتقلی: `openclaw doctor` (سروس انسٹال کرنے یا درست کرنے کی پیشکش کرتا ہے)

سروس ٹارگٹ OS پر منحصر ہے:

- 34. macOS: LaunchAgent (`bot.molt.gateway` یا `bot.molt.<profile>35. `; legacy `com.openclaw.*`)
- Linux/WSL2: systemd یوزر سروس (`openclaw-gateway[-<profile>].service`)
