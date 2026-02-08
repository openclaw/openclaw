---
summary: "CLI-referens för `openclaw models` (status/list/set/scan, alias, fallbacks, autentisering)"
read_when:
  - Du vill ändra standardmodeller eller se status för leverantörsautentisering
  - Du vill skanna tillgängliga modeller/leverantörer och felsöka autentiseringsprofiler
title: "modeller"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:45Z
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

`openclaw models status` visar den upplösta standarden/fallbacks samt en autentiseringsöversikt.
När ögonblicksbilder av leverantörsanvändning finns tillgängliga innehåller avsnittet för OAuth/tokenstatus
rubriker för leverantörsanvändning.
Lägg till `--probe` för att köra live‑autentiseringsprober mot varje konfigurerad leverantörsprofil.
Prober är riktiga förfrågningar (kan förbruka tokens och utlösa hastighetsbegränsningar).
Använd `--agent <id>` för att inspektera en konfigurerad agents modell-/autentiseringsstatus. När detta utelämnas
använder kommandot `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` om angivet, annars den
konfigurerade standardagenten.

Noteringar:

- `models set <model-or-alias>` accepterar `provider/model` eller ett alias.
- Modellreferenser tolkas genom att dela på den **första** `/`. Om modell-ID:t innehåller `/` (OpenRouter‑stil), inkludera leverantörsprefixet (exempel: `openrouter/moonshotai/kimi-k2`).
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

`models auth login` kör en leverantörsplugins autentiseringsflöde (OAuth/API‑nyckel). Använd
`openclaw plugins list` för att se vilka leverantörer som är installerade.

Noteringar:

- `setup-token` frågar efter ett setup‑token‑värde (generera det med `claude setup-token` på valfri maskin).
- `paste-token` accepterar en tokensträng som genererats någon annanstans eller via automation.
