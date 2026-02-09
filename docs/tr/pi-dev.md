---
title: "Pi Geliştirme İş Akışı"
---

# Pi Geliştirme İş Akışı

Bu kılavuz, OpenClaw’daki pi entegrasyonu üzerinde çalışmak için makul bir iş akışını özetler.

## Type Checking and Linting

- Tür denetimi ve derleme: `pnpm build`
- Lint: `pnpm lint`
- Biçim denetimi: `pnpm format`
- Göndermeden önce tam kapı: `pnpm lint && pnpm build && pnpm test`

## Pi Testlerini Çalıştırma

Pi entegrasyonu test seti için ayrılmış betiği kullanın:

```bash
scripts/pi/run-tests.sh
```

Gerçek sağlayıcı davranışını kullanan canlı testi dahil etmek için:

```bash
scripts/pi/run-tests.sh --live
```

Betik, aşağıdaki glob’lar üzerinden tüm pi ile ilgili birim testlerini çalıştırır:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manuel Test

Önerilen akış:

- Gateway’i geliştirme modunda çalıştırın:
  - `pnpm gateway:dev`
- Trigger the agent directly:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Etkileşimli hata ayıklama için TUI’yi kullanın:
  - `pnpm tui`

Araç çağrısı davranışı için, araç akışını ve yük (payload) işlemesini görebilmek amacıyla bir `read` veya `exec` eylemi istemi verin.

## Clean Slate Reset

Durum, OpenClaw durum dizini altında tutulur. Varsayılan değer `~/.openclaw`’dir. `OPENCLAW_STATE_DIR` ayarlanmışsa, bunun yerine o dizini kullanın.

Her şeyi sıfırlamak için:

- Yapılandırma için `openclaw.json`
- Kimlik doğrulama profilleri ve belirteçler için `credentials/`
- Ajan oturum geçmişi için `agents/<agentId>/sessions/`
- Oturum dizini için `agents/<agentId>/sessions.json`
- Eski yollar mevcutsa `sessions/`
- Boş bir çalışma alanı istiyorsanız `workspace/`

Yalnızca oturumları sıfırlamak istiyorsanız, o ajan için `agents/<agentId>/sessions/` ve `agents/<agentId>/sessions.json` dosyalarını silin. Yeniden kimlik doğrulamak istemiyorsanız `credentials/` dosyasını koruyun.

## Referanslar

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
