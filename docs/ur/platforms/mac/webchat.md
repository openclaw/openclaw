---
summary: "mac ایپ کس طرح Gateway WebChat کو ایمبیڈ کرتی ہے اور اسے ڈیبگ کیسے کیا جائے"
read_when:
  - mac WebChat ویو یا loopback پورٹ کی ڈیبگنگ
title: "WebChat"
---

# WebChat (macOS ایپ)

16. macOS مینو بار ایپ WebChat UI کو ایک نیٹو SwiftUI ویو کے طور پر ایمبیڈ کرتی ہے۔ 17. یہ
    Gateway سے کنیکٹ کرتی ہے اور منتخب ایجنٹ کے لیے **مین سیشن** کو ڈیفالٹ بناتی ہے
    (دیگر سیشنز کے لیے سیشن سوئچر کے ساتھ)۔

- **Local mode**: مقامی Gateway WebSocket سے براہِ راست کنیکٹ ہوتا ہے۔
- **Remote mode**: Gateway کنٹرول پورٹ کو SSH کے ذریعے فارورڈ کرتا ہے اور اسی
  سرنگ کو ڈیٹا پلین کے طور پر استعمال کرتا ہے۔

## Launch & debugging

- Manual: Lobster مینو → “Open Chat”۔

- Auto‑open برائے ٹیسٹنگ:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (سب سسٹم `bot.molt`، کیٹیگری `WebChatSwiftUI`)۔

## How it’s wired

- Data plane: Gateway WS میتھڈز `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` اور واقعات `chat`, `agent`, `presence`, `tick`, `health`۔
- 18. سیشن: ڈیفالٹ طور پر پرائمری سیشن (`main`، یا جب اسکوپ گلوبل ہو تو `global`)۔ 19. UI سیشنز کے درمیان سوئچ کر سکتی ہے۔
- Onboarding پہلے رن کے سیٹ اپ کو الگ رکھنے کے لیے ایک مخصوص سیشن استعمال کرتا ہے۔

## Security surface

- Remote mode میں صرف Gateway WebSocket کنٹرول پورٹ کو SSH کے ذریعے فارورڈ کیا جاتا ہے۔

## Known limitations

- UI چیٹ سیشنز کے لیے بہتر بنائی گئی ہے (مکمل براؤزر sandbox نہیں)۔
