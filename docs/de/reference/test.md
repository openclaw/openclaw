---
summary: "„Wie Sie Tests lokal ausführen (Vitest) und wann Sie die Modi force/coverage verwenden“"
read_when:
  - Beim Ausführen oder Beheben von Tests
title: "Tests"
---

# Tests

- Vollständiges Test-Kit (Suites, Live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Beendet alle verbliebenen Gateway-Prozesse, die den Standard-Steuerport belegen, und führt anschließend die vollständige Vitest-Suite mit einem isolierten Gateway-Port aus, sodass Servertests nicht mit einer laufenden Instanz kollidieren. Verwenden Sie dies, wenn ein vorheriger Gateway-Lauf den Port 18789 belegt hat.

- `pnpm test:coverage`: Führt Vitest mit V8-Coverage aus. Globale Schwellenwerte sind 70 % für Zeilen/Branches/Funktionen/Statements. Die Coverage schließt integrationslastige Entry-Points (CLI-Verdrahtung, Gateway/Telegram-Bridges, Webchat-Static-Server) aus, um den Fokus auf unit-testbare Logik zu legen.

- `pnpm test:e2e`: Führt Gateway-End-to-End-Smoke-Tests aus (Multi-Instance WS/HTTP/Node-Pairing).

- `pnpm test:live`: Führt Provider-Live-Tests (minimax/zai) aus. Erfordert API-Schlüssel und `LIVE=1` (oder anbieter­spezifisch `*_LIVE_TEST=1`), um das Überspringen aufzuheben.

## Modell-Latenz-Benchmark (lokale Schlüssel)

Skript: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Verwendung:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optionale Umgebungsvariablen: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Standard-Prompt: „Antworten Sie mit einem einzigen Wort: ok. Keine Satzzeichen oder zusätzlichen Text.“

Letzter Lauf (2025-12-31, 20 Läufe):

- minimax Median 1279 ms (min 1114, max 2431)
- opus Median 2454 ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker ist optional; dies wird nur für containerisierte Onboarding-Smoke-Tests benötigt.

Vollständiger Cold-Start-Ablauf in einem sauberen Linux-Container:

```bash
scripts/e2e/onboard-docker.sh
```

Dieses Skript steuert den interaktiven Assistenten über ein Pseudo-TTY, verifiziert Konfigurations-/Workspace-/Sitzungsdateien, startet anschließend das Gateway und führt `openclaw health` aus.

## QR-Import-Smoke (Docker)

Stellt sicher, dass `qrcode-terminal` unter Node 22+ in Docker geladen wird:

```bash
pnpm test:docker:qr
```
