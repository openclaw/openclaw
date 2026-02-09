---
summary: "CLI کے لیے حوالہ برائے `openclaw voicecall` (voice-call پلگ اِن کی کمانڈ سطح)"
read_when:
  - آپ voice-call پلگ اِن استعمال کرتے ہیں اور CLI کے اندراجی پوائنٹس چاہتے ہیں
  - آپ `voicecall call|continue|status|tail|expose` کے لیے فوری مثالیں چاہتے ہیں
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

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

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
