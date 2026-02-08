---
summary: "Hur du kör tester lokalt (vitest) och när du ska använda force-/coverage-lägen"
read_when:
  - När du kör eller åtgärdar tester
title: "Tester"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:27Z
---

# Tester

- Fullständigt testpaket (sviter, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Dödar alla kvarvarande gateway-processer som håller standardkontrollporten, och kör sedan hela Vitest-sviten med en isolerad gateway-port så att servertester inte krockar med en körande instans. Använd detta när en tidigare gateway-körning lämnade port 18789 upptagen.
- `pnpm test:coverage`: Kör Vitest med V8-täckning. Globala trösklar är 70 % för rader/grenar/funktioner/satser. Täckningen exkluderar integrationsintensiva startpunkter (CLI-koppling, gateway/telegram-bryggor, webchatens statiska server) för att hålla målet fokuserat på logik som lämpar sig för enhetstester.
- `pnpm test:e2e`: Kör gateway end-to-end-röktester (parning av flera instanser via WS/HTTP/node).
- `pnpm test:live`: Kör leverantörers live-tester (minimax/zai). Kräver API-nycklar och `LIVE=1` (eller leverantörsspecifik `*_LIVE_TEST=1`) för att avmarkera som skip.

## Modellens latensbenchmark (lokala nycklar)

Skript: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Användning:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Valfria miljövariabler: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Standardprompt: ”Svara med ett enda ord: ok. Ingen interpunktion eller extra text.”

Senaste körning (2025-12-31, 20 körningar):

- minimax median 1279 ms (min 1114, max 2431)
- opus median 2454 ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker är valfritt; detta behövs endast för containeriserade onboarding-röktester.

Fullt kallstartsflöde i en ren Linux-container:

```bash
scripts/e2e/onboard-docker.sh
```

Detta skript driver den interaktiva guiden via en pseudo-tty, verifierar konfig-/arbetsyt-/sessionsfiler, startar sedan gateway och kör `openclaw health`.

## QR-import röktest (Docker)

Säkerställer att `qrcode-terminal` laddas under Node 22+ i Docker:

```bash
pnpm test:docker:qr
```
