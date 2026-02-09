---
summary: "CLI-referens för `openclaw models` (status/list/set/scan, alias, fallbacks, autentisering)"
read_when:
  - Du vill ändra standardmodeller eller se status för leverantörsautentisering
  - Du vill skanna tillgängliga modeller/leverantörer och felsöka autentiseringsprofiler
title: "modeller"
---

# `openclaw models`

Modellupptäckt, skanning och konfiguration (standardmodell, fallbacks, autentiseringsprofiler).

Relaterat:

- Leverantörer + modeller: [Models](/providers/models)
- Konfiguration av leverantörsautentisering: [Kom igång](/start/getting-started)

## Vanliga kommandon

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` visar den upplösta standard/fallbacks plus en auth översikt.
När det finns ögonblicksbilder för leverantörsanvändning finns OAuth/token status sektionen innehåller
leverantörens användningshuvuden.
Lägg till `--probe` för att köra live auth sonder mot varje konfigurerad leverantörsprofil.
Probes är verkliga förfrågningar (kan konsumera polletter och utlösa hastighetsbegränsningar).
Använd `--agent <id>` för att inspektera ett konfigurerat agentens modell/auth-tillstånd. När kommandot utelämnas,
använder kommandot `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` om satt, annars
konfigurerade standardagenten.

Noteringar:

- `models set <model-or-alias>` accepterar `provider/model` eller ett alias.
- Modellrefs tolkas genom att dela på **först** `/`. Om modell-ID innehåller `/` (OpenRouter-style), inkludera leverantörs-prefix (exempel: `openrouter/moonshotai/kimi-k2`).
- Om du utelämnar leverantören behandlar OpenClaw indata som ett alias eller en modell för **standardleverantören** (fungerar endast när det inte finns någon `/` i modell-ID:t).

### `models status`

Alternativ:

- `--json`
- `--plain`
- `--check` (avsluta 1=utgången/saknas, 2=snart utgående)
- `--probe` (live‑probe av konfigurerade autentiseringsprofiler)
- `--probe-provider <name>` (proba en leverantör)
- `--probe-profile <id>` (upprepa eller kommaseparerade profil-ID:n)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (konfigurerat agent-ID; åsidosätter `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Alias + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Autentiseringsprofiler

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` kör en leverantörs plugins auth flöde (OAuth/API-nyckel). Använd
`openclaw plugins list` för att se vilka leverantörer som är installerade.

Noteringar:

- `setup-token` frågar efter ett setup‑token‑värde (generera det med `claude setup-token` på valfri maskin).
- `paste-token` accepterar en tokensträng som genererats någon annanstans eller via automation.
