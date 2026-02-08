---
summary: "`openclaw pairing` için CLI başvurusu (eşleştirme isteklerini onaylama/listeleme)"
read_when:
  - Eşleştirme modlu DM'leri kullanıyor ve gönderenleri onaylamanız gerekiyor
title: "eşleştirme"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:00Z
---

# `openclaw pairing`

(Eşleştirmeyi destekleyen kanallar için) DM eşleştirme isteklerini onaylayın veya inceleyin.

İlgili:

- Eşleştirme akışı: [Eşleştirme](/channels/pairing)

## Komutlar

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
