---
summary: "CLI کے لیے حوالہ برائے `openclaw voicecall` (voice-call پلگ اِن کی کمانڈ سطح)"
read_when:
  - آپ voice-call پلگ اِن استعمال کرتے ہیں اور CLI کے اندراجی پوائنٹس چاہتے ہیں
  - آپ `voicecall call|continue|status|tail|expose` کے لیے فوری مثالیں چاہتے ہیں
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:05Z
---

# `openclaw voicecall`

`voicecall` ایک پلگ اِن کی فراہم کردہ کمانڈ ہے۔ یہ صرف اسی صورت میں ظاہر ہوتی ہے جب voice-call پلگ اِن انسٹال اور فعال ہو۔

بنیادی دستاویز:

- voice-call پلگ اِن: [وائس کال](/plugins/voice-call)

## عام کمانڈز

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## ویب ہکس کو ایکسپوز کرنا (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

سکیورٹی نوٹ: ویب ہک اینڈپوائنٹ کو صرف اُن نیٹ ورکس تک ایکسپوز کریں جن پر آپ اعتماد کرتے ہیں۔ جہاں ممکن ہو Funnel کے بجائے Tailscale Serve کو ترجیح دیں۔
