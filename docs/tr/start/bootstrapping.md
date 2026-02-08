---
summary: "Çalışma alanını ve kimlik dosyalarını tohumlayan ajan başlatma ritüeli"
read_when:
  - Ajanın ilk çalıştırmada neler olduğunu anlamak
  - Başlatma dosyalarının nerede bulunduğunu açıklamak
  - Katılım kimliği kurulumunda hata ayıklamak
title: "Ajan Başlatma"
sidebarTitle: "Başlatma"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:40Z
---

# Ajan Başlatma

Başlatma, bir ajan çalışma alanını hazırlayan ve kimlik ayrıntılarını toplayan **ilk çalıştırma** ritüelidir. Katılımdan sonra, ajan ilk kez başlatıldığında gerçekleşir.

## Başlatma ne yapar

Ajanın ilk çalıştırılmasında OpenClaw çalışma alanını başlatır (varsayılan
`~/.openclaw/workspace`):

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` dosyalarını tohumlar.
- Kısa bir Soru-Cevap ritüeli çalıştırır (her seferinde bir soru).
- Kimlik + tercihleri `IDENTITY.md`, `USER.md`, `SOUL.md` dosyalarına yazar.
- Yalnızca bir kez çalışması için tamamlandığında `BOOTSTRAP.md` dosyasını kaldırır.

## Nerede çalışır

Başlatma her zaman **gateway ana makinesi** üzerinde çalışır. macOS uygulaması
uzak bir Gateway’e bağlanırsa, çalışma alanı ve başlatma dosyaları bu uzak
makinede bulunur.

<Note>
Gateway başka bir makinede çalışıyorsa, çalışma alanı dosyalarını gateway ana
makinesinde düzenleyin (örneğin, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## İlgili belgeler

- macOS uygulaması katılımı: [Onboarding](/start/onboarding)
- Çalışma alanı düzeni: [Ajan çalışma alanı](/concepts/agent-workspace)
