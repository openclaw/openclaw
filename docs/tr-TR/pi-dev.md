---
title: "Pi Geliştirme İş Akışı"
summary: "Pi entegrasyonu için geliştirme iş akışı: build, test ve canlı doğrulama"
read_when:
  - Pi entegrasyonu kodu veya testleri üzerinde çalışırken
  - Pi'ye özel lint, tip kontrolü ve canlı test akışlarını çalıştırırken
---

# Pi Geliştirme İş Akışı

Bu kılavuz, OpenClaw'da pi entegrasyonuyla çalışmak için makul bir iş akışını özetler.

## Tip Kontrolü ve Linting

- Tip kontrolü ve build: `pnpm build`
- Lint: `pnpm lint`
- Format kontrolü: `pnpm format`
- Push öncesi tam kapı: `pnpm lint && pnpm build && pnpm test`

## Pi Testlerini Çalıştırma

Pi odaklı test setini Vitest ile doğrudan çalıştırın:

```bash
pnpm test -- \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-extensions/**/*.test.ts"
```

Canlı sağlayıcı egzersizini dahil etmek için:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test -- src/agents/pi-embedded-runner-extraparams.live.test.ts
```

Bu, ana Pi birim suitlerini kapsar:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manuel Test

Önerilen akış:

- Gateway'i dev modunda çalıştırın:
  - `pnpm gateway:dev`
- Ajanı doğrudan tetikleyin:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Etkileşimli hata ayıklama için TUI'yi kullanın:
  - `pnpm tui`

Araç çağrısı davranışı için, araç akışını ve yük işlemeyi görebilmeniz için bir `read` veya `exec` eylemi isteyin.

## Temiz Slate Sıfırlama

Durum OpenClaw durum dizini altında yaşar. Varsayılan `~/.openclaw`'dır. Eğer `OPENCLAW_STATE_DIR` ayarlandıysa, bunun yerine o dizini kullanın.

Her şeyi sıfırlamak için:

- Config için `openclaw.json`
- Auth profilleri ve token'lar için `credentials/`
- Ajan oturum geçmişi için `agents/<agentId>/sessions/`
- Oturum dizini için `agents/<agentId>/sessions.json`
- Eski yollar varsa `sessions/`
- Boş bir çalışma alanı isterseniz `workspace/`

Yalnızca oturumları sıfırlamak istiyorsanız, o ajan için `agents/<agentId>/sessions/` ve `agents/<agentId>/sessions.json`'u silin. Yeniden kimlik doğrulama yapmak istemiyorsanız `credentials/` dosyasını tutun.

## Referanslar

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
