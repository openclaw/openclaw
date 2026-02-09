---
summary: "Hur du kör tester lokalt (vitest) och när du ska använda force-/coverage-lägen"
read_when:
  - När du kör eller åtgärdar tester
title: "Tester"
---

# Tester

- Fullständigt testpaket (sviter, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Dödar varje kvardröjande gateway-process som håller den förvalda kontrollporten, kör sedan hela Vitest-sviten med en isolerad gateway-port så att servertester inte kolliderar med en körande instans. Använd detta när en tidigare gateway kör vänster port 18789 ockuperad.

- \`pnpm test: täckning: Kör Vitest med V8 täckning. Globala tröskelvärden är 70% linjer/grenar/funktioner/uttalanden. Täckning utesluter integration-tunga ingångspunkter (CLI-ledningar, gateway/telegram broar, webchat statisk server) för att hålla målet fokuserat på enhetstestbar logik.

- `pnpm test:e2e`: Kör gateway end-to-end-röktester (parning av flera instanser via WS/HTTP/node).

- `pnpm test: live`: Kör leverantör live-tester (minimax/zai). Kräver API-nycklar och `LIVE=1` (eller leverantörsspecifik `*_LIVE_TEST=1`) för att avhoppa.

## Modellens latensbenchmark (lokala nycklar)

Skript: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Användning:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Valfria miljövariabler: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Standardprompt: “Svara med ett enda ord: ok. Ingen skiljetecken eller extra text.”

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
