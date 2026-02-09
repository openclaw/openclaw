---
summary: "Testlerin yerel olarak (vitest) nasıl çalıştırılacağı ve force/coverage modlarının ne zaman kullanılacağı"
read_when:
  - Testleri çalıştırırken veya düzeltirken
title: "Testler"
---

# Testler

- Tam test kiti (suitler, canlı, Docker): [Testing](/help/testing)

- `pnpm test:force`: Varsayılan kontrol portunu tutan kalıcı herhangi bir gateway sürecini sonlandırır, ardından çalışan bir örnekle sunucu testlerinin çakışmaması için yalıtılmış bir gateway portu ile tam Vitest suitini çalıştırır. Önceki bir gateway çalıştırması 18789 portunu meşgul bıraktıysa bunu kullanın.

- `pnpm test:coverage`: Vitest’i V8 coverage ile çalıştırır. Küresel eşikler satırlar/dallar/fonksiyonlar/ifadeler için %70’tir. Coverage, hedefi birim test edilebilir mantığa odaklı tutmak için entegrasyon ağırlıklı giriş noktalarını (CLI bağlama, gateway/telegram köprüleri, webchat statik sunucu) hariç tutar.

- `pnpm test:e2e`: Gateway uçtan uca smoke testlerini çalıştırır (çoklu örnek WS/HTTP/node eşleştirmesi).

- `pnpm test:live`: Sağlayıcı canlı testlerini (minimax/zai) çalıştırır. Atlama durumunu kaldırmak için API anahtarları ve `LIVE=1` (veya sağlayıcıya özgü `*_LIVE_TEST=1`) gerektirir.

## Model gecikme ölçümü (yerel anahtarlar)

Betik: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Kullanım:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- İsteğe bağlı ortam değişkenleri: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Varsayılan istem: “Tek bir kelimeyle yanıtla: ok. Noktalama veya ek metin yok.”

Son çalıştırma (2025-12-31, 20 çalıştırma):

- minimax medyan 1279ms (min 1114, maks 2431)
- opus medyan 2454ms (min 1224, maks 3170)

## Onboarding E2E (Docker)

Docker isteğe bağlıdır; bu yalnızca konteynerleştirilmiş onboarding smoke testleri için gereklidir.

Temiz bir Linux konteynerinde tam soğuk başlangıç akışı:

```bash
scripts/e2e/onboard-docker.sh
```

Bu betik, etkileşimli sihirbazı bir pseudo-tty üzerinden yönlendirir, yapılandırma/çalışma alanı/oturum dosyalarını doğrular, ardından gateway’i başlatır ve `openclaw health`’ü çalıştırır.

## QR içe aktarma smoke (Docker)

Docker’da Node 22+ altında `qrcode-terminal`’in yüklendiğinden emin olur:

```bash
pnpm test:docker:qr
```
