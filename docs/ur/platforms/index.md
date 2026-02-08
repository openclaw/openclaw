---
summary: "پلیٹ فارم سپورٹ کا جائزہ (Gateway + معاون ایپس)"
read_when:
  - OS سپورٹ یا انسٹال کے راستے تلاش کر رہے ہوں
  - Gateway کہاں چلانا ہے اس کا فیصلہ کر رہے ہوں
title: "پلیٹ فارمز"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:26Z
---

# پلیٹ فارمز

OpenClaw کور TypeScript میں لکھا گیا ہے۔ **Node تجویز کردہ رن ٹائم ہے**۔
Gateway کے لیے Bun تجویز نہیں کیا جاتا (WhatsApp/Telegram بگز)۔

macOS (مینو بار ایپ) اور موبائل نوڈز (iOS/Android) کے لیے معاون ایپس موجود ہیں۔ Windows اور
Linux کے لیے معاون ایپس منصوبہ بندی میں ہیں، لیکن Gateway آج مکمل طور پر سپورٹڈ ہے۔
Windows کے لیے نیٹو معاون ایپس بھی منصوبہ بندی میں ہیں؛ Gateway کے لیے WSL2 کے ذریعے چلانا تجویز کیا جاتا ہے۔

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

- macOS: LaunchAgent (`bot.molt.gateway` یا `bot.molt.<profile>`; لیگیسی `com.openclaw.*`)
- Linux/WSL2: systemd یوزر سروس (`openclaw-gateway[-<profile>].service`)
