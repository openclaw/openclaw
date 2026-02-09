---
summary: "Bun iş akışı (deneysel): pnpm’e kıyasla kurulum ve dikkat edilmesi gerekenler"
read_when:
  - En hızlı yerel geliştirme döngüsünü istiyorsunuz (bun + watch)
  - Bun kurulum/yama/yaşam döngüsü betiği sorunlarıyla karşılaşıyorsunuz
title: "Bun (Deneysel)"
---

# Bun (deneysel)

Amaç: pnpm iş akışlarından sapmadan bu depoyu **Bun** ile çalıştırmak (isteğe bağlı, WhatsApp/Telegram için önerilmez).

⚠️ **Gateway çalışma zamanı için önerilmez** (WhatsApp/Telegram hataları). Üretimde Node kullanın.

## Status

- Bun, TypeScript’i doğrudan çalıştırmak için isteğe bağlı bir yerel çalışma zamanıdır (`bun run …`, `bun --watch …`).
- `pnpm` derlemeler için varsayılandır ve tamamen desteklenmeye devam eder (ve bazı dokümantasyon araçları tarafından kullanılır).
- Bun, `pnpm-lock.yaml` kullanamaz ve bunu yok sayar.

## Yükleme

Varsayılan:

```sh
bun install
```

Not: `bun.lock`/`bun.lockb` gitignore kapsamındadır; bu nedenle her iki durumda da depoda değişiklik olmaz. _Hiç kilit dosyası yazımı olmasın_ istiyorsanız:

```sh
bun install --no-save
```

## Derleme / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Uyarılar

Bun, açıkça güvenilmediği sürece bağımlılık yaşam döngüsü betiklerini engelleyebilir (`bun pm untrusted` / `bun pm trust`).
Bu depo için, yaygın olarak engellenen betikler gerekli değildir:

- `@whiskeysockets/baileys` `preinstall`: Node ana sürümünün >= 20 olduğunu denetler (Node 22+ çalıştırıyoruz).
- `protobufjs` `postinstall`: uyumsuz sürüm şemaları hakkında uyarılar üretir (derleme çıktısı yok).

Bu betiklerin gerçekten gerekli olduğu bir çalışma zamanı sorunuyla karşılaşırsanız, açıkça güvenin:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## İsteğe bağlı ortam değişkenleri:

- Bazı betikler hâlâ pnpm’i sabit kodlar (ör. `docs:build`, `ui:*`, `protocol:check`). Şimdilik bunları pnpm ile çalıştırın.
