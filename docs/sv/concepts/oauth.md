---
summary: "OAuth i OpenClaw: tokenutbyte, lagring och mönster för flera konton"
read_when:
  - Du vill förstå OpenClaw OAuth från början till slut
  - Du stöter på problem med tokeninvalidering / utloggning
  - Du vill använda setup-token eller OAuth-autentiseringsflöden
  - Du vill ha flera konton eller profilroutning
title: "OAuth"
---

# OAuth

OpenClaw stöder “prenumerationsförfattar” via OAuth för leverantörer som erbjuder det (särskilt **OpenAI Codex (ChatGPT OAuth)**). För antropiska prenumerationer, använd **setup-token** flödet. Denna sida förklarar:

- hur OAuth **tokenutbyte** fungerar (PKCE)
- var token **lagras** (och varför)
- hur man hanterar **flera konton** (profiler + åsidosättningar per session)

OpenClaw stöder också **plugins för leverantörer** som skickar sina egna OAuth eller API‐key
flöden. Kör dem via:

```bash
openclaw models auth login --provider <id>
```

## Token-sänkan (varför den finns)

OAuth leverantörer ofta mint en **ny uppdatera token** under inloggning/uppdatera flöden. Vissa leverantörer (eller OAuth klienter) kan ogiltigförklara äldre uppdateringstoken när en ny utfärdas för samma användare/app.

Praktiskt symptom:

- du loggar in via OpenClaw _och_ via Claude Code / Codex CLI → en av dem blir senare slumpmässigt ”utloggad”

För att minska detta behandlar OpenClaw `auth-profiles.json` som en **token-sänka**:

- körningen läser autentiseringsuppgifter från **ett ställe**
- vi kan behålla flera profiler och routa dem deterministiskt

## Lagring (var token finns)

Hemligheter lagras **per agent**:

- Autentiseringsprofiler (OAuth + API‑nycklar): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtime-cache (hanteras automatiskt; redigera inte): `~/.openclaw/agents/<agentId>/agent/auth.json`

Äldre fil endast för import (stöds fortfarande, men är inte huvudlagringen):

- `~/.openclaw/credentials/oauth.json` (importeras till `auth-profiles.json` vid första användning)

Alla ovanstående respekterar också `$OPENCLAW_STATE_DIR` (state dir override). Fullständig referens: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (prenumerationsautentisering)

Kör `claude setup-token` på valfri maskin och klistra sedan in den i OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Om du genererade token någon annanstans, klistra in den manuellt:

```bash
openclaw models auth paste-token --provider anthropic
```

Verifiera:

```bash
openclaw models status
```

## OAuth-utbyte (hur inloggning fungerar)

OpenClaws interaktiva inloggningsflöden är implementerade i `@mariozechner/pi-ai` och kopplade till guiderna/kommandona.

### Anthropic (Claude Pro/Max) setup-token

Flödets form:

1. kör `claude setup-token`
2. klistra in token i OpenClaw
3. lagra som en token‑auth‑profil (ingen uppdatering)

Guidens väg är `openclaw onboard` → auth-val `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Flödets form (PKCE):

1. generera PKCE-verifierare/utmaning + slumpmässig `state`
2. öppna `https://auth.openai.com/oauth/authorize?...`
3. försök fånga callback på `http://127.0.0.1:1455/auth/callback`
4. om callback inte kan bindas (eller om du kör remote/headless), klistra in omdirigerings-URL:en/koden
5. utbyt vid `https://auth.openai.com/oauth/token`
6. extrahera `accountId` från åtkomsttoken och lagra `{ access, refresh, expires, accountId }`

Guidens väg är `openclaw onboard` → auth-val `openai-codex`.

## Uppdatering + utgång

Profiler lagrar en `expires`‑tidsstämpel.

Vid körning:

- om `expires` ligger i framtiden → använd den lagrade åtkomsttoken
- om den har gått ut → uppdatera (under fillås) och skriv över de lagrade autentiseringsuppgifterna

Uppdateringsflödet är automatiskt; du behöver i allmänhet inte hantera token manuellt.

## Flera konton (profiler) + routning

Två mönster:

### 1. Föredraget: separata agenter

Om du vill att ”privat” och ”arbete” aldrig ska interagera, använd isolerade agenter (separata sessioner + autentiseringsuppgifter + arbetsyta):

```bash
openclaw agents add work
openclaw agents add personal
```

Konfigurera sedan autentisering per agent (guide) och routa chattar till rätt agent.

### 2. Avancerat: flera profiler i en agent

`auth-profiles.json` stöder flera profil-ID:n för samma leverantör.

Välj vilken profil som används:

- globalt via konfigordning (`auth.order`)
- per session via `/model ...@<profileId>`

Exempel (åsidosättning per session):

- `/model Opus@anthropic:work`

Så ser du vilka profil-ID:n som finns:

- `openclaw channels list --json` (visar `auth[]`)

Relaterad dokumentation:

- [/concepts/model-failover](/concepts/model-failover) (rotations- + cooldown-regler)
- [/tools/slash-commands](/tools/slash-commands) (kommandoyta)
