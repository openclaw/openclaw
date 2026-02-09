---
summary: "Çalışma alanını ve kimlik dosyalarını tohumlayan ajan başlatma ritüeli"
read_when:
  - İlk ajan çalıştırmasında ne olduğunu anlamak
  - Başlatma dosyalarının nerede bulunduğunu açıklamak
  - Katılım kimliği kurulumunda hata ayıklamak
title: "Ajan Önyüklemesi"
sidebarTitle: "Önyükleme"
---

# Ajan Önyüklemesi

Başlatma, bir ajan çalışma alanını hazırlayan ve kimlik ayrıntılarını toplayan **ilk çalıştırma** ritüelidir. Katılımdan sonra, ajan ilk kez başlatıldığında gerçekleşir.

## Önyüklemenin ne yaptığı

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
