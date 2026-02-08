---
summary: "`openclaw setup` için CLI başvurusu (yapılandırmayı + çalışma alanını başlatma)"
read_when:
  - Tam onboarding sihirbazını kullanmadan ilk kurulum yapıyorsanız
  - Varsayılan çalışma alanı yolunu ayarlamak istiyorsanız
title: "kurulum"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:05Z
---

# `openclaw setup`

`~/.openclaw/openclaw.json` ve ajan çalışma alanını başlatır.

İlgili:

- Başlarken: [Başlarken](/start/getting-started)
- Sihirbaz: [Oryantasyon](/start/onboarding)

## Örnekler

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Kurulumu kullanarak sihirbazı çalıştırmak için:

```bash
openclaw setup --wizard
```
