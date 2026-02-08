---
summary: "`openclaw voicecall` için CLI başvurusu (voice-call eklentisi komut yüzeyi)"
read_when:
  - Voice-call eklentisini kullanıyorsunuz ve CLI giriş noktalarını istiyorsunuz
  - `voicecall call|continue|status|tail|expose` için hızlı örnekler istiyorsunuz
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:10Z
---

# `openclaw voicecall`

`voicecall` eklenti tarafından sağlanan bir komuttur. Yalnızca voice-call eklentisi yüklü ve etkinse görünür.

Birincil belge:

- Voice-call eklentisi: [Voice Call](/plugins/voice-call)

## Yaygın komutlar

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Webhook'ların dışa açılması (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Güvenlik notu: webhook uç noktasını yalnızca güvendiğiniz ağlara açın. Mümkün olduğunda Funnel yerine Tailscale Serve'ü tercih edin.
